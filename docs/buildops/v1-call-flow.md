# Clara ↔ BuildOps — Inbound Call Flow (v1)

Confirmed spec: Crockett. Implementation date: 2026-05-08.

---

## Overview

```
Caller dials inbound number
        │
        ▼
call_inbound webhook → phone lookup (customers + representatives)
        │
   ┌────┴────────────────────────┐
found (1 match)             not_found / multiple
auto-confirm                tiered fuzzy search
        │                        │
        └──────────┬─────────────┘
                   ▼
        Phase 2 — Property Resolution
                   │
                   ▼
        Phase 3 — Job intake (prepare_job during call)
                   │
        call_ended webhook → createJob in BuildOps
```

---

## Webhook Endpoint

```
POST /api/buildops/retell/webhook
```

Retell sends all events here. The server routes on `body.event`:

| `event` value | What it means |
|---|---|
| `call_inbound` | Call just arrived — respond with dynamic variables |
| `call_ended` | Call finished — execute pending jobs in BuildOps |
| `tool_call` / `agent_function` | Agent called a custom function — run handler, return result |

---

## Stage 1 — `call_inbound` arrives

Retell sends:

```json
{
  "event": "call_inbound",
  "call": {
    "call_id": "call_abc123",
    "from_number": "+12145551234",
    "to_number": "+18005550111",
    "agent_id": "agent_xxx"
  }
}
```

Backend immediately:

1. Resolve tenant from `to_number` via `buildops_tenants` table
2. Create `inbound_calls` row with `call_id`, `tenant_id`, `caller`, `receiver`
3. Normalize `from_number` to last-10 digits
4. Search `customers` table on `normalized_phone_primary` and `normalized_phone_secondary`

---

## Stage 2 — Phone lookup outcomes

### Case A — One customer found

Backend sets `matchedCustomerId` in session and responds:

```json
{
  "call_inbound": {
    "override_agent_id": "<retell_llm_id>",
    "dynamic_variables": {
      "status": "found",
      "identified": "true",
      "confidence": "1.0",
      "customer_id": "cust_123",
      "customer_name": "ABC Fire Protection",
      "from_number": "+12145551234",
      "new_number_detected": "false",
      "address_count": "3",
      "addresses": "[{\"line1\":\"123 Main St\",...}]",
      "multiple_matches": "false",
      "property_count": "2",
      "property_id": ""
    }
  }
}
```

Agent opens with:

> "Hi, thanks for calling. I found your account under ABC Fire Protection."

### Case B — No customer found

```json
{
  "call_inbound": {
    "dynamic_variables": {
      "status": "not_found",
      "identified": "false",
      "confidence": "0",
      "customer_id": "",
      "customer_name": "",
      "from_number": "+12145551234",
      "new_number_detected": "true",
      "address_count": "0",
      "addresses": "[]",
      "multiple_matches": "false"
    }
  }
}
```

Agent opens with:

> "Hi, thanks for calling. I couldn't find this number on an existing account. Could you share the registered customer or company name and the property or site address?"

### Case C — Multiple customers found

```json
{
  "call_inbound": {
    "dynamic_variables": {
      "status": "multiple_matches",
      "identified": "false",
      "confidence": "0",
      "customer_id": "",
      "customer_name": "",
      "from_number": "+12145551234",
      "new_number_detected": "false",
      "address_count": "0",
      "addresses": "[{\"name\":\"ABC Fire\",\"id\":\"...\"},{...}]",
      "multiple_matches": "true"
    }
  }
}
```

Agent asks caller to confirm which account.

---

## Stage 3 — Agent starts (Retell reads dynamic variables)

The agent prompt references these via `{{variable_name}}` syntax:

| Variable | Example value |
|---|---|
| `{{status}}` | `found` / `not_found` / `multiple_matches` |
| `{{customer_id}}` | `cust_123` |
| `{{customer_name}}` | `ABC Fire Protection` |
| `{{from_number}}` | `+12145551234` |
| `{{new_number_detected}}` | `true` / `false` |
| `{{address_count}}` | `3` |
| `{{multiple_matches}}` | `true` / `false` |
| `{{property_count}}` | `2` |
| `{{property_id}}` | UUID or empty string — pre-filled only when `property_count = 1` |

