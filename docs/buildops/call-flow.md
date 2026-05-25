# BuildOps Integration — Call Flow & Retell Custom Functions

Lifecycle webhook: `POST /api/buildops/retell/webhook`  
Full inbound webhook URL: `https://crm-appointment-scheduler.vercel.app/api/buildops/retell/webhook`  
Custom function endpoints: `POST /api/buildops/fn/<function_name>`  
Auth: `x-retell-signature: <Retell HMAC>`  
Implementation: [`src/routes/buildops.ts`](../../src/routes/buildops.ts)

---

## Webhook Lifecycle Events

### 1. `call_inbound`

Fires before the call is answered. Handler: `POST /api/buildops/retell/webhook`.

**Payload received:**

```json
{
  "event": "call_inbound",
  "call": { "call_id": "<uuid or empty>" },
  "call_inbound": {
    "from_number": "+1XXXXXXXXXX",
    "to_number": "+1XXXXXXXXXX",
    "agent_id": "<retell-agent-id>"
  }
}
```

> `call.call_id` may be absent at this stage. If missing, a `crypto.randomUUID()` is generated and used as a temporary session ID — it will be swapped for the real Retell call ID on `call_started`.

**Steps:**
1. Look up tenant by `call_inbound.to_number` → `resolveByInboundNumber()` → `buildops_tenants`
   - If no row found: return `status: error` dynamic variables (call still proceeds, agent uses fallback prompt)
2. Insert row into `buildops_inbound_calls` (`status = 'active'`)
3. Normalize `call_inbound.from_number` to last-10 digits → `findCustomersByPhone()`

**Phone lookup outcomes** (set as Retell dynamic variables):

| Outcome | Condition | Variables set |
|---|---|---|
| `found` | Exactly 1 match in `all_numbers` | `identified=true`, `customer_id`, `customer_name`, `address`, `address_source`, `new_number_detected`, `property_count`, `property_id` (if 1 property), `caller_source_type`, `caller_rep_name`, `rep_property_id`, `rep_property_address`, `caller_rep_supabase_id`, `caller_rep_buildops_id`, `rep_is_multi_property` |
| `multiple_matches` | 2+ matches in `all_numbers` | `identified=false`, `addresses` = JSON array of `{name, id, address}`, `candidates_count` — all rep/property vars set to empty defaults |
| `not_found` | 0 matches | `identified=false`, `new_number_detected=true` — all rep/property vars set to empty defaults; agent calls `lookup_customer_fuzzy` |

When `found` with a single match: `matchedCustomerId` is written to `buildops_inbound_calls` immediately — the agent skips the confirm step.

When `found` and `property_count = 1`: `property_id` is populated so the agent can skip `match_property`.

When `found` and `caller_source_type = "rep"` and `rep_property_id` is non-empty: the caller is a known representative for a specific property — the agent can pre-select that property and skip `match_property` if the caller confirms.

When `found` and `rep_is_multi_property = "true"`: the caller's phone is registered as a representative for 2+ distinct properties. `rep_property_id`, `rep_property_address`, `caller_rep_supabase_id`, and `caller_rep_buildops_id` are all empty — the agent must call `match_property` to resolve which property the caller is calling about.

---

### 2. `call_started`

Fires once the call is live and Retell has assigned the real call ID. Handler: `POST /api/buildops/retell/webhook`.

**Payload received:**

```json
{
  "event": "call_started",
  "call": {
    "call_id": "<real-retell-call-id>",
    "from_number": "+1XXXXXXXXXX",
    "to_number": "+1XXXXXXXXXX"
  }
}
```

**Steps:**
1. Look up tenant by `call.to_number`
2. Find the active session by `(tenantId, from_number)` — this session was created with the temporary UUID during `call_inbound`
3. If `session.retellCallId !== call.call_id`: swap the temporary UUID for the real Retell call ID in `buildops_inbound_calls` (`updateRetellCallId`)

> **Critical**: if `swapped: false` is logged here, all subsequent custom function calls will fail with "session not found" because they look up sessions by `call_id`.

