# BuildOps Integration — Full Session Log

**Branch**: `buildops_integration` | **Latest commit**: `c1d6ff2` (prior) — new uncommitted changes below
**Working tree**: modified — see Session 2026-05-26 below.

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

### G. Populate `buildops_tenants.email_to` in Supabase

After running migration A3 below, update the `email_to` column for each tenant with the recipient email addresses:
```sql
UPDATE buildops_tenants
SET email_to = '{"ops@crockett.com", "meg@crockett.com"}'
WHERE buildops_tenant_id = '470f824e-94a8-41c1-9ef6-c87bbe099dd2';
```
Emails won't send until this is populated.

### H. Vercel env vars

Add/confirm in Vercel dashboard:
- `SENDGRID_API_KEY` — SendGrid API key
- `SENDER_MAIL` — verified sender address (e.g. `noreply@justclara.ai`)

### I. Trigger cron sync after deploy

After deploying, trigger `buildops-cron` (or wait for next scheduled run). This rebuilds `all_numbers_sources` with `:prop:propertyId` for property-linked reps — without it, existing property reps will be identified as contact reps on incoming calls.

### A. Supabase migrations — run BEFORE deploy

```sql
-- From 2026-05-19 session (cron):
ALTER TABLE buildops_tenants ADD COLUMN IF NOT EXISTS last_rep_sweep_at TIMESTAMPTZ;

-- From 2026-05-20 session 2 (caller source awareness):
-- NOTE: superseded by A5 below — do NOT run this standalone; A5 drops+recreates the column as uuid[]
-- ALTER TABLE buildops_properties ADD COLUMN IF NOT EXISTS representative_ids text[] ...

-- A3. From 2026-05-23 session (email notification):
-- File: migrations/buildops/20260522_003_tenant_email_to.sql
ALTER TABLE buildops_tenants
  ADD COLUMN IF NOT EXISTS email_to text[] NOT NULL DEFAULT '{}';

-- A4. From 2026-05-25 session (property rep on jobs):
-- File: migrations/buildops/20260523_004_job_property_rep.sql
ALTER TABLE buildops_jobs
  ADD COLUMN IF NOT EXISTS property_rep_name text,
  ADD COLUMN IF NOT EXISTS property_rep_id   text;

-- A5. From 2026-05-25 session 2 (rep visibility + phone uniqueness):
-- File: migrations/buildops/20260525_005_rep_buildops_id_and_constraints.sql
-- Adds buildops_rep_id, makes property_id nullable, deduplicates, adds phone unique indexes,
-- converts buildops_properties.representative_ids from text[] → uuid[].
-- Run this AFTER A4. Contains a data-cleanup UPDATE + DELETE to fix garbage property_id values.

-- A6. From 2026-05-25 session 2 (remove unused job columns):
-- File: migrations/buildops/20260525_006_remove_job_po_columns.sql
ALTER TABLE buildops_jobs DROP COLUMN IF EXISTS customer_provided_job_number;
ALTER TABLE buildops_jobs DROP COLUMN IF EXISTS customer_provided_po_number;
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
- `prepare_job`: add the following input parameters (string, optional):
  - `caller_name` — already implemented in `handlers/job.ts`
  - `caller_rep_supabase_id` — Supabase UUID of the caller's rep record (stamps `property_rep_id` on local job row)
  - `caller_rep_buildops_id` — BuildOps UUID of the caller's rep record (passed as `customerRepId` to the BuildOps API); set at call-start for known single-property reps, or captured from `add_representative` response for newly registered reps (**new — add this param**)
  - Remove `task_count` from response variables if still present
- Retell **dynamic variables** — add:
  - `caller_rep_buildops_id` (string, default `""`)
  - `rep_is_multi_property` (string, default `"false"`)
- `add_representative` input parameters — replace with:
  | Parameter | Type | Required |
  |-----------|------|----------|
  | `first_name` | string | yes |
  | `last_name` | string | yes |
  | `property_id` | string | yes |
  | `email` | string | no |
  Response variables: keep `name` (combined string), `status`, `representative_id` (BuildOps UUID — used as `caller_rep_buildops_id` in the pre-job rep flow).
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
  6. Before deleting old reps: capture existing property_id values (for stale-array cleanup)
  7. Delete + re-insert reps for dirty customers
  8. updateRepresentativeIds() — rebuilds buildops_customers.representative_ids (Supabase UUIDs)
  9. updatePropertyRepresentativeIds() — rebuilds buildops_properties.representative_ids (Supabase UUIDs)
     Passes union of old + new property IDs so properties that lost all reps get reset to []
 10. Property cleanup (remove DB props not in API)
 11. If doRepSweep: sweepAllReps() — compare rep COUNT (api vs db), rebuild changed
       → same old/new property ID union pattern → update last_rep_sweep_at

buildRepRow() encoding:
  property_id:    r.propertyId ?? null      (null = customer-level rep; never falls back to companyId)
  buildops_rep_id: r.id                     (BuildOps UUID stored for cross-referencing)
```