The agent branches on `{{status}}` immediately — no need to ask for company name when `status = found`.

---

## Stage 4 — Known customer path (status = found)

Agent skips "which customer?" entirely and moves to property resolution.

**If `{{property_count}} = 1`** — property is already known; agent uses `{{property_id}}` directly as `customer_property_id` in `prepare_job`. No address question needed.

**If `{{property_count}} > 1`** — agent asks:

> "Which property or site address is this for?"

Then calls `match_property`:

```json
{
  "spoken_address": "123 Main Street"
}
```

Property match outcomes:

| Result | Agent action |
|---|---|
| `matched` | Confirm address: "Got it, I have the site as 123 Main Street in Dallas. Is that correct?" |
| `ambiguous` | Read candidates: "I found two close matches: 123 Main St Dallas and 123 Main Ave Plano. Which one?" |
| `not_found` (`address_not_matched`) | Transfer: "I'm not finding that address on the account. Let me connect you with someone who can help." |

---

## Stage 5 — Unknown phone path (status = not_found)

Agent collects:
- `registered_name` — company or customer name on the account
- `property_address` — the service location address

Then calls `lookup_customer_fuzzy`.

---

## Stage 6 — Fuzzy lookup

Function: `lookup_customer_fuzzy`

```json
{
  "name": "ABC Fire Protection",
  "address": "123 Main Street Dallas",
  "property_address": "123 Main Street Dallas",
  "zip": "75001",
  "old_phone": "2145559999"
}
```

Backend pipeline:

1. Search `customers` by name (ilike) and/or `addresses` JSONB zip filter
2. Search `property` table by `address->>line1` ilike when address provided
3. Compute 15 match signals for each candidate
4. Assign confidence tier (1 / 2 / 3) via rule-based logic
5. Apply cross-validation gate on Tier 1 winner
6. Return `found` / `multiple_matches` / `not_found`

---

## Stage 7 — Fuzzy matching logic

### Similarity algorithms

Two algorithms score string similarity on a 0–1 scale:

**Token (Jaccard)** — word overlap ratio. Good when words are present but order differs.  
**Bigram (Dice)** — 2-character substring overlap. Good for character-level transcription errors (`"Diversetec"` vs `"DIVERSATEK"`).

`fuzzySimilarity()` returns `max(token, bigram)` — whichever gives a higher score.

**Address similarity** adds two shortcuts before fuzzy scoring:
- Exact match after USPS normalization → 1.0
- One address contains the other as a substring → 0.9

**Address query match** generates variants (strip direction prefix, strip street suffix) and checks for an exact hit. Catches `"123 N Main St"` vs `"123 North Main Street"`.

### 20 match signals per candidate

For each candidate the backend computes:

| Signal | Type | Description |
|---|---|---|
| `phoneExact` | bool | Caller's phone or old_phone is in customer's `all_numbers` |
| `locationNameExact` | bool | Query name exactly matches customer name (normalized) |
| `locationNameFuzzy` | 0–1 | Fuzzy score for query name vs customer name |
| `companyNameExact` | bool | Same as locationNameExact (company = customer in BuildOps) |
| `companyNameFuzzy` | 0–1 | Same as locationNameFuzzy |
| `companyNamePrefixMatch` | bool | First 5 characters of query name match customer name |
| `locationNameMatchesCompany` | bool | Cross-field: query name = customer name |
| `locationNameMatchesCompanyFuzzy` | 0–1 | Fuzzy version of above |
| `companyNameMatchesLocation` | bool | Same as locationNameMatchesCompany |
| `addressSimilarity` | 0–1 | Best score across all billing + property addresses |
| `addressQueryMatch` | bool | Strict address variant hit (strips direction/suffix, checks substring) |
| `addressMatch` | bool | queryMatch OR similarity > threshold (0.6 with name, 0.75 without) |
| `nameSimilarity` | 0–1 | Caller contact name (reserved, not yet collected) |
| `locationsForCompany` | int | Candidates with the same customer name |
| `locationsForExactPhone` | int | Candidates sharing the query phone |
| `nameMatchStrong` | bool | Full name given and last-name exact + first fuzzy ≥0.75, OR full fuzzy ≥0.75 |
| `nameMatchWeak` | bool | First-name-only query with first token fuzzy ≥0.8 |
| `nameMismatch` | bool | Full name given, address matches, but full fuzzy < 0.65 |
| `queryHasFullName` | bool | Query name contains 2+ tokens |
| `queryHasFirstNameOnly` | bool | Query name is a single token |

