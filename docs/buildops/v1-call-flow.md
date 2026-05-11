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
      "multiple_matches": "false"
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

The agent branches on `{{status}}` immediately — no need to ask for company name when `status = found`.

---

## Stage 4 — Known customer path (status = found)

Agent skips "which customer?" entirely and moves to property resolution:

> "Which property or site address is this for?"

Then calls `match_property`:

```json
{
  "customer_id": "cust_123",
  "spoken_address": "123 Main Street"
}
```

Property match outcomes:

| Result | Agent says |
|---|---|
| `matched` | "Got it, I have the site as 123 Main Street in Dallas. Is that correct?" |
| `ambiguous` | "I found two close matches: 123 Main St Dallas and 123 Main Ave Plano. Which one?" |
| `no_match` | "I'm not finding that site. Let me connect you with someone who can help." |

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

### 15 match signals per candidate

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
| `addressQueryMatch` | bool | Strict address variant hit |
| `addressMatch` | bool | queryMatch OR similarity > threshold (0.6 with name, 0.75 without) |
| `nameSimilarity` | 0–1 | Caller contact name (reserved, not yet collected) |
| `locationsForCompany` | int | Candidates with the same customer name |
| `locationsForExactPhone` | int | Candidates sharing the query phone |

### Tier assignment

Signals feed a rule-based tier assignment. First rule that matches wins.

**Tier 1 — high confidence → job auto-created**

| Rule | Signals required |
|---|---|
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
| `phone_match_multiple_locations` | phoneExact + locationsForExactPhone > 1 |
| `address_query_match` | addressQueryMatch alone |
| `company_and_address_exact_no_location` | nameExact + addressMatch |
| `location_name_exact` | locationNameExact alone |
| `company_fuzzy_and_address` | companyNameFuzzy > 0.6 + addressMatch |
| *(+ 7 more)* | |

**Tier 3 — low confidence → no job, transfer**

Weak signals only (name fuzzy > 0.7, address match without name, or no signal at all).

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
  "tier_reason": "location_name_and_address_match"
}
```

Agent proceeds directly to property resolution and job creation. No mention of confidence to the caller.

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
  "tier_reason": "company_fuzzy_and_address"
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

Agent reads candidates and asks caller to confirm. After confirmation, calls `confirm_customer`.

### Outcome 4 — not_found

```json
{
  "status": "not_found",
  "identified": false,
  "message": "no_matches | low_confidence_matches | retell_data_mismatch | ambiguous_phone_mapping"
}
```

| Message | Agent action |
|---|---|
| `no_matches` | Transfer immediately |
| `low_confidence_matches` | Ask once more for name + address; if still fails, transfer |
| `retell_data_mismatch` | Transfer with apology |
| `ambiguous_phone_mapping` | Transfer with apology |

---

## Stage 8b — Agent instruction set for fuzzy matching

Add these rules to the Retell LLM agent's system prompt:

```
## Customer Identification — Fuzzy Lookup Rules

### status = "found", confidence_tier = 1 (requires_review = false)
- High confidence. Proceed: get_properties_for_customer → match_property → prepare_job.
- Do NOT mention confidence level to the caller.

### status = "found", confidence_tier = 2 (requires_review = true)
- Medium confidence. Proceed with job creation, but ALWAYS pass needs_review: true
  as an argument when calling prepare_job.
- Say: "I've found your account — I'll get your request logged and our team will
  confirm the details."
- Do NOT say "medium confidence" or "needs review" to the caller.

### status = "multiple_matches"
- Read candidate names/addresses to the caller:
  "I found a few accounts that could match — could you tell me which one is yours?
   Option 1: [name, address]. Option 2: [name, address]..."
- Call confirm_customer with the candidate_id the caller selects.
- After confirmation, treat as confidence_tier = 1.

### status = "not_found", message = "no_matches"
- Say: "I wasn't able to find an account matching your information. Let me connect
  you with someone who can help."
- Call transfer_call with reason "no_matches", then transfer.

