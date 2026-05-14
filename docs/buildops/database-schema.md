# BuildOps Integration — Database Schema & Sync

## Overview

All tables live in a single Supabase (PostgreSQL) project. Every data-bearing table carries `tenant_id` so the schema is multi-tenant. BuildOps UUIDs are stored as-is in `TEXT` columns alongside our own Postgres-generated `UUID` primary keys.

**Migration file:**
- `migrations/buildops/20260512_001_buildops_core_tables.sql` — full current-state schema (idempotent, safe to re-run)

---

## Tables

### `buildops_tenants`

One row per HVAC company we serve. Looked up by inbound E.164 phone number at the start of every Retell call to resolve credentials and the BuildOps tenant context.

| Column | Type | Constraints | Purpose |
|---|---|---|---|
| `no` | TEXT | PRIMARY KEY | E.164 Retell phone line for this tenant (e.g. `+13014507341`). Looked up at call start via `WHERE no = <dialed_number>`. |
| `client_id` | TEXT | NOT NULL | BuildOps OAuth client ID. |
| `client_secret` | TEXT | NOT NULL | BuildOps OAuth client secret. Never logged. |
| `access_token` | TEXT | NOT NULL | Current Bearer token. Refreshed at the start of every cron run. |
| `buildops_tenant_id` | TEXT | NOT NULL | BuildOps internal tenant UUID. Sent as the `tenantId` header on every API call. |

---

### `buildops_customers`

Local mirror of BuildOps customers. Primary lookup table for inbound calls — queried by phone, name, and address during customer identification.

| Column | Type | Constraints | Purpose |
|---|---|---|---|
| `id` | UUID | PRIMARY KEY | Our internal customer identifier. Referenced by `buildops_inbound_calls.matched_customer_id`. |
| `tenant_id` | TEXT | NOT NULL | BuildOps tenant UUID. Scopes the row to one HVAC company. |
| `buildops_customer_id` | TEXT | UNIQUE | The BuildOps-assigned customer UUID. Used in all BuildOps API calls. Also the FK target for `buildops_properties` and `buildops_representatives`. |
| `name` | TEXT | NOT NULL | Company/customer display name. Used in fuzzy name matching. |
| `phone_primary` | TEXT | | Raw primary phone from BuildOps. |
| `phone_secondary` | TEXT | | Raw alternate phone from BuildOps. |
| `is_active` | BOOLEAN | NOT NULL DEFAULT true | Inactive customers are excluded from lookup. |
| `account_number` | TEXT | | BuildOps accountNumber. |
| `customer_type` | TEXT | | BuildOps customerType. |
| `status` | TEXT | | Account status (e.g. `active`, `creditHold`, `suspended`, `collections`). Checked in `handlePrepareJob` to block job creation for bad-standing accounts. |
| `email` | TEXT | | |
| `customer_number` | TEXT | | BuildOps customerNumber. |
| `price_book_id` | TEXT | | BuildOps priceBookId. Copied onto every job created for this customer. |
| `version` | INTEGER | | BuildOps optimistic lock version. Used in incremental dirty detection. |
| `buildops_last_updated_at` | BIGINT | | `audit.lastUpdatedDateTime` (unix ms). Per-row watermark — the primary incremental-sync trigger for customer + rep + property dirty detection. |
| `buildops_created_at` | BIGINT | | `audit.createdDateTime` (unix ms). |
| `all_numbers` | TEXT[] | GIN INDEX | Deduplicated array of every phone number associated with this customer, normalized to last 10 digits. Sources: customer primary/alternate, all rep cell/landline numbers, all property phone numbers. Queried with `.contains()` for O(1) exact-phone lookup. |
| `all_numbers_sources` | TEXT[] | | Parallel to `all_numbers`. Each element names the origin (e.g. `customer:phonePrimary`, `rep:cellPhone:JohnSmith`, `property:phonePrimary:<uuid>`). |
| `property_ids` | TEXT[] | NOT NULL DEFAULT '{}' | BuildOps property UUIDs belonging to this customer. Kept in sync by the cron — use to join against `buildops_properties.id`. |
| `representative_ids` | UUID[] | NOT NULL DEFAULT '{}' | Our `buildops_representatives.id` UUIDs for this customer. Populated after each rep upsert batch by querying back the auto-assigned UUIDs. |
| `billing_address` | TEXT | | Formatted address string from `addresses[addressType=billingAddress]`, e.g. `"123 Main St, Richmond, VA 23219"`. |
| `business_address` | TEXT | | Formatted address string from the primary service address (first non-billing address, or first address if none). |