### Tier assignment

Signals feed a rule-based tier assignment. First rule that matches wins.

**Tier 1 — high confidence → job auto-created**

| Rule | Signals required |
|---|---|
| `address_and_strong_name_match` | addressQueryMatch + nameMatchStrong |
| `phone_and_address_match` | phoneExact + addressMatch |
| `location_name_and_address_match` | locationNameExact + addressMatch |
| `phone_match_single_location` | phoneExact + locationsForExactPhone = 1 |
| `location_and_company_exact` | nameExact + locationsForCompany = 1 |
| `location_as_company_single_location` | nameMatchesCompany + locationsForCompany = 1 |
| `phone_match_with_address_similarity` | phoneExact + addressSimilarity > 0.5 |
| *(+ 4 more combining fuzzy/prefix signals with address)* | |

**Tier 2 — medium confidence → job created + manual review**

| Rule | Signals required |
|---|---|
| `address_and_weak_name_match` | addressQueryMatch + nameMatchWeak (first-name-only) |
| `address_query_match` | addressQueryMatch + no name given |
| `phone_match_multiple_locations` | phoneExact + locationsForExactPhone > 1 |
| `company_and_address_exact_no_location` | nameExact + addressMatch |
| `location_name_exact` | locationNameExact alone |
| `company_fuzzy_and_address` | companyNameFuzzy > 0.6 + addressMatch |
| *(+ 7 more)* | |

**Tier 3 — low confidence → no job, transfer**

Weak signals only. Also includes `address_match_name_mismatch` — address found but full name given clearly doesn't match (nameMismatch signal).

**Pre-tree short-circuit — `name_address_mismatch`**

Before tier assignment, if the query contains a full name AND an address, and every address-matching candidate has `nameMismatch = true`, the lookup returns `not_found / name_address_mismatch` immediately and sets the call to `handed_off`. This catches the case where a caller gives a wrong name for a known address.

### Cross-validation gate (Tier 1 only)

Even a Tier 1 candidate is rejected if the caller provided name or address that doesn't agree with the match:

- Name provided → `companyNameFuzzy ≥ 0.6` OR `locationNameFuzzy ≥ 0.75` must hold
- Address provided → `addressMatch` OR `addressSimilarity ≥ 0.75` must hold
- Failure reasons: `retell_data_mismatch`, `ambiguous_phone_mapping`

---

## Stage 8 — Fuzzy confidence outcomes and agent handling

### Outcome 1 — Tier 1 found (`requires_review: false`)

```json
{
  "status": "found",
  "identified": true,
  "confidence_tier": 1,
  "requires_review": false,
  "customer_id": "cust_123",
  "customer_name": "ABC Fire Protection",
  "new_number_detected": true,
  "address": { "line1": "123 Main St", "city": "Dallas" },
  "tier_reason": "location_name_and_address_match",
  "property_count": 2,
  "property_id": ""
}
```

Agent proceeds directly to property resolution. If `property_count = 1`, `property_id` is present — skip `match_property` and call `prepare_job` directly.

### Outcome 2 — Tier 2 found (`requires_review: true`)