### status = "not_found", message = "low_confidence_matches"
- Try once more: "Could you give me the exact company name and the service address
  on the account?"
- If the retry still returns not_found → call transfer_call with reason
  "low_confidence", then transfer.

### status = "not_found", message = "retell_data_mismatch" or "ambiguous_phone_mapping"
- Say: "I want to make sure I have the right account. Let me connect you with a
  team member."
- Call transfer_call with reason from the message field, then transfer.
```

---

## Stage 9 — Save new number (after customer + property confirmed)

Triggered only when `new_number_detected = true` AND customer is confirmed.

Agent:

> "I noticed you're calling from a number not saved on the account. Would you like me to save it for future calls?"

If yes, call `save_caller_number`:

```json
{
  "phone_number": "+12145551234",
  "first_name": "John",
  "last_name": "Smith"
}
```

If caller name is unknown, agent asks: "What name should I save this under?"

Numbers for the same name are stored as separate representative records suffixed numerically: `Smith`, `Smith2`, `Smith3`, etc.

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

| Function name | Handler | When called |
|---|---|---|
| *(auto at call_inbound)* | `retell/index.ts` | Phone lookup, sets dynamic vars |
| `lookup_customer_fuzzy` | `handlers/fuzzy-lookup.ts` | Phone not matched — agent collects name/address |
| `confirm_customer` | `handlers/customer.ts` | Multiple phone matches or multiple fuzzy candidates |
| `get_properties_for_customer` | `handlers/customer.ts` | After customer confirmed, get service locations |
| `match_property` | `handlers/customer.ts` | Match spoken address to a known property |
| `save_caller_number` | `handlers/representative.ts` | New number detected, caller agrees to save |
| `add_representative` | `handlers/representative.ts` | Add a named contact to the account (blocking API call) |
| `get_pricebook_items` | `handlers/pricebook.ts` | Search pricebook by keyword |
| `get_job_types` | `handlers/job-types.ts` | List available job types |
| `get_departments` | `handlers/job-types.ts` | List departments |
| `prepare_job` | `handlers/job.ts` | Validate + store pending job; accepts `needs_review` flag |
| `transfer_call` | `handlers/transfer.ts` | Log transfer reason + mark session as transferred |

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

Use them in your agent prompt as `{{variable_name}}`.

### 3. Add each custom function

In **LLM Agent → Functions**, click **Add Function** for each one below.

For every function, set:
- **Webhook** — same URL as above (`/api/buildops/retell/webhook`)
- **Async** — `false` (all are synchronous — agent waits for the result)

---

#### `lookup_customer_fuzzy`

**Description:** Search for a customer by name, address, or zip when phone lookup failed.

**Parameters:**

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "description": "Customer or company name as stated by caller"
    },
    "address": {
      "type": "string",
      "description": "Customer billing or service address as stated by caller"
    },
    "property_address": {
      "type": "string",
      "description": "Property or site address as stated by caller"
    },
    "zip": {
      "type": "string",
      "description": "Zip code"
    },
    "old_phone": {
      "type": "string",
      "description": "A previously registered phone number for the account"
    }
  }
}
```

---

#### `confirm_customer`

**Description:** Confirm a specific customer when multiple candidates were returned.

**Parameters:**

```json
{
  "type": "object",
  "required": ["candidate_id"],
  "properties": {
    "candidate_id": {
      "type": "string",
      "description": "The customer ID selected by the caller"
    }
  }
}
```

---

#### `get_properties_for_customer`

**Description:** Get all service locations / properties for the confirmed customer.

**Parameters:**

```json
{
  "type": "object",
  "properties": {}
}
```