**Unique constraints:**
- `(tenant_id, buildops_customer_id)` — composite key for upserts
- `(buildops_customer_id)` — required as FK target for child tables

**Indexes:**
- GIN on `all_numbers` — required for `contains` array queries
- B-tree on `(tenant_id, buildops_customer_id)` — fast upsert
- B-tree on `tenant_id` — scopes nearly every query

---

### `buildops_properties`

Local mirror of BuildOps service locations. One customer → many properties.

| Column | Type | Constraints | Purpose |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | BuildOps property UUID. |
| `name` | TEXT | | Property display name. |
| `phone_primary` | TEXT | | Property-level contact phone. Contributes to the parent customer's `all_numbers`. |
| `customer_id` | TEXT | NOT NULL, FK → `buildops_customers(buildops_customer_id)` ON DELETE CASCADE | The BuildOps customer UUID this property belongs to. |
| `address` | JSONB | NOT NULL | Service address: `{line1, line2, city, state, zip}`. |

**Indexes:**
- B-tree on `customer_id`
- GIN on `address`

---

### `buildops_representatives`

Local mirror of BuildOps customer representatives (contacts). Phone numbers are pre-indexed into the parent customer's `all_numbers` column so no live API call is needed during a call.

| Column | Type | Constraints | Purpose |
|---|---|---|---|
| `id` | UUID | PRIMARY KEY DEFAULT gen_random_uuid() | Our internal rep UUID. Stored in `buildops_customers.representative_ids`. |
| `tenant_id` | TEXT | NOT NULL | Tenant scope. |
| `customer_id` | TEXT | NOT NULL, FK → `buildops_customers(buildops_customer_id)` ON DELETE CASCADE | Parent customer's BuildOps UUID. |
| `property_id` | TEXT | NOT NULL | BuildOps property UUID this rep is associated with. |
| `first_name` | TEXT | NOT NULL | |
| `last_name` | TEXT | NOT NULL | |
| `cell_phone` | TEXT | | Raw cell phone string from BuildOps. |
| `landline_phone` | TEXT | | Raw landline phone string. |
| `normalized_cell_phone` | TEXT | | Last 10 digits of `cell_phone`. |
| `normalized_landline_phone` | TEXT | | Last 10 digits of `landline_phone`. |
| `email` | TEXT | | |
| `is_active` | BOOLEAN | DEFAULT true | |
| `is_do_not_call` | BOOLEAN | DEFAULT false | |
| `is_email_opt_out` | BOOLEAN | DEFAULT false | |
| `is_sms_opt_out` | BOOLEAN | DEFAULT false | |
| `created_at` | TIMESTAMPTZ | | From BuildOps audit data. |
| `updated_at` | TIMESTAMPTZ | | From BuildOps audit data. Compared against `buildops_customers.buildops_last_updated_at` to detect rep-driven customer dirtiness. |
| `version` | INTEGER | DEFAULT 0 | BuildOps optimistic lock version. |

**Indexes:**
- B-tree on `(tenant_id, customer_id)`
- B-tree on `(normalized_cell_phone, normalized_landline_phone)`

---

### `buildops_inbound_calls`

One row per Retell call. Created at `call_started`/`call_inbound`, updated throughout the call lifecycle.

| Column | Type | Constraints | Purpose |
|---|---|---|---|
| `id` | UUID | PRIMARY KEY | Internal row ID. |
| `retell_call_id` | TEXT | NOT NULL, UNIQUE | Retell's call identifier. Session key throughout the call. |
| `tenant_id` | TEXT | NOT NULL | Resolved from `buildops_tenants` at call start via the dialed number. |
| `caller` | TEXT | | E.164 caller number. Used for exact-phone customer lookup and new-number detection. |
| `matched_customer_id` | TEXT | | `buildops_customers.id` (our UUID) — set once the customer is identified. NULL until identification succeeds. |
| `status` | TEXT | NOT NULL DEFAULT 'active' | `active` → `ended` (normal end) or `handed_off` (transferred to human). |
| `buildops_job_id` | TEXT | | BuildOps job UUID — set immediately when `prepare_job` completes (not deferred to call end). |

---

### `buildops_jobs`