```json
{
  "status": "found",
  "identified": true,
  "confidence_tier": 2,
  "requires_review": true,
  "customer_id": "cust_123",
  "customer_name": "ABC Fire Protection",
  "new_number_detected": false,
  "address": { "line1": "123 Main St", "city": "Dallas" },
  "tier_reason": "company_fuzzy_and_address",
  "property_count": 1,
  "property_id": "prop_789"
}
```

Agent proceeds to job creation **and passes `needs_review: true` to `prepare_job`**. Job is flagged for manual review.

> "I've found your account — I'll get your request logged and our team will confirm the details."

### Outcome 3 — multiple_matches

```json
{
  "status": "multiple_matches",
  "identified": false,
  "candidates": [
    { "id": "cust_123", "name": "ABC Fire Protection", "address": {...}, "tier_reason": "location_name_exact" },
    { "id": "cust_456", "name": "ABC Fire & Safety",   "address": {...}, "tier_reason": "company_fuzzy_and_address" }
  ]
}
```

When all candidates matched on first-name only (e.g. caller said "Rahul" and there are multiple Rahuls at the same address), the response also includes `"message": "need_last_name"`:

```json
{
  "status": "multiple_matches",
  "identified": false,
  "message": "need_last_name",
  "candidates": [...]
}
```

Agent reads candidates and asks caller to confirm. After confirmation, calls `confirm_customer`.

### Outcome 4 — not_found

```json
{
  "status": "not_found",
  "identified": false,
  "message": "no_matches | low_confidence_matches | name_address_mismatch | retell_data_mismatch | ambiguous_phone_mapping"
}
```

| Message | Agent action |
|---|---|
| `no_matches` | Transfer immediately |
| `low_confidence_matches` | Ask once more for name + address; if still fails, transfer |
| `name_address_mismatch` | Transfer — address was found but the name given doesn't match any account at that address |
| `retell_data_mismatch` | Transfer with apology |
| `ambiguous_phone_mapping` | Transfer with apology |

---

## Stage 8b — Agent instruction set for fuzzy matching

Add these rules to the Retell LLM agent's system prompt:

```
## Customer Identification — Fuzzy Lookup Rules

### status = "found", confidence_tier = 1 (requires_review = false)
- High confidence. Proceed to property resolution (see Property Resolution Rules).
- Do NOT mention confidence level to the caller.

### status = "found", confidence_tier = 2 (requires_review = true)
- Medium confidence. Proceed with job creation, but ALWAYS pass needs_review: true
  as an argument when calling prepare_job.
- Say: "I've found your account — I'll get your request logged and our team will
  confirm the details."
- Do NOT say "medium confidence" or "needs review" to the caller.

### status = "multiple_matches", no message field
- Read candidate names/addresses to the caller:
  "I found a few accounts that could match — could you tell me which one is yours?
   Option 1: [name, address]. Option 2: [name, address]..."
- Call confirm_customer with the candidate_id the caller selects.
- After confirmation, proceed to property resolution.

### status = "multiple_matches", message = "need_last_name"
- Multiple accounts share the same first name at the same address.
- Ask: "I found more than one [first name] at that address. Could you confirm the
  last name on the account?"
- Re-call lookup_customer_fuzzy with the full name provided.

### status = "not_found", message = "no_matches"
- Say: "I wasn't able to find an account matching your information. Let me connect
  you with someone who can help."
- Call transfer_call with reason "no_matches", then transfer.

### status = "not_found", message = "low_confidence_matches"
- Try once more: "Could you give me the exact company name and the service address
  on the account?"
- If the retry still returns not_found → call transfer_call with reason
  "low_confidence", then transfer.

### status = "not_found", message = "name_address_mismatch"
- The address was found in the system but the name given doesn't match any account
  at that address.
- Say: "I want to make sure I have the right account. Let me connect you with a
  team member."
- Call transfer_call with reason "name_address_mismatch", then transfer.

### status = "not_found", message = "retell_data_mismatch" or "ambiguous_phone_mapping"
- Say: "I want to make sure I have the right account. Let me connect you with a
  team member."
- Call transfer_call with reason from the message field, then transfer.

## Property Resolution Rules

### property_count = 1 (property_id is set)
- Service address is unambiguous. Use property_id directly as customer_property_id
  in prepare_job. Do NOT ask for the address or call match_property.

### property_count > 1
- Ask: "Which property or site address is this for?"
- Call match_property with the spoken address.
- matched → confirm address with caller, then call prepare_job.
- ambiguous → read the top candidates: "I found two close matches: [addr1] and
  [addr2]. Which one is the service location?"
- not_found (address_not_matched) → say "I'm not finding that address on the
  account. Let me connect you with someone who can help." and transfer.
```