*(No arguments — uses the session's confirmed customer.)*

---

#### `match_property`

**Description:** Match a spoken site address to one of the customer's known properties.

**Parameters:**

```json
{
  "type": "object",
  "required": ["spoken_address"],
  "properties": {
    "spoken_address": {
      "type": "string",
      "description": "The address or site location as spoken by the caller"
    }
  }
}
```

---

#### `save_caller_number`

**Description:** Save the caller's current phone number as a representative on the account.

**Parameters:**

```json
{
  "type": "object",
  "properties": {
    "first_name": {
      "type": "string",
      "description": "First name to save with the phone number"
    },
    "last_name": {
      "type": "string",
      "description": "Last name to save with the phone number"
    },
    "phone_number": {
      "type": "string",
      "description": "Phone number to save — defaults to caller's number if omitted"
    }
  }
}
```

---

#### `add_representative`

**Description:** Add a new named contact to the customer account.

**Parameters:**

```json
{
  "type": "object",
  "required": ["first_name", "last_name"],
  "properties": {
    "first_name": { "type": "string" },
    "last_name": { "type": "string" },
    "phone": {
      "type": "string",
      "description": "Phone number for the contact"
    },
    "property_id": {
      "type": "string",
      "description": "Property ID to associate this contact with (optional)"
    }
  }
}
```

---

#### `match_property` (already above)

#### `get_pricebook_items`

**Description:** Search the customer's pricebook by keyword.

**Parameters:**

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "Keyword to search pricebook items by name or description"
    }
  }
}
```

---

#### `get_job_types`

**Description:** List available job types from BuildOps.

**Parameters:**

```json
{
  "type": "object",
  "properties": {}
}
```

---

#### `get_departments`

**Description:** List available departments.

**Parameters:**

```json
{
  "type": "object",
  "properties": {}
}
```

---

#### `prepare_job`

**Description:** Validate and store a pending job to be created in BuildOps after the call ends.

**Parameters:**

```json
{
  "type": "object",
  "required": ["customer_property_id", "issue_description"],
  "properties": {
    "customer_property_id": {
      "type": "string",
      "description": "The property ID for the service location"
    },
    "issue_description": {
      "type": "string",
      "description": "Free-text description of the issue reported by caller"
    },
    "due_date": {
      "type": "string",
      "description": "Requested completion date in YYYY-MM-DD format"
    },
    "needs_review": {
      "type": "boolean",
      "description": "Pass true when lookup_customer_fuzzy returned requires_review: true (Tier 2 match). Flags the job for manual verification."
    },
    "job_type_id": {
      "type": "string",
      "description": "Override job type ID — omit to use tenant default"
    },
    "department_id": {
      "type": "string",
      "description": "Override department ID — omit to use tenant default"
    }
  }
}
```

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

All customer identification functions return a consistent shape:

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
  "tier_reason": "phone_and_address_match"
}
```

`confidence_tier` is `1` (auto-create job) or `2` (create + manual review). `not_found` responses omit these fields and include a `message` reason code instead.

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
| 1 | `call_inbound` with known phone | `status: found`, `matchedCustomerId` set in DB, agent skips "which company?" |
| 2 | `call_inbound` with unknown phone | `status: not_found`, agent asks for name + address |
| 3 | `call_inbound` with phone matching 2+ customers | `status: multiple_matches`, agent calls `confirm_customer` |
| 4 | `lookup_customer_fuzzy` — name only match | Returns scored candidates above threshold |
| 5 | `lookup_customer_fuzzy` — property address match | Finds customer via property table, cross-checks relationship |
| 6 | `lookup_customer_fuzzy` — new phone | `new_number_detected: true` |
| 7 | `save_caller_number` — same name twice | Second record stored as `Smith2` |
| 8 | `get_properties_for_customer` — 1 property | Agent proceeds directly, no disambiguation |
| 9 | `match_property` — ambiguous address | `status: ambiguous`, top candidates returned |
| 10 | `prepare_job` — blocked account | Returns blocked error, `pending_jobs` unchanged |
| 11 | `prepare_job` — valid | `pending_jobs` has 1 entry, summary returned to agent |
| 12 | `prepare_job` — called twice (multi-job) | `pending_jobs` has 2 entries |
| 13 | `call_ended` | Jobs + tasks created in BuildOps, `buildops_job_id` set |
| 14 | `call_ended` — no pending jobs | No-op |