---

### 3. `call_ended`

Fires when the call disconnects. Handler: `POST /api/buildops/retell/webhook`.

**Payload received:**

```json
{
  "event": "call_ended",
  "call": {
    "call_id": "<retell-call-id>",
    "from_number": "+1XXXXXXXXXX",
    "to_number": "+1XXXXXXXXXX",
    "disconnection_reason": "user_hangup"
  }
}
```

**Steps:**
1. If `call.call_id` is present: write `disconnection_reason` as `buildops_inbound_calls.status` directly
2. If `call_id` is absent (fallback): look up tenant by `to_number` → find active session by phone → update status

Retell `disconnection_reason` values written directly as `buildops_inbound_calls.status`:

| Value | Meaning |
|---|---|
| `user_hangup` | Caller hung up |
| `agent_hangup` | Agent ended the call |
| `call_transfer` | Call was transferred |
| `voicemail_reached` | Voicemail answered |
| `inactivity` | Call idle timeout |
| `machine_detected` | Answering machine |
| `max_duration_reached` | Call hit max duration |
| `concurrency_limit_reached` | Capacity limit |
| `dial_busy` | Line busy |
| `dial_failed` | Dial failure |
| `dial_no_answer` | No answer |
| `error_inbound_webhook` | Webhook error |

Falls back to `'ended'` if `disconnection_reason` is absent.

---

### 4. Custom Function Calls During the Call

Each Retell custom function has its own dedicated endpoint under `/api/buildops/fn/`. Retell calls the endpoint directly; no dispatcher — the endpoint resolves the call session, looks up tenant credentials, and delegates to the handler in `src/services/buildops/handlers/`.

| Function name | Endpoint (path) | Full Retell webhook URL | Handler | Purpose |
|---|---|---|---|---|
| `lookup_customer_fuzzy` | `POST /api/buildops/fn/lookup_customer_fuzzy` | `https://crm-appointment-scheduler.vercel.app/api/buildops/fn/lookup_customer_fuzzy` | `handleLookupFuzzy` | Name/address/zip fuzzy search |
| `confirm_customer` | `POST /api/buildops/fn/confirm_customer` | `https://crm-appointment-scheduler.vercel.app/api/buildops/fn/confirm_customer` | `handleConfirmCustomer` | Confirm which candidate from `multiple_matches` |
| `match_property` | `POST /api/buildops/fn/match_property` | `https://crm-appointment-scheduler.vercel.app/api/buildops/fn/match_property` | `handleMatchProperty` | Fuzzy-match spoken address to a property |
| `prepare_job` | `POST /api/buildops/fn/prepare_job` | `https://crm-appointment-scheduler.vercel.app/api/buildops/fn/prepare_job` | `handlePrepareJob` | Validate + create job in BuildOps (during the call) |
| `add_representative` | `POST /api/buildops/fn/add_representative` | `https://crm-appointment-scheduler.vercel.app/api/buildops/fn/add_representative` | `handleAddRepresentative` | Create new named contact on the account |

---

## Allowed Call Flows

Two flows are permitted. All other paths (e.g. an identified caller calling `lookup_customer_fuzzy` to switch accounts) are blocked by the backend.

**Flow 1 — Unknown caller → fuzzy identify → rep opt-in FIRST → job creation**

```
call_inbound (not_found)
  → call_started (session swap UUID → real call_id)
  → lookup_customer_fuzzy (identifies caller against existing account)
    response: new_number_detected=true (phone not on account)
  → [match_property if property_count > 1]
  → collect caller name
  → PRE-JOB rep opt-in (new_number_detected=true from fuzzy response)
    → add_representative (if caller says YES — returns BuildOps UUID as representative_id)
  → prepare_job (job creation — passes caller_rep_buildops_id from add_representative response if caller opted in)
  → call_ended
```

**Flow 2 — Identified customer → job → optionally save as rep**

