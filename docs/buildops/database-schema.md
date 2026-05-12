# BuildOps Integration — Database Schema & Sync Jobs

## Overview

All tables live in a single Supabase (PostgreSQL) project. Every data-bearing table carries `tenant_id` so the schema is multi-tenant from the start. BuildOps UUIDs are stored as-is in `TEXT` columns alongside our own `UUID` primary keys so that we can always round-trip back to BuildOps without a lookup table.

---

## Tables

### `buildops_tenants`

Holds one row per customer of ours (i.e. per HVAC company). Looked up by inbound E.164 phone number at the very start of every Retell call to resolve credentials and the BuildOps tenant context.

| Column | Type | Constraints | Purpose |
|---|---|---|---|
| `no` | TEXT | PRIMARY KEY | E.164 number of the phone line Retell rings (e.g. `+18041234567`). Used as the lookup key when a call arrives. |
| `client_id` | TEXT | NOT NULL | BuildOps OAuth client ID for this tenant. |
| `client_secret` | TEXT | NOT NULL | BuildOps OAuth client secret. Stored here; never logged. |
| `access_token` | TEXT | NOT NULL | Current short-lived Bearer token. Refreshed by the auth cron. |
| `buildops_tenant_id` | TEXT | NOT NULL | BuildOps internal tenant UUID. Sent as the `tenantId` header on every API call. |

---

### `customers`

Local mirror of BuildOps customers. The primary lookup table for inbound calls — queried by phone, name, address, and zip during customer identification.

| Column | Type | Constraints | Purpose |
|---|---|---|---|
| `id` | UUID | PRIMARY KEY DEFAULT gen_random_uuid() | Our internal customer identifier. Referenced by `inbound_calls.matched_customer_id` and `representatives.customer_id`. |
| `tenant_id` | UUID | NOT NULL, FK → buildops_tenants.no (or UUID equivalent) | Scopes the row to one HVAC company. |
| `buildops_customer_id` | TEXT | NOT NULL, UNIQUE per tenant | The BuildOps-assigned customer UUID. Used in all BuildOps API calls. |
| `name` | TEXT | NOT NULL | Company / customer display name. Used in fuzzy name matching. |
| `phone_primary` | TEXT | | Raw primary phone from BuildOps (may include formatting). |
| `phone_secondary` | TEXT | | Raw secondary / alternate phone from BuildOps. |
| `is_active` | BOOLEAN | NOT NULL DEFAULT true | Inactive customers are excluded from lookup. |
| `addresses` | JSONB | | Array of billing/shipping address objects: `{line1, line2, city, state, zip}`. Used in fuzzy address matching. |
| `normalized_phone_primary` | TEXT | | Last 10 digits of `phone_primary`. Used in OR-match queries alongside `all_numbers`. |
| `normalized_phone_secondary` | TEXT | | Last 10 digits of `phone_secondary`. |
| `price_book_id` | TEXT | | BuildOps priceBookId for this customer. Copied onto every job created for this customer. |
| `all_numbers` | TEXT[] | GIN INDEX | Deduplicated array of every phone number associated with this customer, normalized to last 10 digits. Sources include: customer primary/alternate, all representative cell and landline numbers, and all property phone numbers. Queried with `.contains()` for O(1) exact-phone lookup. |
| `all_numbers_sources` | TEXT[] | | Parallel to `all_numbers`. Each element names the origin of the corresponding number (e.g. `customer:phonePrimary`, `rep:cellPhone:JohnSmith1`, `property:phonePrimary:abc-uuid`). Used to show which source a matched number came from and to avoid duplicates on re-sync. |
| `account_number` | TEXT | | BuildOps accountNumber. |
| `customer_type` | TEXT | | BuildOps customerType. |
| `status` | TEXT | | Account status from BuildOps (e.g. `active`, `inactive`, `creditHold`, `suspended`, `collections`). Used by `handlePrepareJob` to block job creation for bad-standing accounts. |
| `email` | TEXT | | Customer email. |
| `customer_number` | TEXT | | BuildOps customerNumber. |
| `credit_limit` | DECIMAL | | |
| `is_taxable` | BOOLEAN | | |
| `tax_rate_value` | DECIMAL | | |
| `receive_sms` | BOOLEAN | | |
| `invoice_delivery_pref` | TEXT | | |
| `payment_term_id` | TEXT | | BuildOps UUID. |
| `invoice_preset_id` | TEXT | | BuildOps UUID. |
| `logo_url` | TEXT | | |
| `website_url` | TEXT | | |
| `version` | INTEGER | | BuildOps optimistic lock version. |
| `amount_not_to_exceed` | DECIMAL | | |
| `buildops_last_updated_at` | BIGINT | | `audit.lastUpdatedDateTime` (unix ms) — primary incremental-sync trigger. Compared per-row to detect changed customers without a full re-fetch. |
| `buildops_created_at` | BIGINT | | `audit.createdDateTime` (unix ms). |
| `representatives` | JSONB | | Embedded array of all representatives for this customer: `[{id, firstName, lastName, cellPhone, landlinePhone, email, propertyId, isActive, isDoNotCall, version}]`. Updated on every dirty-customer rebuild. |
| `properties` | JSONB | | Embedded array of all properties for this customer: `[{id, companyName, phonePrimary, phoneAlternate, priceBookId, isTaxable, version, addresses:[{addressLine1, addressLine2, city, state, zipcode, addressType}]}]`. Updated on every dirty-customer rebuild. |

