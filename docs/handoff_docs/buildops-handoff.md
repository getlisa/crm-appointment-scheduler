# BuildOps Integration — Full Session Log

**Branch**: `buildops_integration` | **Latest commit**: `502b740`
**Working tree**: uncommitted changes from sessions 2026-05-20s2 and 2026-05-21.

---

## Key Constants
```
Tenant inbound:   +19842056510  |  buildops_id: 470f824e-94a8-41c1-9ef6-c87bbe099dd2
clara:            id=08af512c-930d-408e-8cc2-673871b44c14  phone=+19330243834  propertyId=039de7b5-1549-4077-9965-7c82308ff9bc
Clara Customer:   id=dc45fcd3-e445-4c72-837e-005f89502161  buildops_id=3e34ee30-60e4-4017-ab5b-f7c1c7cb6426
                  phone=+14155201480  propertyId=6a62f305-8a22-4ef5-be19-bd8f8d8282f3
```

---

## Pending (current — in order)

### A. Supabase migrations — run BEFORE deploy

```sql
-- From 2026-05-19 session (cron):
ALTER TABLE buildops_tenants ADD COLUMN IF NOT EXISTS last_rep_sweep_at TIMESTAMPTZ;

-- From 2026-05-20 session 2 (caller source awareness):
ALTER TABLE buildops_properties
  ADD COLUMN IF NOT EXISTS representative_ids text[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_buildops_properties_rep_ids
  ON buildops_properties USING GIN (representative_ids);
```

Note: `buildops_inbound_calls` migration from 2026-05-19 (`session_id`/`retell_call_id` split) was included in earlier commit `1de40e7`.

### B. Commit + deploy
```bash
git add -A
git commit -m "caller source awareness, property-scoped reps, issue description improvements"
git push origin buildops_integration
# merge buildops_integration → main → Vercel auto-deploys
```

### C. Retell dashboard updates
- All 5 custom functions: set **`args_only = false`** (required — without it `body.call.call_id` is missing and all fn calls fail with `error: session not found`)
- `prepare_job`: add `caller_name` parameter (string, optional) — **code already implemented in `handlers/job.ts`; dashboard declaration is the only remaining step**; remove `task_count` from response variables if still present
- `add_representative` input parameters — replace with:
  | Parameter | Type | Required |
  |-----------|------|----------|
  | `first_name` | string | yes |
  | `last_name` | string | yes |
  | `property_id` | string | yes |
  | `email` | string | no |
  Response variables: keep `name` (combined string), `status`, `representative_id`.
- Paste updated `retell/retell_single_prompt.txt` into the Retell LLM agent and save

### D. Verify production
```bash
TEST_BASE_URL=https://crm-appointment-scheduler.vercel.app/api/buildops npx tsx tests/buildops/test_job_creation.ts
```
Watch for: `prepare_job start` shows `customerPropertyId` populated; `resolveSession ok` shows `retellCallId: 'call_xxx...'`.

### E. BuildOps webhook receiver (long-pending)
`POST /api/buildops/webhook` — Representative `created`/`updated` events → append phones to `all_numbers`.

### F. Post-call analysis (long-pending)
Register Retell `call_analyzed` webhook → write to `buildops_call_logs`: `retell_call_id`, `buildops_job_id`, `call_type`, `job_type`, `dispatch_outcome`, `caller_sentiment`, `overtime_authorized`, `caller_name`, `company_name`, `callback_number`, `service_address`, `issue_summary`, `call_summary`, `call_successful`, `user_sentiment`, `recording_url`, `transcript`.

---

## Current Architecture

### Call Flow
```
call_inbound  → phone lookup → parse all_numbers_sources → set caller_source_type/caller_rep_name/rep_property_id/rep_property_address
call_started  → findActiveByCallerAndTenant (DESC) → setRetellCallId(session.sessionId, realCallId)
fn/*          → body.call_id (root) → getInboundCall(retellCallId) → fallback; all DB updates use session.sessionId
call_ended    → getInboundCall(callId) → setCallStatus(session.sessionId, disconnectionReason) → fallback
add_rep       → POST /v1/properties/{id}/representatives → append :prop: source → appendToPropertyRepresentativeIds
```

### Cron Sync
```
incrementalSync()
  1. Check last_rep_sweep_at → set doRepSweep flag (every 2h)
  2. Load DB customer map (ts, version, repIds)
  3. Fetch all live properties → dirty by property.lastUpdatedDateTime
  4. Query DB reps → dirty by rep.updated_at > customer watermark
  5. Page all API customers:
       - skip deleted (audit.deletedDateTime) → delete from DB
       - dirty if: dirtySet || ts advance || version advance || !db || repIds.length === 0
       - rebuild dirty: re-fetch reps, upsert customer row, re-insert reps
  6. Property cleanup (remove DB props not in API)
  7. If doRepSweep: sweepAllReps() — compare rep COUNT (api vs db), rebuild changed → update last_rep_sweep_at
```