---

## Stage 9 — Save new number (after customer + property confirmed)

Triggered only when `new_number_detected = true` AND customer is confirmed.

Agent:

> "I noticed you're calling from a number not saved on the account. Would you like me to save it for future calls?"

If yes, collect caller's first and last name, then call `add_representative`:

```json
{
  "first_name": "John",
  "last_name": "Smith",
  "phone": "+12145551234"
}
```

Omit `phone` to default to the caller's `from_number`. `property_id` can optionally be included to associate the rep with a specific service location.

If caller name is unknown, agent asks: "What name should I save this under?"

Numbers for the same name are stored as separate representative records suffixed numerically: `JohnSmith1`, `JohnSmith2`, etc.

---

## Stage 10 — Job intake

Fields filled automatically (never ask caller):

| Field | Source |
|---|---|
| `customerId` | from phone/fuzzy lookup |
| `customerPropertyId` | from property resolution |
| `jobTypeId` | default: Time and Material |
| `departmentId` | default: D2 Service Calls (T&M) |
| `isUseTaxable` | from customer record |
| `priceBookId` | from customer record |

Agent only asks:

1. **Issue description** — "What's the issue you're calling about?"
2. **Due date** — "When do you need this completed?"

Company and property are only asked if not already resolved.

---

## Stage 11 — prepare_job (during call)

Function: `prepare_job`

```json
{
  "customer_property_id": "prop_456",
  "job_type_id": "TIME_AND_MATERIAL_JOB_TYPE_ID",
  "department_id": "D2_SERVICE_CALLS_TM_DEPARTMENT_ID",
  "issue_description": "Sprinkler system leaking near warehouse entrance.",
  "due_date": "2026-05-12"
}
```

Backend:

1. Validates `customerPropertyId` belongs to the confirmed customer
2. Fetches `isUseTaxable` and `priceBookId` from customer record
3. Checks customer account status — blocked statuses (`creditHold`, `inactive`, `suspended`, `collections`) abort with error
4. Stores `PendingJobData` in `inbound_calls.pending_jobs` JSONB array
5. Returns summary for agent to read back

Response:

```json
{
  "status": "ready",
  "summary": {
    "customer_name": "ABC Fire Protection",
    "property_address": "123 Main Street, Dallas, TX 75001",
    "job_type": "Time and Material",
    "department": "D2 Service Calls (T&M)",
    "issue_description": "Sprinkler system leaking near warehouse entrance",
    "due_date": "2026-05-12"
  }
}
```

---

## Stage 12 — Final confirmation

Agent reads back the summary:

> "Just to confirm: ABC Fire Protection at 123 Main Street in Dallas. Sprinkler system leaking near the warehouse entrance, needed by May 12th. Is that correct?"

If yes → call ends.  
If no → agent updates the relevant field and calls `prepare_job` again.

---

## Stage 13 — Graceful call ending

Agent does not say "I created the job" — the job is not created yet.

> "Thanks, I've captured the service request and will pass it to the team now. Have a good day."

---

## Stage 14 — call_ended webhook creates BuildOps job

Retell sends `event: "call_ended"`. Backend:

1. Loads `inbound_calls` row by `call_id`
2. If `pending_jobs` is empty, does nothing
3. For each entry in `pending_jobs`:
   - `POST /v1/jobs` → gets `jobId`, `jobNumber`
   - Upserts into local `jobs` mirror
   - Sets `buildops_job_id` on `inbound_calls`
   - Creates any associated tasks