```
call_inbound (found, caller_source_type="customer")
  → call_started (session swap)
  → [match_property if property_count > 1 and no rep_property_id]
  → prepare_job (job creation)
  → rep opt-in (caller_source_type="customer" — agent informs not saved as rep, asks)
    → add_representative (if caller says YES)
  → call_ended
```

**Flow 3 — Identified property rep → fast path, no opt-in**

```
call_inbound (found, caller_source_type="rep", rep_property_id non-empty, rep_is_multi_property="false")
  → call_started (session swap)
  → [agent offers rep_property_address, caller confirms — skips match_property]
  → prepare_job (job creation — passes caller_rep_buildops_id; BuildOps job stamped with customerRepId)
  → [rep opt-in skipped — caller is already a property representative]
  → call_ended
```

**Flow 3c — Multi-property rep → property disambiguation → job**

```
call_inbound (found, caller_source_type="rep", rep_is_multi_property="true")
  → call_started (session swap)
  → agent: "You're a representative for multiple locations. Which address are you calling about today?"
  → match_property (same retry/transfer logic as property_count > 1 flow)
  → prepare_job (job creation)
  → [rep opt-in skipped — caller is already a property representative]
  → call_ended
```

**Flow 3b — Identified contact rep (no property link) → opt-in offered**

```
call_inbound (found, caller_source_type="rep", rep_property_id empty)
  → call_started (session swap)
  → [greeted as "contact representative for {customer_name}"]
  → [property resolved via match_property or property_id]
  → prepare_job (job creation)
  → rep opt-in offered: "Would you like to be added as a property representative for [address]?"
    → YES → confirm name (using caller_rep_name), ask email → add_representative
    → NO  → call_ended
```

> **Backend guard**: `handleLookupFuzzy` returns an error immediately if `session.matchedCustomerId` is already set — prevents an identified caller from cross-booking to a different account mid-call.

---

## Call Flow Paths

```
call_inbound
│
├── Phone lookup → 1 match ──────────────────────────────────────── AUTO-CONFIRMED
│   └── agent: "Hi, is this [customer name]?" → proceed to property resolution
│
├── Phone lookup → 2+ matches ──────────────────────────────────── MULTIPLE (phone)
│   └── agent reads names → caller confirms → confirm_customer
│
└── Phone lookup → 0 matches ───────────────────────────────────── NOT FOUND
    └── agent asks caller's name/address → lookup_customer_fuzzy
        │
        ├── Tier 1 (high confidence, cross-validation passes) ─── AUTO-CONFIRMED
        ├── Tier 2 (medium confidence) ─────────────────────────── CONFIRMED with verbal check
        ├── Multiple Tier 2 candidates ──────────────────────────── agent disambiguates → confirm_customer
        └── Tier 3 or pre-tree mismatch ─────────────────────────── transfer_call (handed off)

[Customer confirmed]
│
├── rep_is_multi_property = true ────────────────────────────────── MULTI-PROPERTY REP
│   └── agent: "You're registered for multiple properties. Which are you calling about?"
│       └── match_property → (same confirm/retry/transfer as below)
├── property_count = 1 ──────────────────────────────────────────── SKIP match_property
└── property_count > 1
    ├── rep_property_id set ───────────────────────────────────────── PRE-SELECT (agent confirms)
    │   ├── caller confirms → skip match_property → proceed
    │   └── caller denies → match_property flow below
    └── no rep hint (or after "no" to pre-select) ────────────────── match_property
        ├── matched + caller confirms → proceed
        ├── matched + caller denies → transfer_call
        ├── ambiguous / not_found → 1 retry (full address + zip)
        │   ├── matched + caller confirms → proceed
        │   ├── matched + caller denies → transfer_call
        │   └── still ambiguous / not_found → transfer_call

[Property resolved]
│
├── collect caller name (if not a known rep — ask immediately before issue description)
├── [if new_number_detected=true] PRE-JOB rep registration offer
│   ├── caller YES → add_representative → note representative_id (BuildOps UUID)
│   └── caller NO → skip
└── prepare_job (passes caller_rep_buildops_id — from call-start or from add_representative response)
    │
    ├── account status blocked (creditHold / inactive / suspended / collections)
    │   └── return blocked message to agent → agent informs caller, may transfer
    │
    ├── priceBookId missing ─────────────────────────────────────── error (re-run sync)
    │
    └── job created in BuildOps + written to buildops_jobs immediately
        └── POST-JOB rep opt-in check (two cases):
            ├── caller_source_type = "rep" AND rep_property_id non-empty → SKIP (already a property rep)
            ├── caller_source_type = "rep" AND rep_property_id empty (contact rep) → offer opt-in as property rep
            │   └── caller says YES → confirm name (caller_rep_name), ask email → add_representative
            └── caller_source_type = "customer" → agent informs + asks to save as property rep
                └── caller says YES → collect first_name, last_name, email → add_representative
            Note: new_number_detected = true callers are handled PRE-JOB (see Flow 1 / PRE-JOB REP REGISTRATION) — not offered here
```