### Source String Format
```
rep:cellPhone:John Smith:prop:6a62f305-8a22-4ef5-be19-bd8f8d8282f3
```
Parsed in `call_inbound` to extract rep name and property UUID. Old format `rep:cellPhone:John Smith` (pre-2026-05-20 reps) → identified as `caller_source_type: "rep"` but `rep_property_id` will be empty, falling back to normal property selection.

---

## Session History

### Session 2026-05-18

- **Cross-account booking blocked** — removed CROSS-ACCOUNT BOOKING from Retell prompt; `handleLookupFuzzy` rejects fuzzy lookup if `session.matchedCustomerId` is already set.
- **`call_ended` status** — writes Retell's `disconnection_reason` directly instead of always `'ended'`.
- **Structured logging** — `[buildops]` prefixed logs throughout lifecycle + fn endpoints. Key log: `session swap { swapped: true }` — if `false`, fn calls will fail.
- **Retell prompt** — fixed: `issue_description` passed to `prepare_job`; `new_number_detected` read from `lookup_customer_fuzzy` result; `needs_review: true` sent when `confidence_tier = 2`.
- **Test script** — `tests/buildops/test_job_creation.ts`: 3 scenarios (unknown → fuzzy → job; registered → direct → job; no-priceBook → blocked). 19 assertions pass locally.

### Session 2026-05-19

- **Tasks removed** from `prepare_job` end-to-end (`routes`, `handlers/job.ts`, `types.ts`, `client.ts`). Remove `task_count` from Retell UI `response_variables`.
- **Req/resp logging** — every fn endpoint and lifecycle event logs both incoming payload and outgoing result.
- **Bug A — `customer_property_id` undefined**: `normalizedBuildopsPayload` checks `body?.args` before falling back to root body. Fixes all `args_at_root: false` functions.
- **Bug B — stale session matching**: split `retell_call_id` into two columns:
  - `session_id` — stable UUID set at `call_inbound`, used as WHERE key for all DB updates
  - `retell_call_id` — Retell's real `call_xxx` ID, NULL until `call_started`, used for direct fn/* lookup
  - `findActiveByCallerAndTenant` orders by `created_at DESC`
  - All handlers updated: `session.retellCallId` → `session.sessionId` in DB calls
  - `updateRetellCallId` renamed to `setRetellCallId(sessionId, realCallId)`
