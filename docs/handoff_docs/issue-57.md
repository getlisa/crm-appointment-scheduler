# Issue 57 — "session not found" for all Retell function calls

**Status**: Fixed & Verified  
**Branch**: `buildops_integration`  
**Affects**: `prepare_job`, `lookup_customer_fuzzy`, `add_representative`, `match_property`  
**Severity**: P0 — every function call was broken for every caller

---

## What Was Broken

Every Retell custom function call returned `"error: session not found"`, even for callers who were correctly identified at call start. The agent could greet the caller by name and read their address, but could not create a job, do fuzzy lookup, or add a representative.

---

## Root Causes

### Bug 1 (Primary) — `created_at` column missing from `buildops_inbound_calls`

`findActiveByCallerAndTenant()` in `src/services/buildops/db/inbound-calls.ts` ordered its
query by `.order('created_at', { ascending: false })`, but `created_at` was never added to
the `buildops_inbound_calls` table.

Every call to this function failed with Postgres error **42703 (undefined column)**. The
`if (error || ...) return null` guard silently returned null every time.

**Cascade effect:**

```
call_inbound  → session created with crypto.randomUUID() (Retell sends no call_id at inbound)
call_started  → findActiveByCallerAndTenant() = null  ← BUG 1 kills this
               → UUID never replaced with real Retell call_id
prepare_job   → getInboundCall("call_ce3bc...") = null  (UUID in DB, real ID in request)
               → fallback findActiveByCallerAndTenant() = null  ← BUG 1 again
               → "error: session not found"
call_ended    → also can't close sessions → stale active rows accumulate over time
```

### Bug 2 (Secondary) — Phone format mismatch

Even if Bug 1 were fixed, `findActiveByCallerAndTenant` used an exact `.eq('caller', caller)`
match. Retell sends `from_number` in varying formats across events:

| Event | from_number example |
|---|---|
| `call_inbound` | `+919330243839` (India prefix) |
| `call_started` | `+19330243839` (US E.164) |
| function calls | `+919330243839` or `9330243839` |

Exact match fails when the stored format ≠ search format.

---

## Evidence

**Production log (call `call_ce3bcbda965d87d6d403b55aca0`):**
```
15:09:24  call_inbound  → identified=true, from_number="+919330243839"
15:09:29  call_started  → findActiveByCallerAndTenant = null → UUID not updated
15:10:19  prepare_job   → "error: session not found"
```

**DB at time of failure (3 stale sessions, all status='active'):**

| retell_call_id | caller | status |
|---|---|---|
| `b660ef24-...` (UUID) | `9330243839` | active |
| `acb4e8a5-...` (UUID) | `+919330243839` | active |
| `420a15eb-...` (UUID) | `+19330243839` | active |

The real call's session existed (4th UUID row) but was never matched to `call_ce3bc...`.

---

## Changes Made