---

## Custom Function Endpoints

Each function has its own endpoint (`POST /api/buildops/fn/<name>`). Retell calls the URL directly; the endpoint resolves the call session and delegates to the handler.

---

### `lookup_customer_fuzzy`

Searches for a customer by name, address, zip, or a previously used phone number. Returns `found`, `multiple_matches`, or `not_found`.

| Retell setting | Value |
|---|---|
| Timeout | 8000 ms |
| speak_during_execution | `true` ("Let me look that up for you.") |
| args_only | `false` — **required** so Retell includes `body.call.call_id` for session resolution |

**Payload received:**

```json
{
  "call": {
    "call_id": "<retell-call-id>",
    "from_number": "+1XXXXXXXXXX",
    "to_number": "+1XXXXXXXXXX"
  },
  "arguments": {
    "name": "Acme Plumbing",
    "address": "123 Main St",
    "property_address": "456 Oak Ave",
    "zip": "90210",
    "old_phone": "+1XXXXXXXXXX"
  }
}
```

> `arguments` may be absent (falls back to root body). At least one of the search fields must be provided. All fields are optional individually.

**Parameters:**

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | No | Company or customer name as spoken |
| `address` | string | No | Billing/mailing address as spoken |
| `property_address` | string | No | Service location address as spoken |
| `zip` | string | No | ZIP code as spoken |
| `old_phone` | string | No | A previously used phone number the caller provides |

At least one parameter is required.

**Response variables:**

| Variable | JSON path | Present when |
|---|---|---|
| `status` | `$.status` | Always — `found`, `multiple_matches`, or `not_found` |
| `identified` | `$.identified` | Always — `true` / `false` |
| `confidence_tier` | `$.confidence_tier` | `found` — `1` or `2` |
| `requires_review` | `$.requires_review` | `found` — `true` when tier 2 |
| `customer_id` | `$.customer_id` | `found` |
| `customer_name` | `$.customer_name` | `found` |
| `new_number_detected` | `$.new_number_detected` | `found` — boolean |
| `address` | `$.address` | `found` — primary address string |
| `addressSource` | `$.addressSource` | `found` — source of the address (`propertyAddress`, `businessAddress`, etc.) |
| `tier_reason` | `$.tier_reason` | `found` — the scoring rule that assigned the tier |
| `property_count` | `$.property_count` | `found` |
| `property_id` | `$.property_id` | `found` and `property_count = 1` |
| `candidates` | `$.candidates` | `multiple_matches` — array of `{id, name, address, tier_reason}` (max 3) |
| `message` | `$.message` | Special cases: `need_last_name`, `name_address_mismatch`, `no_matches`, `low_confidence_matches`, `retell_data_mismatch` |

---

### `confirm_customer`

Confirms which customer from a `multiple_matches` result. Writes `matchedCustomerId` to the session.

| Retell setting | Value |
|---|---|
| Timeout | 5000 ms |
| speak_during_execution | `false` |
| args_only | `false` — **required** so Retell includes `body.call.call_id` for session resolution |