**Recommended indexes:**
- GIN on `all_numbers` — required for `contains` array queries
- B-tree on `(tenant_id, buildops_customer_id)` — unique constraint + fast upsert
- B-tree on `tenant_id` — scopes nearly every query
- GIN on `addresses` — required for JSON `cs` (contains-all) queries filtering by zip

---

### `property`

Local mirror of BuildOps service locations (properties). One customer can have many properties. Used during job creation to validate that the chosen property belongs to the confirmed customer.

| Column | Type | Constraints | Purpose |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | BuildOps property UUID. |
| `name` | TEXT | | Property display name (often the location nickname). |
| `phone_primary` | TEXT | | Property-level contact phone. Contributes to the parent customer's `all_numbers`. |
| `customer_id` | TEXT | NOT NULL | References our `customers.id`. Used to verify ownership during job preparation. |
| `address` | JSONB | NOT NULL | Service address: `{line1, line2, city, state, zip}`. Used in address fuzzy-matching during customer identification and shown to the agent during job confirmation. |

**Recommended indexes:**
- B-tree on `customer_id` — most common filter
- GIN on `address` — supports `address->>'line1' ILIKE` queries used in fuzzy candidate search

---

### `representatives`

Local mirror of BuildOps customer representatives (contacts). Stored so that representative phone numbers can be pre-indexed into `customers.all_numbers` without a live API call during a call.

| Column | Type | Constraints | Purpose |
|---|---|---|---|
| `id` | UUID | PRIMARY KEY DEFAULT gen_random_uuid() | Our internal rep identifier. |
| `tenant_id` | UUID | NOT NULL | Tenant scope. |
| `customer_id` | TEXT | NOT NULL | References our `customers.id`. |
| `property_id` | TEXT | NOT NULL | BuildOps property UUID this rep is associated with. |
| `first_name` | TEXT | NOT NULL | First name. Combined with `last_name` for name-collision suffix generation (`JohnSmith1`, `JohnSmith2`). |
| `last_name` | TEXT | NOT NULL | Last name. |
| `cell_phone` | TEXT | | Raw cell phone string from BuildOps. |
| `landline_phone` | TEXT | | Raw landline phone string from BuildOps. |
| `normalized_cell_phone` | TEXT | | Last 10 digits of `cell_phone`. Used in OR-queries. |
| `normalized_landline_phone` | TEXT | | Last 10 digits of `landline_phone`. |
| `email` | TEXT | | Contact email. |
| `is_active` | BOOLEAN | DEFAULT true | Inactive reps are excluded from sync output. |
| `is_do_not_call` | BOOLEAN | DEFAULT false | DNC flag from BuildOps. |
| `is_email_opt_out` | BOOLEAN | DEFAULT false | |
| `is_sms_opt_out` | BOOLEAN | DEFAULT false | |
| `created_at` | TIMESTAMPTZ | | From BuildOps audit data. |
| `updated_at` | TIMESTAMPTZ | | From BuildOps audit data. Used for incremental sync. |
| `version` | INTEGER | DEFAULT 0 | BuildOps optimistic lock version. Used to skip unchanged records in incremental sync. |

**Recommended indexes:**
- B-tree on `(tenant_id, customer_id)`
- B-tree on `(normalized_cell_phone, normalized_landline_phone)` — direct phone lookup fallback

---

### `inbound_calls`

One row per Retell call. Created when the call starts (`call_started` webhook) and updated throughout the call lifecycle. Holds the full session state including any pending jobs queued during the call.

