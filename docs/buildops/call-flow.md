# BuildOps Integration — Call Flow & Retell Custom Functions

Lifecycle webhook: `POST /api/buildops/retell/webhook`  
Custom function endpoints: `POST /api/buildops/fn/<function_name>`  
Auth: `x-retell-signature: <Retell HMAC>`  
Implementation: [`src/routes/buildops.ts`](../../src/routes/buildops.ts)

---

## Webhook Lifecycle Events

### 1. `call_inbound` / `call_started`

Fires at the moment a call arrives. Handler: `retell/index.ts`.

**Steps:**
1. Look up tenant by dialed `to_number` → `resolveByInboundNumber()` → `buildops_tenants`
   - If no row found: return `status: error` dynamic variables (call still proceeds, agent uses fallback prompt)
2. Insert row into `buildops_inbound_calls` (`status = 'active'`)
3. Normalize `from_number` to last-10 digits → `findCustomersByPhone()`

**Phone lookup outcomes** (set as Retell dynamic variables):

| Outcome | Condition | Variables set |
|---|---|---|
| `found` | Exactly 1 match in `all_numbers` | `identified=true`, `customer_id`, `customer_name`, `property_count`, `property_id` (if 1 property) |
| `multiple_matches` | 2+ matches in `all_numbers` | `identified=false`, `addresses` = JSON array of `{name, id, address}`, `candidates_count` |
| `not_found` | 0 matches | `identified=false` — agent will call `lookup_customer_fuzzy` |

When `found` with a single match: `matchedCustomerId` is written to `buildops_inbound_calls` immediately — the agent skips the confirm step.

When `found` and `property_count = 1`: `property_id` is populated so the agent can skip `match_property`.

---

### 2. Custom Function Calls During the Call

Each Retell custom function has its own dedicated endpoint under `/api/buildops/fn/`. Retell calls the endpoint directly; no dispatcher — the endpoint resolves the call session, looks up tenant credentials, and delegates to the handler in `src/services/buildops/handlers/`.

| Function name | Endpoint | Handler | Purpose |
|---|---|---|---|
| `lookup_customer_fuzzy` | `POST /api/buildops/fn/lookup_customer_fuzzy` | `handleLookupFuzzy` | Name/address/zip fuzzy search |
| `confirm_customer` | `POST /api/buildops/fn/confirm_customer` | `handleConfirmCustomer` | Confirm which candidate from `multiple_matches` |
| `match_property` | `POST /api/buildops/fn/match_property` | `handleMatchProperty` | Fuzzy-match spoken address to a property |
| `prepare_job` | `POST /api/buildops/fn/prepare_job` | `handlePrepareJob` | Validate + create job in BuildOps (during the call) |
| `add_representative` | `POST /api/buildops/fn/add_representative` | `handleAddRepresentative` | Create new named contact on the account |

---

### 3. `call_ended`

Sets `buildops_inbound_calls.status = 'ended'`. **No job creation happens here** — jobs are created during the call via `prepare_job`.

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
├── property_count = 1 ──────────────────────────────────────────── SKIP match_property
└── property_count > 1 ──────────────────────────────────────────── match_property
    │
    ├── matched ──────────────────────────────────────────────────── proceed
    ├── ambiguous ────────────────────────────────────────────────── agent reads candidates, re-call
    └── not_found ────────────────────────────────────────────────── transfer_call

[Property resolved]
│
└── prepare_job
    │
    ├── account status blocked (creditHold / inactive / suspended / collections)
    │   └── return blocked message to agent → agent informs caller, may transfer
    │
    ├── priceBookId missing ─────────────────────────────────────── error (re-run sync)
    │
    └── job created in BuildOps + written to buildops_jobs immediately
        └── if new_number_detected → add_representative (optional)
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
| `new_number_detected` | `$.new_number_detected` | `found` |
| `property_count` | `$.property_count` | `found` |
| `property_id` | `$.property_id` | `found` and `property_count = 1` |
| `candidates` | `$.candidates` | `multiple_matches` — array of `{id, name, address, tier_reason}` (max 3) |
| `message` | `$.message` | Special cases: `need_last_name`, `name_address_mismatch`, `no_matches`, `low_confidence_matches` |