**Payload received:**

```json
{
  "call": {
    "call_id": "<retell-call-id>",
    "from_number": "+1XXXXXXXXXX",
    "to_number": "+1XXXXXXXXXX"
  },
  "arguments": {
    "candidate_id": "<buildops-customer-uuid>"
  }
}
```

**Parameters:**

| Field | Type | Required | Description |
|---|---|---|---|
| `candidate_id` | string | Yes | The `id` from the chosen candidate in the `candidates` array |

**Response variables:**

| Variable | JSON path | Description |
|---|---|---|
| `status` | `$.status` | `confirmed` |
| `customer_id` | `$.customer.id` | Confirmed BuildOps customer UUID |
| `customer_name` | `$.customer.name` | Confirmed customer display name |
| `customer_address` | `$.customer.address` | Primary address string for the customer |
| `customer_addressSource` | `$.customer.addressSource` | Source of the address |
| `property_count` | `$.property_count` | Number of service locations |
| `property_id` | `$.property_id` | Set when `property_count = 1` |

---

### `match_property`

Fuzzy-matches a spoken service address against the confirmed customer's properties. Scoring uses `max(tokenSetRatio, recallRatio)` + city/zip bonuses. The recall metric (fraction of stored line1 tokens present in the spoken address) is robust to extra LLM-context tokens and word-form variations (e.g. "Twenty Nine Palms" vs stored "29 PALMS"). Returns the property UUID needed for `prepare_job`.

| Retell setting | Value |
|---|---|
| Timeout | 6000 ms |
| speak_during_execution | `true` ("Let me find that address.") |
| args_only | `false` — **required** so Retell includes `body.call.call_id` for session resolution |

**Payload received:**

```json
{
  "call": {
    "call_id": "<retell-call-id>",
    "from_number": "+1XXXXXXXXXX",
    "to_number": "+1XXXXXXXXXX"
  },
  "arguments": {
    "spoken_address": "123 Oak Street"
  }
}
```

**Parameters:**

| Field | Type | Required | Description |
|---|---|---|---|
| `spoken_address` | string | Yes | The service location address as spoken by the caller |

**Response variables:**

| Variable | JSON path | Present when | Description |
|---|---|---|---|
| `status` | `$.status` | Always | `matched`, `ambiguous`, `not_found`, or `no_properties` |
| `property_id` | `$.property_id` | `matched` | BuildOps property UUID |
| `address` | `$.address` | `matched` | Resolved address object |
| `candidates` | `$.candidates` | `ambiguous` | Array of `{id, address}` (max 3) |
| `identified` | `$.identified` | `not_found` | Always `false` |
| `message` | `$.message` | `not_found` | Always `address_not_matched` |

Scores ≥ 0.60 → `matched`. Top-2 gap < 0.15 → `ambiguous`. Below 0.60 → `not_found` + session status set to `handed_off`. No properties on customer → `no_properties`. Spoken number words (ONE–NINE, ZERO) are normalised to digits before scoring.

---

### `prepare_job`

Validates the account, creates the job in BuildOps, and writes it to `buildops_jobs` — all during the call before returning to Retell.

| Retell setting | Value |
|---|---|
| Timeout | 8000 ms |
| speak_during_execution | `false` |
| args_only | `false` — **required** so Retell includes `body.call.call_id` for session resolution |

**Payload received:**

```json
{
  "call": {
    "call_id": "<retell-call-id>",
    "from_number": "+1XXXXXXXXXX",
    "to_number": "+1XXXXXXXXXX"
  },
  "arguments": {
    "customer_property_id": "<buildops-property-uuid>",
    "status": "Open",
    "needs_review": false,
    "issue_description": "HVAC unit not cooling"
  }
}
```

> Issue description format written to BuildOps:
> ```
> [Job Created by Clara]
> Caller Name: <caller_name>
> Callback Number:- <from_number>
> <issue_description>
> ```
> `caller_name` defaults to `"Unknown"` if not provided. Requires `caller_name` declared as an optional string input parameter in the Retell dashboard.

