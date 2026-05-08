# Clara ↔ BuildOps — Inbound Call Flow (v1)

Confirmed spec: Crockett. Implementation date: 2026-05-08.

---

## Overview

```
Caller dials inbound number
        │
        ▼
call_inbound webhook → phone lookup (primary + alternate)
        │
   ┌────┴────────────────────┐
found (1 match)        not_found / multiple
auto-confirm           tiered fuzzy search (Phase 1)
        │
        ▼
Phase 2 — Property Resolution
        │
        ▼
Phase 3 — Job details collected + confirmed during call
        │
call_ended webhook → jobs + tasks created in BuildOps
```

---

## Phase 1 — Caller Identification

### a. Phone lookup at `call_inbound`

The Retell `call_inbound` webhook fires before the agent speaks. We immediately:

1. Resolve tenant from `to_number` via `inbound_no_to_tenant_resolution`
2. Normalize `from_number` to last-10 digits
3. Query `customers` table on **both** `normalized_phone_primary` AND `normalized_phone_secondary` (= BuildOps `phoneAlternate`)

| Outcome | `status` dynamic var | Side effect |
|---|---|---|
| 0 matches | `not_found` | none — agent starts Tier 1 |
| 1 match | `found` | `matchedCustomerId` auto-set in session |
| 2+ matches | `multiple_matches` | candidates returned; agent disambiguates via `confirm_customer` |

Dynamic variables returned to Retell agent:

```
status, identified, confidence, customer_id, customer_name,
from_number, new_number_detected, address_count, addresses, multiple_matches
```

### b. Tiered fuzzy search (when phone not matched)

Agent asks progressively — each tier calls `lookup_customer_fuzzy`:

| Tier | What agent asks | Args passed |
|---|---|---|
| 1 | "Can I get the name on the account?" | `name` |
| 2 | "What's the address for the service location?" | `address` |
| 3 | "What's the zip code or street number?" | `zip` |
| — | Still no match → "I'm not finding that account in our system" | agent ends or transfers |

`lookup_customer_fuzzy` scoring (Jaro-Winkler + Soundex + token-set):

- **≥ 0.90 AND gap ≥ 0.10** → `found` (auto-confirm, set `matchedCustomerId`)
- **0.75–0.89 OR gap < 0.10** → `multiple_matches` (top 3 candidates returned)
- **< 0.75** → `not_found`

### c. Caller from a different number

When `lookup_customer_fuzzy` finds a match but the caller's `from_number` is not on the customer's account:

```json
{ "new_number_detected": true }
```

Agent offers: *"Would you like to save this number to your account?"*

- Yes → agent calls `save_caller_number` → creates representative row with caller's phone
- No → proceed without saving

---

## Phase 2 — Property / Location Resolution

### a. Single property
Agent reads back the address and proceeds directly to Phase 3.

### b. Multiple properties — existing location (2B)

Agent calls `get_properties_for_customer`, then uses `match_property` with tiered disambiguation:

| Tier | Mechanism |
|---|---|
| 1 | Caller says address naturally → `match_property` (token-set ratio ≥ 0.60, gap ≥ 0.15) |
| 2 | Partial mention ("the one on Main") → token-set + city/zip bonus |
| 3 | "What's the zip code?" → zip resolves ambiguity between properties |
| 4 | Numbered list read-back → caller says "first" or "second" |

### c. New location (2A)
Agent transfers call directly to on-call manager via Retell transfer. No backend function needed.

### d. Add new contact/representative (2C)

Agent collects name + phone for the new contact and calls `add_representative`.

```json
{ "first_name": "...", "last_name": "...", "phone": "...", "email": "...", "property_id": "..." }
```

---

## Phase 3 — Job Creation (post-call)

**Job creation fires in `call_ended`, not during the conversation.** This ensures the caller confirms everything before anything is written to BuildOps.

### In-call flow

1. Agent collects job details: property, job type, pricebook item, status
2. Agent collects any task details and asks for explicit confirmation per task
3. Agent calls `prepare_job` with all confirmed details (including `tasks` array)
4. `prepare_job` validates the params + checks live account status in BuildOps
5. If valid, stores a `PendingJobData` entry in `inbound_calls.pending_jobs` (JSONB array)
6. Returns a summary for agent to read back to caller:

```json
{
  "status": "ready",
  "summary": {
    "property_address": { "line1": "...", "city": "...", "zip": "..." },
    "job_type": "HVAC Repair",
    "job_status": "Open",
    "task_count": 2
  }
}
```