Mirror of every job created through or synced from BuildOps. Jobs are written immediately during the call when `prepare_job` fires. The 5-minute cron then keeps the table in sync with any changes made directly in BuildOps (status updates, cancellations, etc.).

| Column | Type | Constraints | Purpose |
|---|---|---|---|
| `id` | UUID | PRIMARY KEY | Internal row ID. |
| `tenant_id` | TEXT | NOT NULL | |
| `job_id` | TEXT | NOT NULL | BuildOps job UUID. |
| `job_number` | TEXT | | Human-readable job number (e.g. `JOB-00123`). |
| `status` | TEXT | | `Open` \| `In Progress` \| `On Hold` \| `Canceled` \| `Complete` |
| `customer_property_id` | TEXT | | BuildOps property UUID. |
| `customer_name` | TEXT | | Denormalized at creation time. |
| `customer_id` | TEXT | | BuildOps customer UUID. |
| `job_type_id` | TEXT | | BuildOps job type UUID. |
| `job_type_name` | TEXT | | |
| `price_book_id` | TEXT | | |
| `priority` | TEXT | | |
| `version` | INTEGER | DEFAULT 0 | BuildOps optimistic lock version. |
| `billing_status` | TEXT | | |
| `review_status` | TEXT | | |
| `billing_type` | TEXT | | |
| `amount_quoted` | DECIMAL | | |
| `is_use_taxable` | BOOLEAN | DEFAULT false | |
| `departments` | JSONB | DEFAULT '[]' | `[{id, name}]` from BuildOps response. |
| `due_date` | TEXT | | |
| `is_flagged` | BOOLEAN | DEFAULT false | |
| `audit` | JSONB | | Raw BuildOps audit block. |
| `created_at` | BIGINT | | `audit.createdDateTime` (unix ms). |
| `last_updated_at` | BIGINT | | `audit.lastUpdatedDateTime` (unix ms). **Sync watermark** — `MAX(last_updated_at)` per tenant is used by the cron to compute the `lastUpdatedDateStart` query parameter for the next incremental fetch. |
| `issue_description` | TEXT | | |
| `customer_provided_job_number` | TEXT | | |
| `customer_provided_po_number` | TEXT | | |
| `billing_customer_id` | TEXT | | |
| `billing_customer_name` | TEXT | | |
| `invoice_status` | TEXT | | |
| `service_agreement_id` | TEXT | | |
| `completed_date` | BIGINT | | Unix ms when job was completed. |
| `is_deleted` | BOOLEAN | NOT NULL DEFAULT false | `true` when `audit.deletedDateTime` is set in the API response. Soft-delete — rows are never physically removed. Filter `WHERE is_deleted = false` for active jobs. |
| UNIQUE | | `(tenant_id, job_id)` | Prevents duplicate rows on re-upsert. |

**Indexes:**
- B-tree on `(tenant_id, last_updated_at)` — watermark query + range scans

---

### `buildops_departments`

Local copy of BuildOps departments. **Not queried during live calls** — the department is resolved from the hardcoded constant `DEFAULT_DEPARTMENT_ID` in `src/services/buildops/handlers/job.ts`.

| Column | Type | Purpose |
|---|---|---|
| `id` | TEXT PRIMARY KEY | BuildOps department UUID. |
| `tag_name` | TEXT NOT NULL | Human-readable label. |
| `tenant_id` | TEXT NOT NULL | |
| `phone_primary` | TEXT | |
| `email` | TEXT | |
| `is_active` | BOOLEAN DEFAULT true | |

---

## Sync Architecture

All sync runs in a single Deno edge function deployed to Supabase: `src/services/buildops/supabase/buildops-cron/index.ts`.  
The function is triggered by pg_cron via `net.http_post` to `supabase.co/functions/v1/buildops_cron`.  
See [`docs/buildops/sync.md`](sync.md) for the full sync architecture.

For each tenant it does two things **in parallel**:
1. Customer/property/rep sync (`fullSeed` or `incrementalSync`)
2. Jobs incremental sync (`jobsSync`)

---

### A. Customer / Property / Representative Sync

#### Full Seed (first run — `buildops_customers` is empty)

