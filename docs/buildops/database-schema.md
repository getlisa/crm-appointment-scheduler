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
| `pending_jobs` | JSONB | NOT NULL DEFAULT '[]' | Array of `PendingJobData` objects collected during the call. Each element contains all the data needed to call `POST /v1/jobs` after the call ends (property ID, job type, price book, tasks, review flag, etc.). Populated via `append_pending_job`. |

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
| `job_type_name` | TEXT | | Display name of the job type (e.g. `Time & Material`). |
| `price_book_id` | TEXT | | Price book UUID used for the job. |
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

Local copy of BuildOps departments (used for job tagging). Synced separately.

| Column | Type | Constraints | Purpose |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | BuildOps department UUID. |
| `tag_name` | TEXT | NOT NULL | Human-readable department label. |
| `tenant_id` | UUID | NOT NULL | |
| `phone_primary` | TEXT | | Department contact number. |
| `email` | TEXT | | |
| `is_active` | BOOLEAN | DEFAULT true | Inactive departments are excluded from agent lookups. |

---

### `pricebook_items`

Local copy of BuildOps pricebook entries. Queried during a call when the agent needs to attach line items (tasks) to a job.

| Column | Type | Constraints | Purpose |
|---|---|---|---|
| `id` | UUID | PRIMARY KEY | |
| `tenant_id` | UUID | NOT NULL | |
| `product_id` | TEXT | NOT NULL | BuildOps product UUID. Sent to `POST /v1/jobs/{id}/tasks` as `entries[].productId`. |
| `name` | TEXT | NOT NULL | Product display name. Full-text searched when the agent looks up a service or part. |
| `description` | TEXT | | Extended description. Also searched. |
| `unit_price` | DECIMAL | | Unit price from BuildOps. Shown to agent for quoting context. |
| `taxable` | BOOLEAN | DEFAULT false | Whether this item is taxable. |
| `is_active` | BOOLEAN | DEFAULT true | Inactive items are excluded from search results. |

---

## Sync Jobs

These jobs keep the local Supabase tables in sync with BuildOps. They run on a schedule and do not affect live call handling directly — the call path reads only from Supabase.

---

### 1. Full Customer + Representative Sync

**Purpose:** Populate (or fully refresh) the `customers` table with every active and inactive customer from BuildOps, including all phone numbers from the customer record, their representatives, and their associated properties.

**Trigger:** Manual first run; then daily (off-peak hours) as a scheduled cron.

**Steps:**
1. Authenticate with BuildOps using the tenant's `client_id` and `client_secret`, obtain a fresh access token.
2. Fetch all customers via `GET /v1/customers` (paginated, 200 per page, `include_inactive=true`).
3. For each customer:
   - Fetch all representatives via `GET /v1/customers/{id}/our-representatives` (paginated, 100 per page).
   - Collect phone numbers from: customer `phonePrimary`, customer `phoneAlternate`, each representative's `cellPhone` and `landlinePhone`, and each property's `phonePrimary` and `phoneAlternate` (loaded from a properties snapshot).
   - Normalize every number to last-10 digits; deduplicate.
   - Build `all_numbers_sources` as a parallel array recording the origin of each number.
   - Build `addresses_all` from the customer's address items.
   - Build `properties_all` from the properties snapshot keyed by `customerId`.
4. Upsert each row into `customers` on `(tenant_id, buildops_customer_id)`.
5. Write a `sync_state.json` file recording: `lastRunAt`, `lastSyncedMs`, per-customer `versions`, per-property `propertyVersions`.

**State file schema (`sync_state.json`):**
```json
{
  "lastRunAt": "2025-05-11T04:00:00.000Z",
  "lastSyncedMs": 1746936000000,
  "versions": { "<buildops_customer_id>": <version_int> },
  "propertyVersions": { "<buildops_property_id>": <version_int> }
}
```

---

### 2. Incremental Customer Sync

**Purpose:** Apply only the changes since the last sync without re-fetching every customer. Intended to run every 15–30 minutes during business hours.

**Trigger:** Scheduled cron (15–30 min interval).

**Steps:**
1. Load `sync_state.json` to get `lastSyncedMs`.
2. Fetch customers where `audit.lastUpdatedDateTime > lastSyncedMs`.
3. For each changed customer, run the same representative + property phone collection as in the full sync.
4. Upsert only the changed rows. Skip rows where `version` in the response matches the stored version.
5. Update `sync_state.json` with new timestamps and versions.

---

### 3. Property Sync

**Purpose:** Keep the `property` table and the `properties.csv` snapshot current. Properties are service locations — their addresses and phone numbers feed into customer identification and job creation.

**Trigger:** Daily (runs before the full customer sync so the property phone map is available).

**Steps:**
1. Fetch all properties via `GET /v1/properties` (paginated, 100 per page).
2. For each property: extract `id`, `customerId`, `address`, `phonePrimary`, `phoneAlternate`, and metadata fields.
3. Upsert into the `property` table on `id`.
4. Write `properties.csv` snapshot (consumed by the customer sync to build `properties_all`).
5. Update `sync_state.json` with per-property versions.

---

### 4. Access Token Refresh

**Purpose:** BuildOps access tokens have a limited TTL. This job exchanges the stored `client_id` + `client_secret` for a fresh token and writes it back to `buildops_tenants.access_token`.

**Trigger:** Every 50–55 minutes (before token expiry; exact interval depends on BuildOps TTL).

**Steps:**
1. For each row in `buildops_tenants` where `is_active = true`:
   - `POST /v1/auth/token` with `{clientId, clientSecret, tenantId}`.
   - Update `access_token` in the row.
2. Log result; alert on failure (a stale token blocks all live calls for that tenant).

---

### 5. Pricebook Sync

**Purpose:** Keep `pricebook_items` current so agents can look up services and parts by name during a call.

**Trigger:** Daily or on-demand after a pricebook update in BuildOps.

**Steps:**
1. Fetch all pricebook items for the tenant from the BuildOps pricebook API.
2. Upsert on `(tenant_id, product_id)`.
3. Mark items no longer returned by the API as `is_active = false` (soft delete).