### Source String Format
```
rep:cellPhone:John Smith:prop:6a62f305-8a22-4ef5-be19-bd8f8d8282f3   ← property rep (preferred)
rep:cellPhone:John Smith                                               ← contact rep (no property link)
```
Parsed in `call_inbound` to extract rep name and property UUID. The cron sync (2026-05-23 fix) now encodes `:prop:propertyId` for any rep where `ApiRep.propertyId` is set, sorting property-linked reps first so their phone wins the dedup. Old records without `:prop:` are identified as `caller_source_type: "rep"` but `rep_property_id` will be empty → greeted as "contact representative", opt-in offered post-job.

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

### Session 2026-05-23 (session 1 — prepare_job timing + email + rep identification)

- **`prepare_job` timing — confirmation gate + individual name rule**:
  - Prompt: added explicit CONFIRMATION GATE (mandatory) — agent must read back name, callback number, and issue and receive "yes" before calling `prepare_job`. If caller corrects a field, only that field is re-confirmed; `prepare_job` is not called until a clean "yes" is received.
  - Prompt: added INDIVIDUAL NAME RULE — agent must collect caller's personal name before `prepare_job`; never uses `{{customer_name}}`; uses `{{caller_rep_name}}` if `caller_source_type` is "rep".
  - Prompt: Call Type A — moved `prepare_job` to after billing authorization ("Do you authorize the call-out?"); added explicit "IF CALLER DECLINES → do NOT call `prepare_job`" branch.
  - Prompt: Call Type B — added confirmation gate as step 3; `prepare_job` moved to step 4 (after confirmation).
  **File:** `retell/retell_single_prompt.txt`

- **Email notification service created** (`src/services/buildops/emailNotificationService.js`):
  - `sendJobNotification({ outcome, recipientEmails, details })` — fire-and-forget, never throws.
  - Gates: `SENDGRID_API_KEY` must be set + `recipientEmails` must be non-empty (silently skips otherwise).
  - Recipients from `buildops_tenants.email_to` (text array — see migration A3).
  - Two outcomes at creation: `'job_created'` and `'job_not_created'` (later updated to tiers — see session 2).
  - HTML: dual-card design (Caller Details + Action Taken), green/red badge, plain-text fallback.
  **Files:** `src/services/buildops/emailNotificationService.js` (created), `src/services/buildops/db/tenants.ts` (both SELECT queries + return objects include `email_to`), `src/services/buildops/types.ts` (`email_to: string[]` added to `ResolutionRow`), `.env.example` (`SENDGRID_API_KEY`, `SENDER_MAIL` added)

- **`job.ts` — email integration**:
  - Import `sendJobNotification` from `../emailNotificationService.js`.
  - `freshResolution` (tenant DB row) moved before the blocked-account check so `email_to` is available at all 3 exit paths.
  - Fire-and-forget at: job created (outcome `'job_created'`), account blocked (outcome `'job_not_created'`, `reasonCode: 'blocked'`), internal error (outcome `'job_not_created'`, `reasonCode: 'internal_error'`).
  **File:** `src/services/buildops/handlers/job.ts`