1. Fetch all properties (paginated, 100/page, `include_addresses=true`) → upsert `buildops_properties` → build `propMap` and `propPhoneMap` in memory.
2. Fetch all customers (paginated, 100/page, `include_inactive=true`).
3. Fetch all reps in parallel batches of 15 concurrent `GET /v1/customers/{id}/our-representatives` calls.
4. For each customer:
   - Build `all_numbers` + `all_numbers_sources` (customer phones → rep phones → property phones, deduplicated, first source wins).
   - Extract `billing_address` from `addresses[addressType=billingAddress]`; `business_address` from the first non-billing address.
   - Set `property_ids` to the IDs of all properties in `propMap` for this customer.
5. Upsert `buildops_customers` (conflict on `tenant_id, buildops_customer_id`).
6. Delete all existing reps for the tenant, then insert fresh rep rows into `buildops_representatives`.
7. Query back `(id, customer_id)` from `buildops_representatives` and write the auto-assigned UUIDs into `buildops_customers.representative_ids`.

#### Incremental Sync (subsequent runs)

**Dirty detection — three independent sources evaluated before the customer loop:**

| Source | Trigger | Action |
|---|---|---|
| Customer timestamp | `customer.audit.lastUpdatedDateTime > buildops_customers.buildops_last_updated_at` | Mark customer dirty |
| Customer version | `customer.version > buildops_customers.version` | Mark customer dirty |
| Property change | `property.audit.lastUpdatedDateTime > parent_customer.buildops_last_updated_at` | Mark parent customer dirty |
| Rep change | `buildops_representatives.updated_at > parent_customer.buildops_last_updated_at` (queried from DB) | Mark parent customer dirty |
| New customer | No existing row in `buildops_customers` | Always rebuild |

**Steps:**
1. Load `(buildops_customer_id, buildops_last_updated_at, version)` for all existing rows of this tenant → build `dbCustomerMap`.
2. Fetch all properties → upsert `buildops_properties`, delete any properties no longer in the API response.
3. Query `buildops_representatives` for all `(customer_id, updated_at)` to detect rep-driven dirty customers.
4. Page through all customers (100/page): skip clean ones, fetch fresh reps only for dirty ones.
5. Upsert dirty customer rows.
6. For each dirty customer: delete its old rep rows, insert fresh rows, then update `representative_ids` on the customer.

**Outcome:** Only changed customers (and their reps) are re-fetched from BuildOps. Clean customers are skipped entirely.

---

### B. Jobs Incremental Sync (`jobsSync`)

Runs every cron cycle for every tenant, in parallel with the customer sync.

**Watermark strategy:**
```
watermark = SELECT MAX(last_updated_at) FROM buildops_jobs WHERE tenant_id = ?
```
On first run the table is empty → watermark is `0` (epoch) → fetches all jobs. On subsequent runs only jobs updated since the last highest `last_updated_at` are fetched.

**Steps:**
1. Compute watermark from `MAX(last_updated_at)`.
2. Call `GET /v1/jobs?lastUpdatedDateStart=<watermark-as-ISO>&page_size=100` (paginated until empty page).
3. For each job in the API response, map to a `buildops_jobs` row:
   - `created_at` ← `audit.createdDateTime`
   - `last_updated_at` ← `audit.lastUpdatedDateTime`
   - `is_deleted` ← `audit.deletedDateTime != null` (BuildOps soft-deletes via this field, not via a status change)
4. Upsert all rows on conflict `(tenant_id, job_id)` — overwrites every field including `status`, `is_deleted`, etc.
5. Return `{ synced: N, watermark: newMax }`.

**Coverage:**
| Event | How it reaches Supabase |
|---|---|
| Job created via Retell call | Written immediately during `prepare_job` before Retell gets a response |
| Job created manually in BuildOps | Picked up on the next cron run (≤5 min lag) |
| Job status updated in BuildOps | `last_updated_at` advances → picked up on next cron run |
| Job soft-deleted in BuildOps | `audit.deletedDateTime` is set → `is_deleted = true` on next cron run |

---

## Hardcoded Defaults (job creation)

Resolved server-side from constants in `src/services/buildops/handlers/job.ts`:

| Constant | Value | Meaning |
|---|---|---|
| `DEFAULT_JOB_TYPE_ID` | `04df1a40-16b1-43f4-aa9b-8eafcec812ad` | BuildOps job type "Time & Material" |
| `DEFAULT_DEPARTMENT_ID` | `d87c1a38-4acd-459f-9b3f-446a810fae10` | "D2 Service Calls (T&M)" department |

To look up or verify the department ID: `npx tsx scripts/get_department_id.ts`.