---

### `confirm_customer`

Confirms which customer from a `multiple_matches` result. Writes `matchedCustomerId` to the session.

| Retell setting | Value |
|---|---|
| Timeout | 5000 ms |
| speak_during_execution | `false` |

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
| `property_count` | `$.property_count` | Number of service locations |
| `property_id` | `$.property_id` | Set when `property_count = 1` |

---

### `match_property`

Fuzzy-matches a spoken service address against the confirmed customer's properties using token-set ratio + city/zip bonuses. Returns the property UUID needed for `prepare_job`.

| Retell setting | Value |
|---|---|
| Timeout | 6000 ms |
| speak_during_execution | `true` ("Let me find that address.") |

**Parameters:**

| Field | Type | Required | Description |
|---|---|---|---|
| `spoken_address` | string | Yes | The service location address as spoken by the caller |

**Response variables:**

| Variable | JSON path | Description |
|---|---|---|
| `status` | `$.status` | `matched`, `ambiguous`, or `not_found` |
| `property_id` | `$.property_id` | BuildOps property UUID (present when `matched`) |
| `address` | `$.address` | Resolved address object |
| `candidates` | `$.candidates` | Array of `{id, address}` (present when `ambiguous`) |

Scores ≥ 0.60 → `matched`. Scores where top-2 gap < 0.15 → `ambiguous`. Below 0.60 → `not_found` + status set to `handed_off`.

---

### `prepare_job`

Validates the account, creates the job in BuildOps, writes it to `buildops_jobs`, and creates any task line items — all during the call before returning to Retell.

| Retell setting | Value |
|---|---|
| Timeout | 5000 ms |
| speak_during_execution | `false` |

**Parameters:**

| Field | Type | Required | Description |
|---|---|---|---|
| `customer_property_id` | string | Yes | BuildOps property UUID (from `match_property` or `property_id` auto-set) |
| `status` | string | No | Initial job status: `Open`, `In Progress`, `On Hold`, `Canceled`. Defaults to `Open` |
| `needs_review` | boolean | No | Set `true` when `confidence_tier = 2` (flags job for manual review) |
| `tasks` | array | No | Task line items (see below) |

**`tasks[]` sub-fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `tasks[].name` | string | Yes | Task display name shown on the work order |
| `tasks[].entries[]` | array | Yes | Line items |
| `tasks[].entries[].product_id` | string | Yes | BuildOps product UUID |
| `tasks[].entries[].description` | string | No | Line item description override |
| `tasks[].entries[].quantity` | number | No | Defaults to `1` |

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
| `task_count` | `$.summary.task_count` | Number of tasks created |

**Response variables (blocked):**

| Variable | JSON path | Description |
|---|---|---|
| `status` | `$.status` | `blocked` |
| `reason` | `$.reason` | BuildOps status string |
| `message` | `$.message` | Human-readable reason for agent to relay |

Hardcoded defaults:
- `jobTypeId`: `04df1a40-16b1-43f4-aa9b-8eafcec812ad` (Time & Material)
- `departmentId`: `d87c1a38-4acd-459f-9b3f-446a810fae10` (D2 Service Calls T&M)

---

### `add_representative`

Creates a new named contact/representative on the BuildOps account and appends their phone to the customer's `all_numbers` for future lookups.

| Retell setting | Value |
|---|---|
| Timeout | 5000 ms |
| speak_during_execution | `false` |

**Parameters:**

| Field | Type | Required | Description |
|---|---|---|---|
| `first_name` | string | Yes | Caller's first name |
| `last_name` | string | Yes | Caller's last name |
| `phone` | string | No | Phone to save (defaults to caller's `from_number`) |
| `email` | string | No | Contact email |
| `property_id` | string | No | BuildOps property UUID to associate the rep with |

Execution order:
1. Create in BuildOps API (blocking — must succeed)
2. Mirror to `buildops_representatives` (best-effort)
3. Append phone to `buildops_customers.all_numbers` (best-effort, immediate effect for future calls)

**Response variables:**

| Variable | JSON path | Description |
|---|---|---|
| `status` | `$.status` | `added` |
| `representative_id` | `$.representative_id` | BuildOps rep UUID |

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