| Column | Type | Constraints | Purpose |
|---|---|---|---|
| `id` | UUID | PRIMARY KEY DEFAULT gen_random_uuid() | Internal row ID. |
| `retell_call_id` | TEXT | NOT NULL, UNIQUE | Retell's call identifier. Used as the session key throughout the call. |
| `tenant_id` | UUID | NOT NULL | Resolved from the dialed number at call start. |
| `caller` | TEXT | | E.164 number of the caller. Used for exact-phone customer lookup and new-number detection. |
| `receiver` | TEXT | NOT NULL | E.164 number that was dialed (the tenant's phone line). |
| `matched_customer_id` | TEXT | | Our `customers.id` — set once the customer is identified during the call. NULL until identification succeeds. |
| `status` | TEXT | NOT NULL DEFAULT 'active' | Call lifecycle state. Values: `active` → `job_created` (after `call_ended` processes the job) or `handed_off` (transferred to human) or `ended`. |
| `buildops_job_id` | TEXT | | BuildOps job UUID — set after `executeJobCreation` completes post-call. |
| `pending_jobs` | JSONB | NOT NULL DEFAULT '[]' | Array of `PendingJobData` objects collected during the call. Each element contains all the data needed to call `POST /v1/jobs` after the call ends. Schema: `{customerPropertyId, jobTypeId, priceBookId, isUseTaxable, status, propertyAddress?, needsReview?, departmentId?, tasks[]}`. `jobTypeId` and `departmentId` are populated server-side from hardcoded defaults — not from the agent. Populated via `append_pending_job`. |

---

### `jobs`

Local mirror of every job created through the integration. Used for audit, reporting, and future webhook reconciliation.

| Column | Type | Constraints | Purpose |
|---|---|---|---|
| `id` | UUID | PRIMARY KEY DEFAULT gen_random_uuid() | |
| `job_id` | TEXT | NOT NULL | BuildOps job UUID returned by `POST /v1/jobs`. |
| `job_number` | TEXT | | Human-readable BuildOps job number (e.g. `JOB-00123`). |
| `status` | TEXT | | Job status at creation time (`Open`, `In Progress`, etc.). |
| `customer_property_id` | TEXT | | BuildOps property UUID the job was created against. |
| `customer_name` | TEXT | | Denormalized customer name at job creation time. |
| `customer_id` | TEXT | | BuildOps customer UUID. |
| `job_type_id` | TEXT | | BuildOps job type UUID. |
| `job_type_name` | TEXT | | Display name of the job type. Not populated by our handler (NULL); present for future use if the BuildOps API response is mapped here. |
| `price_book_id` | TEXT | | Price book UUID used for the job. Sourced from `customers.price_book_id`. |
| `priority` | TEXT | | Job priority level if set. |
| `version` | INTEGER | DEFAULT 0 | BuildOps optimistic lock version. |
| `billing_status` | TEXT | | From BuildOps job response. |
| `review_status` | TEXT | | From BuildOps job response. |
| `billing_type` | TEXT | | |
| `amount_quoted` | DECIMAL | | |
| `is_use_taxable` | BOOLEAN | DEFAULT false | Whether the job is subject to use tax. Copied from customer's tax configuration. |
| `departments` | JSONB | DEFAULT '[]' | Array of `{id, name}` objects from BuildOps response. |
| `due_date` | TEXT | | |
| `is_flagged` | BOOLEAN | DEFAULT false | Flagged for manual attention. |
| `tenant_id` | UUID | NOT NULL | |
| `audit` | JSONB | | Raw BuildOps audit block (`{createdDate, lastUpdatedDate}`). |
| UNIQUE | | `(tenant_id, job_id)` | Prevents duplicate rows if `call_ended` fires more than once. |

---

### `departments`

Local copy of BuildOps departments. Synced separately. **Not queried during live calls** — the department attached to every created job is resolved from the hardcoded constant `DEFAULT_DEPARTMENT_ID` in `src/services/buildops/handlers/job.ts` ("D2 Service Calls (T&M)", ID `d87c1a38-4acd-459f-9b3f-446a810fae10`). Run `scripts/get_department_id.ts` if the ID ever needs to be updated.

| Column | Type | Constraints | Purpose |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | BuildOps department UUID. |
| `tag_name` | TEXT | NOT NULL | Human-readable department label. |
| `tenant_id` | UUID | NOT NULL | |
| `phone_primary` | TEXT | | Department contact number. |
| `email` | TEXT | | |
| `is_active` | BOOLEAN | DEFAULT true | |

---

---

## Sync Jobs

These jobs keep the local Supabase tables and `customers.csv` in sync with BuildOps. They run on a schedule and do not affect live call handling directly — the call path reads only from Supabase.

---

### 1. Full Customer Sync (`scripts/buildops/cron/full-sync.ts`)

**Purpose:** Populate (or fully rebuild) `customers.csv` with every customer from BuildOps, including embedded representatives and properties. Run this first before any incremental sync.

**Trigger:** Manual first run; daily at off-peak hours.

**Steps:**
1. Authenticate with BuildOps via `POST /v1/auth/token`; obtain access token.
2. Fetch all properties (paginated, 100/page, `include_addresses=true`) — build `propMap` (`customerId → PropertySummary[]`) and `propPhoneMap` (`customerId → PhoneEntry[]`).
3. Fetch all customers (paginated, 100/page, `include_inactive=true`).
4. For every customer:
   - Fetch all representatives via `GET /v1/customers/{id}/our-representatives` (paginated, 100/page).
   - Build `all_numbers` + `all_numbers_sources` (customer phones → rep phones → property phones, deduplicated, first source wins).
   - Build `addresses_all` from `customer.addresses.items`.
   - Set `representatives` JSON from fetched reps.
   - Set `properties` JSON from `propMap`.
   - Set `last_updated` from `audit.lastUpdatedDateTime`; `last_added` from `audit.createdDateTime`.
5. Write `scripts/buildops/output/customers.csv`.
6. Write `sync_state.json` with `lastSyncedMs = max(last_updated across all customers)`.

---

### 2. Incremental Customer Sync (`scripts/buildops/cron/incremental-sync.ts`)

**Purpose:** Re-build only changed customers. Intended to run every 15–30 minutes.

**Trigger:** Scheduled cron (15–30 min interval). Requires `customers.csv` to exist (run full sync first).

**Dirty detection — three independent sources, all evaluated before the customer loop:**

| Source | Trigger condition | Action |
|---|---|---|
| Customer timestamp | `customer.audit.lastUpdatedDateTime > existing_row.last_updated` | Mark customer dirty |
| Property change | `property.audit.lastUpdatedDateTime > existingCustomerRow.last_updated` | Mark parent customer dirty |
| Representative change | `SELECT DISTINCT customer_id FROM representatives WHERE updated_at > lastSyncedMs` | Mark those customers dirty |

**Steps:**
1. Authenticate + init Supabase client.
2. Load `customers.csv` → `existingRows` map; compute `lastSyncedMs = min(last_updated across all rows)`.
3. Batch-query Supabase `representatives` for rows with `updated_at > lastSyncedMs` → add their `customer_id` to `dirtySet`.
4. Fetch all properties (100/page, `include_addresses=true`) → build `propMap` + `propPhoneMap`; property-dirty customers added to `dirtySet`.
5. Fetch all customers (100/page) — early-stop when a full page has all `lastUpdatedDateTime <= lastSyncedMs`.
6. For each fetched customer: if dirty (by timestamp or in `dirtySet`) → fetch fresh reps, rebuild row; otherwise reuse existing row.
7. For `dirtySet` customers not reached due to early-stop: re-fetch reps only and rebuild from existing CSV row.
8. Write updated `customers.csv`; write `sync_state.json`.

---

### 3. Access Token Refresh

**Purpose:** BuildOps access tokens have a limited TTL. This job exchanges the stored `client_id` + `client_secret` for a fresh token and writes it back to `buildops_tenants.access_token`.

**Trigger:** Every 50–55 minutes (before token expiry; exact interval depends on BuildOps TTL).

**Steps:**
1. For each row in `buildops_tenants` where `is_active = true`:
   - `POST /v1/auth/token` with `{clientId, clientSecret, tenantId}`.
   - Update `access_token` in the row.
2. Log result; alert on failure (a stale token blocks all live calls for that tenant).

---

## Hardcoded Defaults (job creation)

Two values are resolved server-side at job creation time from constants in `src/services/buildops/handlers/job.ts` rather than from environment variables or agent input:

| Constant | Value | Meaning |
|---|---|---|
| `DEFAULT_JOB_TYPE_ID` | `04df1a40-16b1-43f4-aa9b-8eafcec812ad` | BuildOps job type for "Time & Material" |
| `DEFAULT_DEPARTMENT_ID` | `d87c1a38-4acd-459f-9b3f-446a810fae10` | BuildOps department "D2 Service Calls (T&M)" |

To look up or verify the department ID: `npx tsx scripts/get_department_id.ts` (auto-refreshes the access token using `CLIENT_ID` / `CLIENT_SECRET` from `.env`).