- **SQL migration** `migrations/buildops/20260522_003_tenant_email_to.sql` created.

### Session 2026-05-23 (session 2 — email tiers + property rep sync fix)

- **Email notification — tier-based outcomes**:
  - Outcomes changed: `'job_created'` / `'job_not_created'` → `'tier1'` / `'tier2'` / `'tier3'`.
    - `tier1`: job created, `needs_review=false` → green badge "Tier 1 — Service Request Logged"
    - `tier2`: job created, `needs_review=true` → orange badge "Tier 2 — Review Required"; adds `reviewReason` row
    - `tier3`: job not created (blocked or error) → red badge "Tier 3 — Job Not Created"; adds `Reason` row
  - Added `BUILDOPS_JOB_URL = 'https://live.buildops.com/job/view/'` constant. Tier 1 and 2 emails include a **View in BuildOps** button: `https://live.buildops.com/job/view/{jobNumber}` (job_number is the human-readable number e.g. `5270`, not the UUID).
  - Full email field structure per tier:
    ```
    Tier 1/2: Caller Name · Callback Number · Customer · Service Address · Issue · Job Number · Tier · [Review Reason — tier2 only] · Logged At · [View button]
    Tier 3:   Caller Name · Callback Number · Customer · Service Address · Issue · Tier · Reason · Logged At
    ```
  **File:** `src/services/buildops/emailNotificationService.js`

- **`job.ts` — tier split at success path**:
  - `needsReview=false` → `sendJobNotification({ outcome: 'tier1', ... })`.
  - `needsReview=true` → `sendJobNotification({ outcome: 'tier2', ..., reasonCode: 'review_required', reasonMessage: 'Manual review required before dispatch' })`.
  - Blocked + error paths now use `'tier3'` (was `'job_not_created'`).
  **File:** `src/services/buildops/handlers/job.ts`

- **Cron sync — property rep source tag fix** (critical):
  - **Bug**: `buildCustomerRow()` built source tag `rep:cellPhone:John Smith` for ALL reps, ignoring `r.propertyId`. Property-linked reps were never identified as property reps on incoming calls.
  - **Fix**: sort reps so those with `r.propertyId` come first (so their phone wins dedup), then append `:prop:${r.propertyId}` to the source tag.
  - After next cron run, `all_numbers_sources` will correctly encode property-linked reps; route parsing in `buildops.ts` will extract `repPropertyId` and fetch `repPropertyAddress` automatically.
  **File:** `src/services/buildops/supabase/buildops-cron/index.ts`

- **Prompt — contact rep greeting + expanded opt-in**:
  - Greeting for contact reps (no property link) now says "contact representative for {{customer_name}}" instead of "representative for".
  - Added IDENTITY PRIORITY rule: property rep identity always takes precedence; caller with `rep_property_id` non-empty is always "property representative".
  - Opt-in expanded from 2 cases to 3: now also triggers for `caller_source_type="rep"` + `rep_property_id` empty (contact rep not yet linked to a property). In that case: confirms name using `{{caller_rep_name}}`, then proceeds to `add_representative`. Previously all reps were skipped.
  **File:** `retell/retell_single_prompt.txt`

- **Docs updated**: `docs/buildops/call-flow.md` — added Flow 3b (contact rep opt-in path), updated rep opt-in check diagram to 3 cases, added email notification tier table with job link info under `prepare_job`.

### Session 2026-05-25 — property rep on jobs + call-start UUID lookup + TS conversion