4. On failure — logs error, sends failure notification (job is not silently dropped)

---

## Retell Function Inventory

These are the 5 custom webhook functions configured in the Retell agent. All route to `POST /api/buildops/retell/webhook`.

| Function name | Handler | When called |
|---|---|---|
| *(auto at call_inbound)* | `retell/index.ts` | Phone lookup, sets dynamic vars including `property_count` + `property_id` |
| `lookup_customer_fuzzy` | `handlers/fuzzy-lookup.ts` | Phone not matched — agent collects name/address; returns `property_count` + `property_id` on match |
| `confirm_customer` | `handlers/customer.ts` | Multiple phone or fuzzy candidates; returns `property_count` + `property_id` |
| `match_property` | `handlers/customer.ts` | Spoken address → property UUID when `property_count > 1`; `not_found` triggers transfer |
| `prepare_job` | `handlers/job.ts` | Validate + store pending job; requires `customer_property_id` |
| `add_representative` | `handlers/representative.ts` | New number detected — creates rep in BuildOps to save number |

---

## Setting Up Custom Functions in Retell

### 1. Set the webhook URL

In the Retell dashboard, go to your **LLM Agent → General Settings**:

```
Webhook URL: https://<your-domain>/api/buildops/retell/webhook
```

This single URL receives all events: `call_inbound`, `call_ended`, and all function calls.

### 2. Add dynamic variables

In **LLM Agent → Dynamic Variables**, declare every variable your prompt uses:

| Variable name | Type | Default |
|---|---|---|
| `status` | string | `not_found` |
| `identified` | string | `false` |
| `confidence` | string | `0` |
| `customer_id` | string | *(empty)* |
| `customer_name` | string | *(empty)* |
| `from_number` | string | *(empty)* |
| `new_number_detected` | string | `false` |
| `address_count` | string | `0` |
| `addresses` | string | `[]` |
| `multiple_matches` | string | `false` |
| `property_count` | string | `0` |
| `property_id` | string | *(empty)* |

Use them in your agent prompt as `{{variable_name}}`.

### 3. Add each custom function

In **LLM Agent → Functions**, click **Add Function** for each one below.

For every function, set:
- **Webhook** — same URL as above (`/api/buildops/retell/webhook`)
- **Async** — `false` (all are synchronous — agent waits for the result)

---

The full Retell JSON spec (paste into `retellLlmData.general_tools`) is in `docs/buildops/retell-agent-spec.json`.

#### `lookup_customer_fuzzy`

Search for a customer by name, address, zip, or old phone when the caller's current number wasn't recognized. At least one of `name`, `address`, `property_address`, or `zip` required. Returns `property_count` and `property_id` on a successful match.

---

#### `confirm_customer`

Confirm which customer the caller belongs to after a `multiple_matches` response. Requires `candidate_id` (the `id` from the chosen candidate). Returns `property_count` and `property_id` so the agent knows whether to call `match_property`.

---

#### `match_property`

Fuzzy-match a spoken service address against the confirmed customer's properties to get the `property_id` needed for `prepare_job`. Only call when `property_count > 1`. Requires `spoken_address`.

Responses:
- `matched` → `property_id` available, proceed to `prepare_job`
- `ambiguous` → read top candidates back to caller, ask them to confirm
- `not_found` (`address_not_matched`) → call status set to `handed_off`, agent transfers

---

#### `prepare_job`

Queue a job for BuildOps creation post-call. Requires `customer_property_id` (from `match_property` or directly from `property_id` when `property_count = 1`). Pass `needs_review: true` when the customer was a Tier 2 match.

---

#### `add_representative`

Create a representative in BuildOps to save the caller's new number. Invoke when `new_number_detected = true`. Requires `first_name` and `last_name`. `phone` defaults to the caller's `from_number` if omitted.

---

### 4. Configure `call_inbound` response

In **LLM Agent → General Settings**, enable **Custom `call_inbound` response**. This tells Retell to wait for your webhook to return dynamic variables before starting the agent.