7. Caller confirms → call ends

### Multiple jobs

If the caller requests multiple jobs, agent calls `prepare_job` once per job. Each call appends to the `pending_jobs` array. Jobs are collected and confirmed sequentially (one at a time).

### Post-call execution (call_ended webhook)

```
for each job in inbound_calls.pending_jobs:
  1. createJob(BuildOps API) → jobId, jobNumber
  2. upsertJob(local Supabase mirror)
  3. setJobCreated(inbound_calls)
  4. for each task in job.tasks:
       createTask(BuildOps API, jobId, task.name, task.entries)
```

### Blocked accounts

`prepare_job` performs a live `GET /v1/customers/{id}` check before storing anything. Blocked statuses: `creditHold`, `inactive`, `suspended`, `collections`. If blocked, returns an error message — nothing is stored and no job is created.

### Graceful exit

If the caller indicates they don't want a job at any point, the agent ends the call without calling `prepare_job`. No pending job data is stored, so `call_ended` creates nothing.

---

## Retell Function Inventory (v1)

| Function | Handler file | Phase | Notes |
|---|---|---|---|
| *(auto at call_inbound)* | `retell/index.ts` | 1a | Phone lookup, auto-sets customer on single match |
| `lookup_customer_fuzzy` | `handlers/fuzzy-lookup.ts` | 1 Tiers 1–3 | Returns `new_number_detected` when caller phone not on account |
| `confirm_customer` | `handlers/customer.ts` | 1 (multi-match) | Agent picks candidate when 2+ phone matches |
| `save_caller_number` | `handlers/representative.ts` | 1 (post-fuzzy) | Saves caller's phone as representative |
| `get_properties_for_customer` | `handlers/customer.ts` | 2 | Returns all service locations for matched customer |
| `match_property` | `handlers/customer.ts` | 2B | Fuzzy-matches spoken address to known properties |
| `add_representative` | `handlers/representative.ts` | 2C | Creates named contact with phone/email |
| `get_pricebook_items` | `handlers/pricebook.ts` | 3 prep | Search pricebook by keyword |
| `get_job_types` | `handlers/job-types.ts` | 3 prep | List job types from BuildOps API |
| `get_departments` | `handlers/job-types.ts` | 3 prep | List departments from Supabase |
| `prepare_job` | `handlers/job.ts` | 3 | Validate + store pending job (with tasks). Replaces `create_job`. |

**Removed from agent:** `create_job` (replaced by `prepare_job`). `add_task_to_job` is kept internally for admin use but not exposed to the Retell agent — tasks are embedded in `prepare_job.tasks`.

---

## Standard Customer-Lookup Response Shape

All customer-identification functions return this consistent shape:

```json
{
  "status": "found | not_found | multiple_matches",
  "identified": true,
  "confidence": 0.95,
  "customer_id": "uuid or null",
  "customer_name": "Acme Corp or null",
  "new_number_detected": false
}
```

---

## Database — `inbound_calls` Table Changes

**Migration required:**
```sql
ALTER TABLE inbound_calls
  ADD COLUMN IF NOT EXISTS pending_jobs JSONB DEFAULT '[]'::jsonb;
```

`pending_jobs` stores an ordered array of `PendingJobData` objects written by `prepare_job` during the call. The `call_ended` handler reads this array and executes each job sequentially.

---

## Verification Checklist

| # | Test | Expected |
|---|---|---|
| 1 | Run Supabase migration | `pending_jobs` column exists on `inbound_calls` |
| 2 | `call_inbound` with known phone | `status: found`, `matchedCustomerId` set in DB |
| 3 | `call_inbound` with unknown phone | `status: not_found`, no `matchedCustomerId` |
| 4 | `lookup_customer_fuzzy` (name match, different phone) | `new_number_detected: true` |
| 5 | `save_caller_number` | Representative row created in DB |
| 6 | `get_properties_for_customer` — 1 property | Agent proceeds directly |
| 7 | `match_property` — ambiguous address | `status: ambiguous`, top 2 candidates returned |
| 8 | `prepare_job` — valid params | `pending_jobs` array has 1 entry; summary returned |
| 9 | `prepare_job` — second call (multi-job) | `pending_jobs` array has 2 entries |
| 10 | `call_ended` | Both jobs + tasks created in BuildOps; `buildops_job_id` set |
| 11 | `prepare_job` — blocked account | Returns blocked error; `pending_jobs` unchanged |
| 12 | `add_representative` | Representative row created linked to matched customer |