**Parameters:**

| Field | Type | Required | Description |
|---|---|---|---|
| `customer_property_id` | string | Yes | BuildOps property UUID (from `match_property`, `rep_property_id`, or `property_id` auto-set) |
| `status` | string | No | Initial job status: `Open`, `In Progress`, `On Hold`, `Canceled`, `Complete`. Defaults to `Open` |
| `needs_review` | boolean | No | Set `true` when `confidence_tier = 2` (flags job for manual review) |
| `issue_description` | string | No | Caller's description of the issue |
| `caller_name` | string | No | Name of the person calling — prepended to issue description |
| `caller_rep_supabase_id` | string | No | Supabase UUID of the caller's representative row — used to stamp `property_rep_id` on the local `buildops_jobs` row |
| `caller_rep_buildops_id` | string | No | BuildOps UUID of the caller's representative — passed as `customerRepId` to the BuildOps `POST /v1/jobs` API so the job shows the rep's name; set at call-start for known single-property reps, or from the `add_representative` response for newly registered reps |

**Pre-checks (in order):**
1. `matchedCustomerId` present in session — error if not
2. `customer_property_id` provided — error if not
3. Customer row exists in `buildops_customers` — error if not
4. `priceBookId` present on customer — error if not (indicates sync gap)
5. Live account status via `GET /v1/customers/{id}` — blocked if status is `creditHold`, `inactive`, `suspended`, or `collections`
6. Property exists in `buildops_properties` and `property.customerId` matches session customer — error if not

**Blocked status messages:**

| Status | Message to agent |
|---|---|
| `creditHold` | "This account is on credit hold. Please contact our billing team…" |
| `inactive` | "This account is inactive and cannot have new jobs created." |
| `suspended` | "This account is suspended. Please contact our office to reinstate service." |
| `collections` | "This account is in collections. Please contact our billing team…" |

**Response variables (success):**

| Variable | JSON path | Description |
|---|---|---|
| `status` | `$.status` | `created` |
| `job_id` | `$.job_id` | BuildOps job UUID |
| `job_number` | `$.job_number` | Human-readable job number |
| `needs_review` | `$.needs_review` | Echoed back |
| `property_address` | `$.summary.property_address` | Address read back to caller |
| `job_status` | `$.summary.job_status` | Echoed status |

**Response variables (blocked):**

| Variable | JSON path | Description |
|---|---|---|
| `status` | `$.status` | `blocked` |
| `reason` | `$.reason` | BuildOps status string |
| `message` | `$.message` | Human-readable reason for agent to relay |

Hardcoded defaults:
- `jobTypeId`: `04df1a40-16b1-43f4-aa9b-8eafcec812ad` (Time & Material)
- `departmentId`: `d87c1a38-4acd-459f-9b3f-446a810fae10` (D2 Service Calls T&M)

**Email notification (fire-and-forget after every exit path):**

`sendJobNotification` in `src/services/buildops/emailNotificationService.ts` is called fire-and-forget at all three exit paths. Recipients come from `buildops_tenants.email_to` (array). Sender is `SENDER_MAIL` env var.

| Tier | Condition | Badge | Subject |
|---|---|---|---|
| `tier1` | Job created, no review | Tier 1 — Service Request Logged (green) | `New Service Request — {customer} \| Job #{jobNumber}` |
| `tier2` | Job created, review required (`needs_review=true`) | Tier 2 — Review Required (orange) | `Service Request Needs Review — {customer} \| Job #{jobNumber}` |
| `tier3` | Job not created (blocked or error) | Tier 3 — Job Not Created (red) | `Service Request Failed — {customer}` |

Tier 1 and Tier 2 emails include a **View in BuildOps** button: `https://live.buildops.com/job/view/{jobNumber}`.