Your webhook response shape:

```json
{
  "call_inbound": {
    "override_agent_id": "<optional — set if routing to different agent>",
    "dynamic_variables": {
      "status": "found",
      "customer_name": "ABC Fire Protection",
      ...
    }
  }
}
```

### 5. Reference functions in the agent prompt

In the agent prompt, refer to functions by name. Example:

```
If {{status}} is "not_found", ask the caller for their company name and 
service address, then call lookup_customer_fuzzy.

If {{status}} is "found", greet the caller using {{customer_name}} and 
proceed to property resolution.
```

Retell passes function results back to the LLM as the tool response — no extra parsing needed.

---

## Standard Response Shape

All customer identification functions return a consistent shape on success:

```json
{
  "status": "found | not_found | multiple_matches",
  "identified": true,
  "confidence_tier": 1,
  "requires_review": false,
  "customer_id": "uuid or null",
  "customer_name": "Acme Corp or null",
  "new_number_detected": false,
  "address": { "line1": "...", "city": "...", "state": "...", "zip": "..." },
  "tier_reason": "phone_and_address_match",
  "property_count": 2,
  "property_id": ""
}
```

`confidence_tier` is `1` (auto-create job) or `2` (create + manual review). `property_id` is only populated when `property_count = 1` — the agent should use it directly as `customer_property_id` in `prepare_job` without calling `match_property`. `not_found` responses omit these fields and include a `message` reason code instead.

---

## Database — Required Migration

```sql
ALTER TABLE inbound_calls
  ADD COLUMN IF NOT EXISTS pending_jobs JSONB DEFAULT '[]'::jsonb;
```

`pending_jobs` stores an ordered array of `PendingJobData` written by `prepare_job`. The `call_ended` handler reads it and creates each job sequentially in BuildOps.

---

## Verification Checklist

| # | Test | Expected |
|---|---|---|
| 1 | `call_inbound` with known phone, 1 property | `status: found`, `property_count: "1"`, `property_id` set, agent skips `match_property` |
| 2 | `call_inbound` with known phone, 2+ properties | `status: found`, `property_count: "2"`, `property_id: ""`, agent calls `match_property` |
| 3 | `call_inbound` with unknown phone | `status: not_found`, agent asks for name + address |
| 4 | `call_inbound` with phone matching 2+ customers | `status: multiple_matches`, agent calls `confirm_customer` |
| 5 | `lookup_customer_fuzzy` — full name + address, strong match | `status: found`, `confidence_tier: 1` |
| 6 | `lookup_customer_fuzzy` — full name + address, name mismatches all address-matching records | `status: not_found`, `message: name_address_mismatch`, call handed off |
| 7 | `lookup_customer_fuzzy` — first name only + address, multiple candidates | `status: multiple_matches`, `message: need_last_name`, agent asks for last name |
| 8 | `lookup_customer_fuzzy` — new phone detected | `new_number_detected: true`, agent offers to save via `add_representative` |
| 9 | `confirm_customer` — valid candidate | `status: confirmed`, `property_count` + `property_id` returned |
| 10 | `match_property` — confident single match | `status: matched`, `property_id` returned |
| 11 | `match_property` — two close scores | `status: ambiguous`, top candidates returned, agent reads back to caller |
| 12 | `match_property` — no match (new/unknown address) | `status: not_found`, call set to `handed_off`, agent transfers |
| 13 | `add_representative` — same name twice | Second record stored as `JohnSmith2` |
| 14 | `prepare_job` — blocked account | Returns blocked error, `pending_jobs` unchanged |
| 15 | `prepare_job` — valid, Tier 2 match | `pending_jobs` has 1 entry with `needsReview: true` |
| 16 | `prepare_job` — called twice (multi-job) | `pending_jobs` has 2 entries |
| 17 | `call_ended` | Jobs + tasks created in BuildOps, `buildops_job_id` set |
| 18 | `call_ended` — no pending jobs | No-op |