- **Property rep stamped on job row** (new feature):
  - Migration `migrations/buildops/20260523_004_job_property_rep.sql`: adds `property_rep_name text` and `property_rep_id text` columns to `buildops_jobs`.
  - `types.ts`: `JobRow` now includes `propertyRepName: string | null` and `propertyRepId: string | null` with JSDoc.
  - `db/jobs.ts`: `mapRow()` maps both new fields; `upsertJob()` accepts and writes them as optional params; new `updateJobRepresentative(tenantId, jobId, repId, repName)` function — targeted `.update()` of only those two fields (does NOT upsert to avoid overwriting other job fields).
  - `handlers/job.ts`: after `executeJobCreation` succeeds, reads `args.caller_rep_supabase_id` (see below) and calls `updateJobRepresentative` best-effort. `callerName` (already extracted from `args.caller_name`) used as the rep name.
  - `handlers/representative.ts`: after `createRepresentative().then()` resolves with `supabaseRep`, if `session.buildopsJobId` is set (i.e. `prepare_job` already ran), calls `updateJobRepresentative` to stamp the newly opted-in rep on the job. This covers the opt-in path where the rep was not in the system at job creation time.
  **Files:** `migrations/buildops/20260523_004_job_property_rep.sql`, `src/services/buildops/types.ts`, `src/services/buildops/db/jobs.ts`, `src/services/buildops/handlers/job.ts`, `src/services/buildops/handlers/representative.ts`

- **Caller rep UUID resolved at call-start** (replaces secondary lookup in `prepare_job`):
  - Previously: `handlePrepareJob` called `findRepsByPhone` after job creation to get the rep's Supabase UUID — a redundant lookup since the rep was already identified at call-start.
  - Fix: in `buildops.ts` `call_inbound` single-match branch, when `isRep=true`, calls `findRepsByPhone(resolution.buildops_tenant_id, callerLast10)` once. Prefers a rep whose `propertyId` matches `repPropertyId`; falls back to first match. Stores the UUID in a new `caller_rep_supabase_id` dynamic variable (empty string for non-reps).
  - `handlers/job.ts`: removed `findRepsByPhone` + `normalizePhoneLast10` imports; replaced phone-lookup block with a single `args.caller_rep_supabase_id` read.
  - `retell/retell_single_prompt.txt`: all `prepare_job` call sites updated to pass `caller_rep_supabase_id: {{caller_rep_supabase_id}}`.
  - **Retell dashboard action required**: add `caller_rep_supabase_id` as optional string parameter to the `prepare_job` function schema (see Pending C above).
  **Files:** `src/routes/buildops.ts`, `src/services/buildops/handlers/job.ts`, `retell/retell_single_prompt.txt`

- **`tests/buildops/api_endpoints/get_job.ts` — property rep fields displayed**:
  - Added inline `createClient` Supabase client (same pattern as `getcustomers.ts`).
  - After BuildOps API output, queries `buildops_jobs` by `(tenant_id, job_id)` and prints `Rep Name` and `Rep ID` from the local row.
  **File:** `tests/buildops/api_endpoints/get_job.ts`

- **`emailNotificationService.js` → `.ts` (TypeScript conversion)**:
  - Renamed/rewritten as `emailNotificationService.ts` to fix TS7016 implicit-any error in `handlers/job.ts`.
  - Exports `NotificationOutcome` type (`'tier1' | 'tier2' | 'tier3'`) and `NotificationDetails` interface.
  - All function signatures typed; `err?.message` replaced with `err instanceof Error` guard.
  - Old `.js` file deleted. Import path in `job.ts` unchanged (`../emailNotificationService.js` resolves to `.ts` at compile time).
  **Files:** `src/services/buildops/emailNotificationService.ts` (created), `src/services/buildops/emailNotificationService.js` (deleted)

### Session 2026-05-25 (session 2 — rep visibility, property rep_ids, phone uniqueness)

- **Root cause: `buildops_representatives` row not findable by returned ID**: `add_representative` returns `buildopsRep.id` (BuildOps API UUID), but local DB uses a Supabase auto-generated UUID as PK with no column storing the BuildOps UUID. Added `buildops_rep_id TEXT` column so both UUIDs are persisted.
  **File:** `migrations/buildops/20260525_005_rep_buildops_id_and_constraints.sql`, `db/representatives.ts`, `types.ts`