> **Note (subsequent commit):** Change #5 (CROSS-ACCOUNT BOOKING prompt section) was rolled back.
> Cross-account booking opens bad job-creation paths (an identified caller switching mid-call to
> another company's account). A backend guard was added to `handleLookupFuzzy` instead: if
> `session.matchedCustomerId` is already set, the function rejects the call immediately.
> Allowed flows are now: (1) unknown caller → fuzzy lookup → associate → optional add_representative;
> (2) identified caller → prepare_job only.

### 1. Migration — add `created_at` to `buildops_inbound_calls`

**File**: `migrations/buildops/20260512_001_buildops_core_tables.sql`

```sql
alter table public.buildops_inbound_calls
  add column if not exists created_at timestamptz default now();
```

Run against Supabase before deploying code.

### 2. Fix `findActiveByCallerAndTenant`

**File**: `src/services/buildops/db/inbound-calls.ts`

Replaced exact `.eq('caller', caller)` with fetch-then-normalize approach:
- Fetch up to 5 active sessions for the tenant (now ordered by `created_at DESC`)
- Normalize both stored `caller` and search `caller` to last-10 digits in JS
- Return the most-recent match

This fixes Bug 1 (ordering works) and Bug 2 (format variations all normalize to the same 10 digits).

### 3. Move `createInboundCall` after resolution guard

**File**: `src/routes/buildops.ts` — `call_inbound` handler

Previously `createInboundCall` fired before the `if (!resolution)` check. Unknown tenant
numbers caused a NOT NULL constraint violation on `tenant_id`, which was silently swallowed,
breaking the `call_inbound` response for unconfigured numbers. Moved to after the guard.

### 4. Add diagnostic warn log

**File**: `src/routes/buildops.ts` — `resolveSession()`

Added `console.warn('[buildops] resolveSession failed', { callId, fromNumber, toNumber })` so
future session-not-found failures leave a trace in Vercel logs.

### 5. ~~Agent prompt — cross-account booking~~ (ROLLED BACK)

~~Added **CROSS-ACCOUNT BOOKING** section to guide the agent when a recognized caller asks to
book service for a different company.~~

**Rolled back.** Cross-account booking allows an identified caller to switch accounts mid-call,
leading to jobs being created under the wrong account. The prompt section was removed.

**Replaced with:** backend guard in `src/services/buildops/handlers/fuzzy-lookup.ts` —
`handleLookupFuzzy` now returns an error if `session.matchedCustomerId` is already set.

### 6. Structured Vercel logging

Added `[buildops]` prefixed `console.log` statements throughout the call lifecycle:
- `src/routes/buildops.ts` — `call_inbound`, `call_started`, `call_ended`, `resolveSession`, and all 5 function endpoints
- `src/services/buildops/db/inbound-calls.ts` — `findActiveByCallerAndTenant` (logs rows found + whether phone matched)
- `src/services/buildops/handlers/fuzzy-lookup.ts` — lookup start, scoring summary, accept path
- `src/services/buildops/handlers/customer.ts` — confirm_customer call and result
- `src/services/buildops/handlers/job.ts` — prepare_job start, customer status check, block/create result

Key log to watch: `[buildops] session swap` — `swapped: true` confirms `call_started` correctly
replaced the UUID with the real Retell call_id. If `swapped: false`, the session won't be found
by subsequent function calls.

---

## One-Time DB Cleanup

Run in Supabase SQL editor to close the 3 stale test sessions:

```sql
UPDATE buildops_inbound_calls
SET status = 'ended'
WHERE retell_call_id IN (
  'b660ef24-e37b-4562-a0b8-a52714e8ab8d',
  'acb4e8a5-4925-430b-8774-666ebf0311b3',
  '420a15eb-1dbd-4856-9b0f-f5e9e8a60330'
);
```

---

## Verification

Test script: `tests/buildops/test_job_creation.ts`  
Run with: `npx tsx tests/buildops/test_job_creation.ts` (local server on port 8080)

All 19 assertions pass (2026-05-18):

| Test | Scenario | Result |
|---|---|---|
| A (6 checks) | Unknown caller → fuzzy lookup → job created → add_rep → call_ended (`user_hangup`) | ✓ all pass |
| B (4 checks) | Registered clara → direct identification → job created → call_ended (`user_hangup`) | ✓ all pass |
| C (2 checks) | Clara Customer (no priceBook) → job creation correctly fails → call_ended (`user_hangup`) | ✓ all pass |

Jobs created in test run: `#5166` (Test A), `#5167` (Test B).

---

## Deployment Order

1. Apply SQL migration to Supabase (`ALTER TABLE` adds `created_at`)
2. Run stale session cleanup SQL
3. Deploy code changes
4. Redeploy Retell prompt (cross-account booking section removed)
5. Run `npx tsx tests/buildops/test_job_creation.ts` against production to confirm end-to-end

---

## How the Flow Works After the Fix

```
call_inbound  →  session created (UUID, since Retell sends no call_id at inbound time)
call_started  →  findActiveByCallerAndTenant (normalized phone match, ordered by created_at)
               →  session found → updateRetellCallId(UUID → real Retell call_id)
prepare_job   →  getInboundCall(real call_id) → FOUND → job created ✓
call_ended    →  setCallStatus(real call_id → 'ended') → FOUND → session closed ✓
               →  no more stale active sessions
```

---

## Cross-Account Booking Flow (also shipped)

Recognized caller asks to book for a different company:

1. Agent calls `lookup_customer_fuzzy` with the other company's name + address
2. `handleLookupFuzzy` calls `setMatchedCustomer(session, newCustomerId)` — overwrites session
3. `prepare_job` creates job under the new customer's account
4. `add_representative` (when `new_number_detected: true`) adds caller's phone to new account

All three backend handlers already supported this correctly; only the session resolution bug
and the prompt guidance were missing.