Email rows per tier:
```
Tier 1/2: Caller Name · Callback Number · Customer · Service Address · Issue · Job Number · Tier · [Review Reason — tier2 only] · Logged At
Tier 3:   Caller Name · Callback Number · Customer · Service Address · Issue · Tier · Reason · Logged At
```

---

### `add_representative`

Creates a new named contact/representative on the BuildOps property and appends their phone to the customer's `all_numbers` for future lookups. Only called when the caller explicitly says YES to saving their number.

| Retell setting | Value |
|---|---|
| Timeout | 5000 ms |
| speak_during_execution | `false` |
| args_only | `false` — **required** so Retell includes `body.call.call_id` for session resolution |

**Payload received:**

```json
{
  "call": {
    "call_id": "<retell-call-id>",
    "from_number": "+1XXXXXXXXXX",
    "to_number": "+1XXXXXXXXXX"
  },
  "arguments": {
    "first_name": "Jane",
    "last_name": "Smith",
    "email": "jane@example.com",
    "property_id": "<buildops-property-uuid>"
  }
}
```

> Phone is never passed in `arguments` — it is always taken from `session.caller` (`from_number`).

**Parameters:**

| Field | Type | Required | Description |
|---|---|---|---|
| `first_name` | string | Yes | Caller's first name |
| `last_name` | string | Yes | Caller's last name |
| `email` | string | No | Contact email |
| `property_id` | string | **Yes** | BuildOps property UUID to associate the rep with (use the `customer_property_id` of the job just created) |

Phone is always taken from `session.caller` (`from_number`) — the agent never asks for it.

Execution order:
1. Create in BuildOps API at `POST /v1/properties/{propertyId}/representatives` (blocking — must succeed)
2. Mirror to `buildops_representatives` with `buildops_rep_id` stored (best-effort)
3. Append Supabase rep UUID to `buildops_customers.representative_ids` and `buildops_properties.representative_ids` (best-effort)
4. Append phone to `buildops_customers.all_numbers` with source `rep:cellPhone:<Name>:prop:<propertyId>` (best-effort, immediate effect for future calls via cron)
5. If `session.buildopsJobId` is set (job already created): stamp `property_rep_id`/`property_rep_name` on the local `buildops_jobs` row (best-effort)

**Response variables:**

| Variable | JSON path | Description |
|---|---|---|
| `status` | `$.status` | `added` |
| `representative_id` | `$.representative_id` | BuildOps rep UUID — pass as `caller_rep_buildops_id` to a subsequent `prepare_job` if this is a pre-job rep registration |
| `name` | `$.name` | Full name string (`first_name last_name`) |

---

## Non-Webhook Retell Tools

### `get_oncall_tech`

Type: `code` (inline JS schedule lookup, not a webhook). Returns transfer tool names for primary, backup, and manager on-call. Timeout: 15000 ms.

| Return field | Description |
|---|---|
| `primary_tool` | Transfer tool name for primary on-call tech |
| `primary_name` | Display name |
| `backup_tool` | Transfer tool name for backup (`null` if none) |
| `backup_name` | Display name |
| `manager_tool` | Transfer tool name for on-call manager |
| `manager_name` | Display name |

### `end_call`

Type: `end_call`. Invoked only after "Is there anything else I can help you with?" and caller confirms nothing else.

### `transfer_call_<Name>`

Type: `transfer_call` (agentic warm transfer). One tool per on-call person. Invoked using the tool name returned by `get_oncall_tech`. Ring duration 28–33 s, timeout 29–60 s, on-timeout: `cancel_transfer`.

Current roster: Omar Garcia Jr, Elder Rodriguez, Kyle Thomas, Eric Beer, Joseph Boecker, Zachary Marshall, Kamahl Scott, Ryan Gordan, Thomas Beder, Timothy Wylie, Brett Weaver, Austin Ramsy, Brian Cruz, Justin Hope, Nick Sansbury, Akil Raphael, Megan Jones, Tiffany Gibson, Damonz Vann, Tony Merlo, Scott Dashiell, Brittney Moyer, Mike Plotts.
