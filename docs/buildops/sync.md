# BuildOps Integration — Sync Architecture

Keeps the local Supabase tables in sync with BuildOps so inbound calls can identify customers without making live API calls during the call.

---

## Implementation

| File | Mode | When to use |
|---|---|---|
| `src/services/buildops/supabase/buildops-cron/index.ts` | Full + Incremental | Deployed Supabase Edge Function (scheduled) |

---

## Full Sync

### `fullSeed()` in the edge function

Fetches every customer, property, and representative from BuildOps and writes a complete snapshot.

**Steps:**

1. **Fetch all properties** (paginated, 100/page, `include_addresses=true`)
   - Build `propMap`: `customerId → PropertySummary[]`
   - Build `propPhoneMap`: `customerId → PhoneEntry[]` (phone + source tag per property phone)

2. **Fetch all customers** (paginated, 100/page, `include_inactive=true`)

3. **Fetch representatives** for every customer
   - CSV scripts: sequential, one customer at a time
   - Edge function: batched parallel fetch (up to 40 concurrent `GET /v1/customers/{id}/our-representatives`)

4. **Build each customer row**:
   - Aggregate `all_numbers` (normalized last-10 digits) and `all_numbers_sources`:
     ```
     customer:phonePrimary        ← customer.phonePrimary
     customer:phoneAlternate      ← customer.phoneAlternate
     rep:cellPhone:{RepName}      ← each rep's cellPhone
     rep:landlinePhone:{RepName}  ← each rep's landlinePhone
     property:phonePrimary:{id}   ← each property's phonePrimary
     property:phoneAlternate:{id} ← each property's phoneAlternate
     ```
   - Deduplication: first occurrence of each normalized phone wins; duplicate phones (same number from multiple sources) are dropped from `all_numbers` but the first source tag is kept
   - Extract `billing_address` from `addresses[addressType=billingAddress]`
   - Extract `business_address` from first non-billing address (or first address if all are billing)

5. **Upsert in FK-safe order** (edge function only):
   - Upsert `buildops_customers` first (on conflict `tenant_id, buildops_customer_id`)
   - Upsert `buildops_properties` (on conflict `id`)
   - Delete all old `buildops_representatives` for the tenant, re-insert fresh rows in batches of 200
   - Query back `(id, customer_id)` pairs and write them into `buildops_customers.representative_ids`

6. **Write watermark**: save `lastSyncedMs = MAX(audit.lastUpdatedDateTime)` across all customers

---

## Incremental Sync

### `incrementalSync()` in the edge function

Only rebuilds customers whose data has changed. Uses three independent dirty-detection sources evaluated before the main customer loop.

### Dirty Detection Sources

| Source | Mechanism | Trigger |
|---|---|---|
| **Customer timestamp** | `customer.audit.lastUpdatedDateTime > buildops_customers.buildops_last_updated_at` | Any change in BuildOps to the customer record |
| **Customer version** | `customer.version > stored_version` | Same as above (belt-and-suspenders) |
| **Property change** | `property.audit.lastUpdatedDateTime > parent_customer.buildops_last_updated_at` | Address, phone, or status change on a service location |
| **Rep change** | `buildops_representatives.updated_at > parent_customer.buildops_last_updated_at` (Supabase query) | New phone added, rep deactivated, etc. |
| **New customer** | No existing row in `buildops_customers` | Customer created in BuildOps since last sync |

All five are evaluated independently and the results merged into a single `dirtySet`.

### Incremental Steps

1. Load existing customer rows from Supabase to build a `lastSyncedMs` boundary
2. Query Supabase `buildops_representatives` for all `(customer_id, updated_at)` → add any rep-updated customer IDs to `dirtySet`
3. Fetch all properties → detect property-triggered dirty customers → add to `dirtySet`
4. Page through all customers (`include_inactive=true`, 100/page):
   - **Clean**: reuse the existing row, skip rep fetch
   - **Dirty** (in `dirtySet` OR timestamp/version advanced): fetch fresh reps → rebuild row → upsert
   - **Early-stop**: once an entire page of customers has `lastUpdatedDateTime ≤ lastSyncedMs`, stop paginating (remaining pages are stale)

5. Handle dirty customers skipped by early-stop: for each `dirtySet` member that wasn't reached in the page scan, call `rebuildFromExisting()` — uses the stored customer scalars (name, phone, etc.) but fetches fresh reps and merges current property phones

6. Upsert updated rows to Supabase
7. Update watermark to `MAX(audit.lastUpdatedDateTime)` across all processed rows

### Deletion Handling

| Entity | How deletions are detected |
|---|---|
| **Properties** | During each incremental run, properties present in the DB but absent from the current API response for a dirty customer are deleted from `buildops_properties` |
| **Customers** | `is_active = false` is set in `buildops_customers`; rows are never hard-deleted |
| **Representatives** | During a dirty-customer rebuild, all reps for that customer are deleted and re-inserted from the live API response |

---

## Jobs Sync (`jobsSync`)

Runs on every cron cycle, in parallel with the customer/property/rep sync. Uses a single watermark per tenant.

**Watermark query:**
```sql
SELECT MAX(last_updated_at) FROM buildops_jobs WHERE tenant_id = $1
```

- First run (empty table): watermark = `0` → fetches all jobs ever
- Subsequent runs: fetches only jobs updated since the last highest `last_updated_at`

**Steps:**
1. Compute watermark
2. Call `GET /v1/jobs?lastUpdatedDateStart=<watermark_as_ISO>&page_size=100` (paginate until empty page)
3. Map each job to `buildops_jobs` columns:
   - `created_at` ← `audit.createdDateTime` (unix ms)
   - `last_updated_at` ← `audit.lastUpdatedDateTime` (unix ms) — advances watermark
   - `is_deleted` ← `audit.deletedDateTime != null` (BuildOps soft-delete signal)
4. Upsert all rows on conflict `(tenant_id, job_id)`

**Coverage:**

| Event | How it reaches Supabase |
|---|---|
| Job created via Retell | Written immediately in `prepare_job` (before Retell gets a response) |
| Job created manually in BuildOps | Picked up next cron run (≤5 min lag) |
| Job status updated in BuildOps | `last_updated_at` advances → picked up next run |
| Job soft-deleted in BuildOps | `audit.deletedDateTime` set → `is_deleted = true` next run |

---

## Batch Sizes

| Operation | Batch size |
|---|---|
| BuildOps API page size (customers, properties, reps, jobs) | 100 items/page |
| Supabase upsert batch | 200 rows/call |
| Parallel rep fetches (edge function full seed) | 40 concurrent |
| Parallel `representative_ids` back-writes (edge function) | 50 concurrent |

---

## Multi-Tenant

The edge function loads all rows from `buildops_tenants` and runs the full + jobs sync for each tenant sequentially. Token refresh (`POST /v1/auth/token`) happens once per tenant per run and the new token is written back to `buildops_tenants.access_token`.