- **`property.representative_ids` was never populated by cron, and was wrong type**: Previously `text[]` storing BuildOps UUIDs (unresolvable against local PK). Changed to `uuid[]` storing Supabase UUIDs, consistent with `customers.representative_ids`. Cron now calls new `updatePropertyRepresentativeIds()` in all 3 sync paths (full seed, incremental, sweep). Captures old property IDs before delete so properties that lose all reps get their array zeroed.
  **Files:** `migrations/buildops/20260525_005_rep_buildops_id_and_constraints.sql`, `db/properties.ts`, `buildops-cron/index.ts`

- **`appendToPropertyRepresentativeIds` was appending the wrong ID at the wrong time**: Was called in the main body of `handleAddRepresentative` with the BuildOps UUID, before the local DB write completed. Moved inside the `.then()` chain; now passes the Supabase UUID. Also passes `buildopsRepId: buildopsRep.id` into `createRepresentative()` so the BuildOps UUID is stored on the row.
  **File:** `src/services/buildops/handlers/representative.ts`

- **`property_id NOT NULL` was silently breaking customer-level rep creation**: BuildOps returns `propertyId: null` for reps tied only to a customer (not a property). Old cron fallback `r.propertyId ?? r.companyId ?? ''` stored the tenant company UUID as property_id — invalid. `handleSaveCallerNumber` passed no `propertyId` at all, causing a silent FK-or-NOT-NULL failure. Made `property_id` nullable; cron now uses `r.propertyId ?? null`; `handleSaveCallerNumber` explicitly passes `propertyId: null`.
  **Files:** `migrations/buildops/20260525_005_rep_buildops_id_and_constraints.sql`, `buildops-cron/index.ts`, `handlers/representative.ts`

- **Data cleanup — garbage `property_id` values**: Migration sets `property_id = NULL` for any row whose value is not in `buildops_properties.id` (company UUIDs stored by old cron). Then deduplicates rows that became duplicates after the NULL-ification, keeping the most recently updated row per group.
  **File:** `migrations/buildops/20260525_005_rep_buildops_id_and_constraints.sql`

- **Phone uniqueness enforced per scope**: Four partial unique indexes:
  - `(tenant_id, normalized_cell_phone, property_id) WHERE property_id IS NOT NULL` — same phone blocked at same property
  - `(tenant_id, normalized_cell_phone) WHERE property_id IS NULL` — same phone blocked for customer-level reps
  - Same two for `normalized_landline_phone`
  Same phone is allowed across different properties or between property-level and customer-level.
  **File:** `migrations/buildops/20260525_005_rep_buildops_id_and_constraints.sql`

- **Removed `customer_provided_job_number` and `customer_provided_po_number`** from `buildops_jobs` — unused, always null. Dropped in migration, removed from `JobRow` type, `upsertJob` interface, upsert payload, cron job sync interface and payload, and `BuildOpsJobResponse` type.
  **Files:** `migrations/buildops/20260525_006_remove_job_po_columns.sql`, `types.ts`, `db/jobs.ts`, `buildops-cron/index.ts`

- **`PropertyRow` type now includes `representativeIds: string[]`**: `mapRow()` in `db/properties.ts` exposes the column. New exported `updatePropertyRepresentativeIds(tenantId, propertyIds)` function mirrors the existing `updateRepresentativeIds` pattern for customers.
  **Files:** `src/services/buildops/db/properties.ts`, `src/services/buildops/types.ts`

### Session 2026-05-26 — call flow audit: multi-property rep, customerRepId, name collection, rep-first flow