- **fn/* `callId: undefined` — root cause identified** (fix not yet applied in code): Retell fn/* payloads put `call_id` at root level (`body.call_id`), not nested (`body.call.call_id`). All 5 handlers use wrong path. Fix documented in Pending B above.
- **Cron sync — rep detection overhaul** (`src/services/buildops/supabase/buildops-cron/index.ts`):
  - Empty `representative_ids` as dirty signal — customers with no reps in DB are always re-fetched
  - Periodic full rep sweep every 2h via `sweepAllReps()`, throttled by `last_rep_sweep_at`
  - Deleted resource handling — customers with `audit.deletedDateTime` deleted from DB; deleted properties filtered before upsert
  - `updateRepresentativeIds` SELECT chunked at 50 IDs to avoid PostgREST URL limit
- **`tests/buildops/api_endpoints/get_representatives.ts`** — added `--id <buildops_customer_id>` flag

### Session 2026-05-20 (session 1 — cron + pending clarifications only)

- Investigated rep not appearing under Clara Customer: `GET /v1/customers/{id}/our-representatives` returns 0 reps. Root cause unresolved at session end.

### Session 2026-05-20 (session 2)

- **Bug — `new_number_detected: false` when caller unknown**: `buildInboundResponse()` now accepts `newNumberDetected` param (default `false`); `not_found` branch passes `true`.
  **File:** `src/routes/buildops.ts` — `buildInboundResponse()` + call site.

- **Property selection prompt**: Removed count-reveal language. New flow:
  - Ask "Which address are you calling about today?" → call `match_property`
  - If `matched` → confirm address; yes → lock and proceed; no → transfer
  - If `ambiguous`/`not_found` → one retry: "Could you give me the full street address including the zip code?" → `match_property` again → confirm; no → transfer; still fails → transfer
  **File:** `retell/retell_single_prompt.txt`

- **`add_representative` — opt-in only**: Ask before saving. Only collect name and call `add_representative` if caller says YES. Passes `property_id = customer_property_id`.
  **File:** `retell/retell_single_prompt.txt`

- **`add_representative` — property-scoped endpoint**: `property_id` now required; calls `POST /v1/properties/{id}/representatives` via new `createPropertyRepresentative()`.
  **Files:** `src/services/buildops/client.ts`, `src/services/buildops/handlers/representative.ts`

- **`prepare_job` — caller info in issue_description**: New optional arg `caller_name`. Description format:
  ```
  [Job Created by Clara]
  Caller: <caller_name> | Callback: <session.caller>
  <issue_description>
  ```
  **Files:** `src/services/buildops/handlers/job.ts`, `retell/retell_single_prompt.txt`

- **Rep not appearing under Clara Customer (previous pending E) — resolved**: Old endpoint was `/v1/customers/{id}/representatives` (customer-level). BuildOps attaches reps at property level. Fixed by switching to `/v1/properties/{id}/representatives`.

- **Caller source awareness + rep property pre-selection** (new feature):
  - DB migration: `representative_ids text[]` + GIN index on `buildops_properties`
  - `db/properties.ts`: `appendToPropertyRepresentativeIds(propertyId, buildopsRepId)` (best-effort)
  - `types.ts`: `allNumbersSources: string[]` added to `CustomerRow`
  - `db/customers.ts`: `mapRow()` now exposes `allNumbersSources`
  - `handlers/representative.ts`: source tag encodes `:prop:${propertyId}`; calls `appendToPropertyRepresentativeIds` as step 4
  - `routes/buildops.ts`: single-match `call_inbound` branch parses source string, fetches property address, adds 4 dynamic variables: `caller_source_type`, `caller_rep_name`, `rep_property_id`, `rep_property_address`
  - Prompt: 4 new dynamic variables declared; source-aware greeting (rep vs customer); property pre-selection shortcut when `rep_property_id` is set

- **Docs updated**: `docs/buildops/call-flow.md` and `docs/buildops/endpoint_responses.md` — `args_only: false` on all 5 functions, updated variable tables, updated flow diagram, Flow 3 added, `prepare_job`/`add_representative` tables updated, `not_found` flag corrected.

### Session 2026-05-22

- **Bug — `buildops_representatives` never written (wrong table name)**: All 5 Supabase queries in `src/services/buildops/db/representatives.ts` targeted `'representatives'` instead of `'buildops_representatives'`. Mid-call rep creation, phone lookups, and uniqueness checks were silently going to the wrong table. Cron sync was unaffected (used `batchInsert` with the correct name). Fixed by replacing all 5 occurrences.
  **File:** `src/services/buildops/db/representatives.ts`

- **Bug — wrong `customerId` in rep handlers** (FK violation exposed by above fix): Both `handleSaveCallerNumber` and `handleAddRepresentative` passed `customer.id` (Supabase UUID) to `createRepresentative()`. `buildops_representatives.customer_id` has a FK constraint referencing `buildops_customers.buildops_customer_id` (BuildOps text UUID — confirmed from DB data). Fixed by using `customer.buildopsCustomerId` in both call sites.
  **File:** `src/services/buildops/handlers/representative.ts`

- **`issue_description` — `caller_name` restored**: `handlePrepareJob` already extracted `caller_name` from args but discarded it (regression from 2026-05-21). Format updated to:
  ```
  [Job Created by Clara]
  Caller Name: <name>
  Callback Number:- <number>
  <issue_description>
  ```
  `caller_name` defaults to `"Unknown"`. **Retell dashboard action still required**: add `caller_name` as optional string input parameter to `prepare_job`.
  **File:** `src/services/buildops/handlers/job.ts`

- **Rep greeting updated to "property representative"**: Prompt now greets rep callers as "property representative for [address]" (falls back to "representative for [customer_name]" when `rep_property_address` is empty). `handleAddRepresentative` now chains `appendToCustomerRepresentativeIds` after `createRepresentative` returns, so `buildops_customers.representative_ids` is updated immediately on mid-call rep creation (previously only populated by cron). New DB helper: `appendToCustomerRepresentativeIds(tenantId, customerId, repId)`.
  **Files:** `src/services/buildops/db/customers.ts`, `src/services/buildops/handlers/representative.ts`, `retell/retell_single_prompt.txt`

### Session 2026-05-21

- **`match_property` — recall-based scoring** (`src/services/buildops/handlers/customer.ts`):
  - Added `recallRatio()` — fraction of stored line1 tokens found in spoken address; unaffected by extra garbage tokens from LLM context.
  - `scoreProperty` now uses `max(tokenSetRatio, recallRatio)` so "Twenty Nine Palms 92277" correctly scores against stored "29 PALMS".
  - City bonus now also checks flat string (spaces/hyphens collapsed) to match "Twentynine Palms" vs spoken "Twenty Nine Palms".

- **`normalizeAddress` — single-digit word normalization** (`src/services/buildops/fuzzy-search.ts`):
  - Added `WRITTEN_NUMBERS` table (ZERO–NINE only; no two-digit words) applied before USPS token map.
  - "FIVE OAK ST" → "5 OAK ST" before scoring.

- **`add_representative` — email wired through**:
  - `createPropertyRepresentative()` signature now includes `email?: string | null` (`src/services/buildops/client.ts`).
  - `handleAddRepresentative` applies `.trim()` to firstName/lastName, passes `email` to the API call (`src/services/buildops/handlers/representative.ts`).

- **`prepare_job` issue_description — removed caller name line** (`src/services/buildops/handlers/job.ts`):
  - Format changed from `[Job Created by Clara]\nCaller: <name> | Callback: <number>\n<issue>` to `[Job Created by Clara]\nCallback: <number>\n<issue>`.

- **Prompt — 5 changes** (`retell/retell_single_prompt.txt`):
  1. **Property selection**: `property_count = 1` always confirms address on file and uses pre-set `property_id`. `property_count > 1` never pre-confirms — always asks "Which address would you like service at today?".
  2. **match_property not_found after retry**: agent now transfers ("I'm having trouble locating that address") instead of collecting manually.
  3. **`caller_name` in prepare_job**: use `{{caller_rep_name}}` for reps, collected personal name for others, "Unknown" as fallback. Explicit `Do NOT use {{customer_name}}` rule.
  4. **Job creation confirmation**: agent says "Your job number is [X]" after `prepare_job` returns `status: created`.
  5. **Rep opt-in expanded**: triggers for both `caller_source_type: customer` (primary account number) AND `new_number_detected: true` (unknown number), not only fuzzy-identified callers. Collects email (optional), confirms name+email before calling `add_representative`.

---

## All Files Changed (cumulative)

| File | Last touched |
|------|-------------|
| `src/routes/buildops.ts` | 2026-05-20s2 — `new_number_detected` fix; source parsing + 4 new dynamic vars |
| `src/services/buildops/client.ts` | 2026-05-21 — `email` added to `createPropertyRepresentative()` |
| `src/services/buildops/db/customers.ts` | 2026-05-22 — `appendToCustomerRepresentativeIds()` added |
| `src/services/buildops/db/properties.ts` | 2026-05-20s2 — `appendToPropertyRepresentativeIds()` added |
| `src/services/buildops/db/inbound-calls.ts` | 2026-05-19 — `session_id`/`retell_call_id` split |
| `src/services/buildops/handlers/customer.ts` | 2026-05-21 — `recallRatio` + updated `scoreProperty` |
| `src/services/buildops/handlers/job.ts` | 2026-05-22 — caller_name restored in issue_description (Caller Name + Callback Number format) |
| `src/services/buildops/db/representatives.ts` | 2026-05-22 — table name fix (`'representatives'` → `'buildops_representatives'`, 5 occurrences) |
| `src/services/buildops/handlers/representative.ts` | 2026-05-22 — `customerId` fix + `appendToCustomerRepresentativeIds` chained after rep creation |
| `src/services/buildops/handlers/fuzzy-lookup.ts` | 2026-05-18 — cross-account guard |
| `src/services/buildops/fuzzy-search.ts` | 2026-05-21 — `WRITTEN_NUMBERS` (0-9) in `normalizeAddress` |
| `src/services/buildops/types.ts` | 2026-05-20s2 — `allNumbersSources: string[]` in `CustomerRow` |
| `src/services/buildops/supabase/buildops-cron/index.ts` | 2026-05-19 — rep detection overhaul + deleted resource handling |
| `retell/retell_single_prompt.txt` | 2026-05-22 — rep greeting updated to "property representative for [address]" |
| `docs/buildops/call-flow.md` | 2026-05-20s2 — args_only, variables table, flow diagram, Flow 3 |
| `docs/buildops/endpoint_responses.md` | 2026-05-20s2 — not_found flag, found vars, prepare_job curl, add_rep trigger |
| `migrations/buildops/20260520_002_property_rep_ids.sql` | 2026-05-20s2 — new migration |
| `tests/buildops/test_job_creation.ts` | 2026-05-18 — 3-scenario lifecycle test |
| `tests/buildops/api_endpoints/get_representatives.ts` | 2026-05-19 — `--id` flag added |