- **Multi-property rep detection** (`src/routes/buildops.ts` `call_inbound`): When `findRepsByPhone` returns reps with 2+ distinct non-null `propertyId` values, the new `rep_is_multi_property: 'true'` dynamic variable is set. `rep_property_id`, `rep_property_address`, `caller_rep_supabase_id`, and `caller_rep_buildops_id` are left empty (can't resolve until `match_property` confirms the property). Prompt uses `rep_is_multi_property` to ask "You're a representative for multiple locations — which address are you calling about?" then calls `match_property`.

- **`customerRepId` stamped on BuildOps job** (`types.ts`, `handlers/job.ts`, `db/representatives.ts`): `PendingJobData` and `CreateJobInput` now include `customerRepId?: string | null`. `handlePrepareJob` resolves the BuildOps UUID via `args.caller_rep_buildops_id` (from dynamic variable or from `add_representative` response), falling back to a `getRepById` Supabase lookup if only the Supabase UUID is known. `executeJobCreation` passes it to the `POST /v1/jobs` API — the BuildOps job now shows `customerRepName` in the API response.
  - New DB helper: `getRepById(tenantId, supabaseId)` in `db/representatives.ts`.
  **Files:** `src/services/buildops/types.ts`, `src/services/buildops/handlers/job.ts`, `src/services/buildops/db/representatives.ts`

- **`caller_rep_buildops_id` dynamic variable** (`src/routes/buildops.ts`): Set at `call_inbound` for single-property known reps from `matchedRep.buildopsRepId`. Empty for multi-property reps and non-reps.

- **Payload completeness** (`src/routes/buildops.ts`): `buildInboundResponse` (not_found + error paths) and the `multiple_matches` response now include all dynamic variables that the prompt references — `property_count`, `property_id`, `address`, `address_source`, `caller_source_type`, `caller_rep_name`, `rep_property_id`, `rep_property_address`, `caller_rep_supabase_id`, `caller_rep_buildops_id`, `rep_is_multi_property` — with empty/zero defaults. Prevents Retell undefined-variable failures.

- **Pre-job rep registration for new callers** (`retell/retell_single_prompt.txt`): When `new_number_detected = 'true'` (from fuzzy lookup response), the rep registration offer is now made BEFORE issue description, not after job creation. If caller says YES → `add_representative` → note `representative_id` (BuildOps UUID) → pass as `caller_rep_buildops_id` to `prepare_job` → BuildOps job is created WITH `customerRepId` populated. The `new_number_detected` case removed from post-job opt-in tree.

- **Caller name collection moved earlier** (`retell/retell_single_prompt.txt`): INDIVIDUAL NAME RULE now explicitly instructs Clara to ask for the caller's name IMMEDIATELY AFTER property is confirmed, BEFORE the issue description — not just before the confirmation gate. Prevents "Caller Name: Unknown" for matched customers.

- **`caller_rep_buildops_id` added to all `prepare_job` call sites** (`retell/retell_single_prompt.txt`): All three call sites (emergency dispatch, schedule-later, Call Type B) now pass `caller_rep_buildops_id: {{caller_rep_buildops_id}}`.

- **`docs/buildops/call-flow.md` updated**: Flow 1 restructured (rep-first), Flow 3c added (multi-property rep), `found` outcome table updated with new vars, `prepare_job` params table includes `caller_rep_supabase_id` and `caller_rep_buildops_id`, call flow diagram updated, post-job opt-in tree corrected (2 cases, not 3), `emailNotificationService.js` → `.ts` reference fixed.

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
| `src/services/buildops/db/properties.ts` | 2026-05-25s2 — `mapRow` adds `representativeIds`; `appendToPropertyRepresentativeIds` uses Supabase UUID; new `updatePropertyRepresentativeIds()` |
| `src/services/buildops/db/inbound-calls.ts` | 2026-05-19 — `session_id`/`retell_call_id` split |
| `src/services/buildops/handlers/customer.ts` | 2026-05-21 — `recallRatio` + updated `scoreProperty` |
| `src/services/buildops/handlers/job.ts` | 2026-05-22 — caller_name restored in issue_description (Caller Name + Callback Number format) |
| `src/services/buildops/db/representatives.ts` | 2026-05-25s2 — `mapRow`/`CreateRepInput`/`createRepresentative` add `buildopsRepId`; `propertyId` nullable |
| `src/services/buildops/handlers/representative.ts` | 2026-05-25s2 — property append moved inside `.then()` using Supabase UUID; `buildopsRepId` passed to `createRepresentative`; `handleSaveCallerNumber` passes `propertyId: null` |
| `src/services/buildops/handlers/fuzzy-lookup.ts` | 2026-05-18 — cross-account guard |
| `src/services/buildops/fuzzy-search.ts` | 2026-05-21 — `WRITTEN_NUMBERS` (0-9) in `normalizeAddress` |
| `src/services/buildops/types.ts` | 2026-05-25s2 — `RepresentativeRow` adds `buildopsRepId`/nullable `propertyId`; `PropertyRow` adds `representativeIds`; `JobRow`+`BuildOpsJobResponse` lose PO fields |
| `src/services/buildops/supabase/buildops-cron/index.ts` | 2026-05-25s2 — `buildRepRow` uses `property_id ?? null` + `buildops_rep_id`; new `updatePropertyRepresentativeIds()`; all 3 sync paths capture old prop IDs and refresh both customer + property rep arrays; PO columns removed from job sync |
| `src/services/buildops/emailNotificationService.ts` | 2026-05-25 — **converted from .js**; typed (`NotificationOutcome`, `NotificationDetails`); `.js` deleted |
| `src/services/buildops/handlers/job.ts` | 2026-05-25 — reads `args.caller_rep_supabase_id`; calls `updateJobRepresentative` best-effort |
| `src/services/buildops/handlers/representative.ts` | 2026-05-25 — calls `updateJobRepresentative` after opt-in if `session.buildopsJobId` set |
| `src/services/buildops/db/jobs.ts` | 2026-05-25s2 — PO columns removed from `mapRow`, `upsertJob` interface, and upsert payload |
| `src/services/buildops/types.ts` | 2026-05-25 — `propertyRepName`/`propertyRepId` added to `JobRow` |
| `src/routes/buildops.ts` | 2026-05-25 — `findRepsByPhone` at call-start; `caller_rep_supabase_id` dynamic variable |
| `retell/retell_single_prompt.txt` | 2026-05-25 — all `prepare_job` call sites pass `caller_rep_supabase_id: {{caller_rep_supabase_id}}` |
| `migrations/buildops/20260523_004_job_property_rep.sql` | 2026-05-25 — **created**; `property_rep_name`/`property_rep_id` on `buildops_jobs` |
| `tests/buildops/api_endpoints/get_job.ts` | 2026-05-25 — Supabase query + display of `property_rep_name`/`property_rep_id` |
| `src/services/buildops/db/tenants.ts` | 2026-05-23s1 — `email_to` added to both SELECT queries + return objects |
| `docs/buildops/call-flow.md` | 2026-05-23s2 — Flow 3b, 3-case opt-in diagram, email tier table |
| `migrations/buildops/20260522_003_tenant_email_to.sql` | 2026-05-23s1 — **created**; `email_to text[]` on `buildops_tenants` |
| `.env.example` | 2026-05-23s1 — `SENDGRID_API_KEY`, `SENDER_MAIL` added |
| `docs/handoff_docs/buildops-handoff.md` | 2026-05-25s2 — session 2026-05-25s2 added |
| `docs/buildops/endpoint_responses.md` | 2026-05-20s2 — not_found flag, found vars, prepare_job curl, add_rep trigger |
| `migrations/buildops/20260520_002_property_rep_ids.sql` | 2026-05-20s2 — new migration (superseded by 005 which changes column to uuid[]) |
| `migrations/buildops/20260525_005_rep_buildops_id_and_constraints.sql` | 2026-05-25s2 — **created**; `buildops_rep_id`, nullable `property_id`, data cleanup + dedup, phone unique indexes, property `representative_ids` → `uuid[]` |
| `migrations/buildops/20260525_006_remove_job_po_columns.sql` | 2026-05-25s2 — **created**; drops `customer_provided_job_number` + `customer_provided_po_number` |
| `tests/buildops/test_job_creation.ts` | 2026-05-18 — 3-scenario lifecycle test |
| `tests/buildops/api_endpoints/get_representatives.ts` | 2026-05-19 — `--id` flag added |
