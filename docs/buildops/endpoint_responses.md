# BuildOps Endpoint Testing — Curl Reference

Base URL: `http://localhost:8080`  
All commands are single-line Windows CMD compatible.

---

## Step 1 — List tenants (verify setup)

```
curl http://localhost:8080/api/buildops/admin/tenants
```

**Expected response**
```json
{"tenants":[{"no":"+19842056510","buildops_tenant_id":"470f824e-94a8-41c1-9ef6-c87bbe099dd2","company_name":null,"is_active":true}]}
```

---

## Step 2 — Create inbound call session

Use `to_number` = tenant's registered E.164 number. Use `from_number` = a phone number belonging to a test customer in `buildops_customers.all_numbers`.  
**Every test run needs a unique `call_id`.** Reusing one silently fails (see Mistakes section).

```
curl -X POST http://localhost:8080/api/buildops/retell/webhook -H "Content-Type: application/json" -d "{\"event\": \"call_inbound\", \"call\": {\"call_id\": \"test-call-001\", \"to_number\": \"+19842056510\", \"from_number\": \"9330243839\"}}"
```

### Case A — Customer not found (phone not in DB)
```json
{"call_inbound":{"dynamic_variables":{"status":"not_found","identified":"false","confidence":"0","customer_id":"","customer_name":"","from_number":"933-024-3839","new_number_detected":"true","address_count":"0","addresses":"[]","multiple_matches":"false"}}}
```

### Case B — Customer found (phone matches a record)
```json
{"call_inbound":{"dynamic_variables":{"status":"found","identified":"true","confidence":"1.0","customer_id":"08af512c-930d-408e-8cc2-673871b44c14","customer_name":"clara","from_number":"933-024-3839","new_number_detected":"false","address":"2 Church St, Toronto, ON, M5E 1Z3","address_source":"propertyAddress","multiple_matches":"false","property_count":"1","property_id":"039de7b5-1549-4077-9965-7c82308ff9bc","caller_source_type":"customer","caller_rep_name":"","rep_property_id":"","rep_property_address":""}}}
```

---

## Step 3b — Confirm customer

Only needed when `status` is `multiple_matches`. Pass the `id` of the candidate the caller confirmed.

```
curl -X POST http://localhost:8080/api/buildops/fn/confirm_customer -H "Content-Type: application/json" -d "{\"call\": {\"call_id\": \"test-call-001\"}, \"args\": {\"candidate_id\": \"08af512c-930d-408e-8cc2-673871b44c14\"}}"
```

**Expected response**
```json
{"result":"{\"status\":\"confirmed\",\"customer\":{\"id\":\"08af512c-930d-408e-8cc2-673871b44c14\",\"name\":\"clara\",\"address\":\"2 Church St, Toronto, ON, M5E 1Z3\",\"addressSource\":\"propertyAddress\"},\"property_count\":1,\"property_id\":\"039de7b5-1549-4077-9965-7c82308ff9bc\"}"}
```

---

## Step 3c — Match property

Only needed when `property_count` > 1. Pass whatever the caller says as `spoken_address`.

```
curl -X POST http://localhost:8080/api/buildops/fn/match_property -H "Content-Type: application/json" -d "{\"call\": {\"call_id\": \"test-call-001\"}, \"args\": {\"spoken_address\": \"2 Church Street\"}}"
```

**Expected response**
```json
{"result":"{\"status\":\"matched\",\"property_id\":\"039de7b5-1549-4077-9965-7c82308ff9bc\",\"address\":{\"zip\":\"M5E 1Z3\",\"city\":\"Toronto\",\"line1\":\"2 Church St\",\"line2\":null,\"state\":\"ON\"}}"}
```

---

## Step 3d — Prepare job

Pass the `property_id` resolved in step 3c (or pre-populated `property_id` from step 2 when `property_count` is 1, or `rep_property_id` when the caller is a known rep for that property).

```
curl -X POST http://localhost:8080/api/buildops/fn/prepare_job -H "Content-Type: application/json" -d "{\"call\": {\"call_id\": \"test-call-001\"}, \"args\": {\"customer_property_id\": \"039de7b5-1549-4077-9965-7c82308ff9bc\", \"caller_name\": \"John Smith\", \"issue_description\": \"HVAC unit not cooling\"}}"
```

**Expected response**
```json
{"result":"{\"status\":\"created\",\"job_id\":\"8d7033db-1231-46fd-98e3-beb55573fd6c\",\"job_number\":\"5143\",\"needs_review\":false,\"summary\":{\"property_address\":{\"zip\":\"M5E 1Z3\",\"city\":\"Toronto\",\"line1\":\"2 Church St\",\"line2\":null,\"state\":\"ON\"},\"job_status\":\"Open\"}}"}
```

---

## Step 3e — Add representative (opt-in)

Only called when `new_number_detected` is `true` AND the caller explicitly says YES to saving their number. `property_id` is required — use the `customer_property_id` from the job just created.

```
curl -X POST http://localhost:8080/api/buildops/fn/add_representative -H "Content-Type: application/json" -d "{\"call\": {\"call_id\": \"test-call-001\"}, \"args\": {\"first_name\": \"John\", \"last_name\": \"Doe\", \"property_id\": \"039de7b5-1549-4077-9965-7c82308ff9bc\"}}"
```

**Expected response**
```json
{"result":"{\"status\":\"added\",\"representative_id\":\"1238e2a0-ca3a-4a77-a856-ce4b92d3ab64\",\"name\":\"John Doe\"}"}
```

---

## Step 4 — End call

```
curl -X POST http://localhost:8080/api/buildops/retell/webhook -H "Content-Type: application/json" -d "{\"event\": \"call_ended\", \"call\": {\"call_id\": \"test-call-001\"}}"
```

**Expected response**
```json
{"ok":true}
```

---

## Mistakes & Gotchas

### 1. Reusing a `call_id` → silent `{"ok":true}`

`createInboundCall` is a plain `INSERT` with a `UNIQUE` constraint on `retell_call_id`. If you fire `call_inbound` with a `call_id` that already exists in `buildops_inbound_calls`, the insert throws a unique constraint violation. The outer `try/catch` in the webhook handler catches it silently and returns `{"ok":true}` — no error, no inbound response, no session created.

**Fix:** Increment the call_id for every new test run (`test-call-002`, `test-call-003`, etc.).

---

### 2. `from_number` not matching → `status: not_found`

Phone lookup uses `all_numbers` GIN index (last 10 digits). If the number you pass is not in `buildops_customers.all_numbers` for the tenant, the session is created but returns `not_found`. You then need `lookup_customer_fuzzy` to continue.

**Fix:** Use a number that exists in `all_numbers` for the test tenant, or run `lookup_customer_fuzzy` afterwards.

---

### 3. `address`, `address_source` empty on `found` response

If the customer record has no `business_address`, no `billing_address`, and no entries in `property_ids`, `pickPrimaryAddress` returns `null` for both fields. The dynamic variable shows `address: ""`.

**Why it happens:** Customer was synced before addresses were populated, or the cron has not run yet for that tenant.

**Fix:** Run the cron sync, or manually update the customer row with a `business_address` value.

---

### 4. `prepare_job` → `"error: property not found or does not belong to this customer"`

This was a FK mismatch bug: the validation compared `buildops_properties.customer_id` (a BuildOps ID string) against `session.matchedCustomerId` (our internal UUID). They are different ID spaces and will never match.

**Status:** Fixed — now compares against `customer.buildopsCustomerId`.

---

### 5. `prepare_job` → BuildOps 400 `departments must NOT have additional properties`

The initial implementation sent `departments: [{ id: "..." }]` in the job creation body. The BuildOps API schema uses `additionalProperties: false` and the correct field is `departmentIds: ["..."]` (flat array of UUID strings, not an array of objects).

**Status:** Fixed — `CreateJobInput` now uses `departmentIds?: string[] | null`.

---

### 6. `match_property` or `get_properties` returning empty when properties exist

`getPropertiesForCustomer` was querying `buildops_properties WHERE customer_id = <our UUID>` but `buildops_properties.customer_id` stores the BuildOps ID (`buildops_customer_id`), not our internal UUID. This meant property queries always returned empty.

**Status:** Fixed — all property lookups now use `getPropertiesByIds(customer.propertyIds)` which queries `buildops_properties.id IN (property_ids)`, the correct primary key.

---

## Retell Webhook & Custom Function URL Setup

Before the call flow can work, Retell must be told where to send events and where to call each custom function. Both are configured against the phone number and agent in the Retell dashboard or via the Retell API.

---

### Inbound Webhook URL

Retell fires the `call_inbound` event to a URL set on the **phone number** — the `inbound_webhook_url` field. This is not an agent setting; it lives on the phone number record.

**URL to provide:**
```
https://crm-appointment-scheduler.vercel.app/api/buildops/retell/webhook
```

**How to set it — Retell API:**
```
PUT https://api.retellai.com/v1/phone-numbers/{phoneNumber}
Authorization: Bearer <RETELL_API_KEY>
Content-Type: application/json

{
  "inbound_webhook_url": "https://crm-appointment-scheduler.vercel.app/api/buildops/retell/webhook"
}
```

**How to set it — Retell dashboard:**  
Phone Numbers → select the number → *Inbound Webhook URL* field → paste the URL → Save.

Retell sends a `POST` with `{ "event": "call_inbound", "call_inbound": { "from_number": "...", "to_number": "...", ... } }` and expects a `2xx` response with a `call_inbound` object containing `dynamic_variables` (and optional `agent_override`).

The same endpoint also receives `call_started` and `call_ended` lifecycle events — these are wired to the same URL automatically by Retell; no separate registration is needed.

---

### Custom Function URLs

Each custom function is configured in the **agent's LLM / conversation flow** in Retell with a `webhook` type and its own URL.

**URL pattern:**
```
https://crm-appointment-scheduler.vercel.app/api/buildops/fn/<function_name>
```

**Full URL list:**

| Function | URL |
|---|---|
| `lookup_customer_fuzzy` | `https://crm-appointment-scheduler.vercel.app/api/buildops/fn/lookup_customer_fuzzy` |
| `confirm_customer` | `https://crm-appointment-scheduler.vercel.app/api/buildops/fn/confirm_customer` |
| `match_property` | `https://crm-appointment-scheduler.vercel.app/api/buildops/fn/match_property` |
| `prepare_job` | `https://crm-appointment-scheduler.vercel.app/api/buildops/fn/prepare_job` |
| `add_representative` | `https://crm-appointment-scheduler.vercel.app/api/buildops/fn/add_representative` |

These are configured per-function in the Retell agent editor under *Custom Tools → Webhook URL*.

---

### `BASE_URL` Environment Variable

The server's public base URL is set via `BASE_URL` in `.env` ([src/config/env.ts](../../src/config/env.ts) exposes it as `env.retellBaseUrl`).

```
# .env
BASE_URL=https://crm-appointment-scheduler.vercel.app
```

> **Note:** The `.env.example` placeholder `https://api.retellai.com` is incorrect — that is the Retell API endpoint, not your server. `BASE_URL` must be the publicly reachable origin of **this** server so Retell can POST to it.

For local development use an ngrok tunnel:
```
ngrok http 8080
# then set:
BASE_URL=https://<random-id>.ngrok-free.app
```

Auth on all webhook and function endpoints: `x-retell-signature` HMAC header verified against `RETELL_API_KEY`.

---

## Full End-to-End Call Flow

This traces every API hit, handler, and DB operation from the moment a call arrives to job creation.

---

### 1. `POST /api/buildops/retell/webhook` — event: `call_inbound`

**Triggered by:** Retell automatically fires this as soon as an inbound call arrives on the tenant's registered `to_number`. No agent decision — it is always the first event of every call.

**Router:** `src/routes/buildops.ts`  
**Handler:** `src/services/buildops/retell/index.ts`

| Step | Operation | Table / Service |
|---|---|---|
| 1 | Look up tenant by `to_number` | `resolveByInboundNumber()` → `buildops_tenants` |
| 2 | Insert call row with `status = 'active'` | `createInboundCall()` → `buildops_inbound_calls` |
| 3 | Normalize `from_number` to last-10 digits, search by phone | `findCustomersByPhone()` → `buildops_customers.all_numbers` (GIN index) |

Phone lookup result is returned as Retell dynamic variables. Three outcomes:

```
0 matches  → status: not_found   → agent will call lookup_customer_fuzzy
1 match    → status: found       → matchedCustomerId written to session immediately
2+ matches → status: multiple_matches → agent reads names → confirm_customer
```

When `found` and `property_count = 1`: `property_id` is pre-populated → `match_property` is skipped.

---

### 2. `POST /api/buildops/fn/lookup_customer_fuzzy` *(if not_found)*

**Triggered by:** The Retell agent calls this when `call_inbound` returns `status: not_found` — meaning the caller's `from_number` did not match any number in `buildops_customers.all_numbers`. The agent first asks the caller for their name, address, or zip, then fires this endpoint with those spoken values.

**Router:** `src/routes/buildops.ts`  
**Handler:** `src/services/buildops/handlers/handleLookupFuzzy`

Agent asks the caller for their name / address / zip. Those values are passed as `args`.

| Step | Operation | Table / Service |
|---|---|---|
| 1 | Resolve call session by `call_id` | `buildops_inbound_calls` |
| 2 | Fuzzy search by name, address, zip, or old phone | `buildops_customers` |
| 3 | Score candidates and assign tiers (1 = high, 2 = medium, 3 = low) | in-process scoring |
| 4 | If `found`: write `matchedCustomerId` to session | `buildops_inbound_calls` |

Returns `found`, `multiple_matches`, or `not_found`.  
Tier 3 / pre-tree mismatch → agent invokes `transfer_call`.

---

### 3. `POST /api/buildops/fn/confirm_customer` *(if multiple_matches)*

**Triggered by:** The Retell agent calls this after verbally reading the candidate list to the caller and getting a verbal confirmation. Can be reached from two paths:
- `call_inbound` returned `status: multiple_matches` (2+ phone number hits)
- `lookup_customer_fuzzy` returned `status: multiple_matches` (2–3 medium-confidence fuzzy candidates)

The agent passes the `id` of the candidate the caller confirmed.

**Router:** `src/routes/buildops.ts`  
**Handler:** `src/services/buildops/handlers/handleConfirmCustomer`

Agent reads candidate names to caller; caller confirms one. `candidate_id` is passed.

| Step | Operation | Table / Service |
|---|---|---|
| 1 | Look up candidate by `candidate_id` | `buildops_customers` |
| 2 | Write `matchedCustomerId` to session | `buildops_inbound_calls` |

Returns `confirmed` with customer details and `property_count`.

---

### 4. `POST /api/buildops/fn/match_property` *(if property_count > 1)*

**Triggered by:** The Retell agent calls this once a customer is confirmed (via phone match, `confirm_customer`, or `lookup_customer_fuzzy`) and `property_count > 1`. The agent asks the caller which address needs service, then fires this endpoint with the spoken address. If `property_count = 1`, this step is skipped entirely — `property_id` was already pre-populated in the session.

**Router:** `src/routes/buildops.ts`  
**Handler:** `src/services/buildops/handlers/handleMatchProperty`

Agent asks the caller for the service address. Spoken text is passed as `spoken_address`.

| Step | Operation | Table / Service |
|---|---|---|
| 1 | Resolve session → get `matchedCustomerId` | `buildops_inbound_calls` |
| 2 | Load customer's property list | `getPropertiesByIds(customer.propertyIds)` → `buildops_properties` |
| 3 | Score each property via token-set ratio + city/zip bonuses | in-process fuzzy match |

Score thresholds:
- ≥ 0.60 → `matched` (single winner)
- top-2 gap < 0.15 → `ambiguous` (agent reads candidates, re-calls this endpoint)
- < 0.60 → `not_found` + session status set to `handed_off` → agent invokes `transfer_call`

---

### 5. `POST /api/buildops/fn/prepare_job`

**Triggered by:** The Retell agent calls this once both customer and property are resolved — `matchedCustomerId` is in the session and a `customer_property_id` is known (either from `match_property`, or the pre-populated `property_id` when `property_count = 1`). The agent passes `customer_property_id` and optional `tasks[]`. This is the only place a job is created; it is called during the live call before the agent wraps up.

**Router:** `src/routes/buildops.ts`  
**Handler:** `src/services/buildops/handlers/handlePrepareJob`

Called once customer and property are confirmed. All validation and job creation happen synchronously before returning to Retell.

| Step | Operation | Table / Service |
|---|---|---|
| 1 | Verify `matchedCustomerId` in session | `buildops_inbound_calls` |
| 2 | Load customer row + `priceBookId` check | `buildops_customers` |
| 3 | Live account status check | BuildOps API `GET /v1/customers/{id}` |
| 4 | Verify property belongs to this customer | `buildops_properties` (compare `customer.buildopsCustomerId`) |
| 5 | Create job | BuildOps API `POST /v1/jobs` (hardcoded `jobTypeId`, `departmentIds`) |
| 6 | Write job record | `buildops_jobs` |

If account status is `creditHold`, `inactive`, `suspended`, or `collections` → returns `blocked` with a message for the agent to relay. No job is created.

---

### 6. `POST /api/buildops/fn/add_representative` *(optional)*

**Triggered by:** The Retell agent calls this in two situations:
- `call_inbound` or `lookup_customer_fuzzy` returned `new_number_detected: true` — the caller's `from_number` was not previously stored on the account, so the agent asks for their name and offers to save it.
- The caller volunteers a new contact name during the conversation (agent-initiated, not data-driven).

Runs after `prepare_job` succeeds. It is non-blocking for the job — the job already exists at this point.

**Router:** `src/routes/buildops.ts`  
**Handler:** `src/services/buildops/handlers/handleAddRepresentative`

| Step | Operation | Table / Service |
|---|---|---|
| 1 | Create contact in BuildOps (blocking) | BuildOps API `POST /v1/representatives` |
| 2 | Mirror record locally (best-effort) | `buildops_representatives` |
| 3 | Append phone to customer's number list (best-effort) | `buildops_customers.all_numbers` |

---

### 7. `POST /api/buildops/retell/webhook` — event: `call_ended`

**Triggered by:** Retell automatically fires this when the call disconnects — whether the caller hung up, the agent invoked the `end_call` tool after "Is there anything else I can help you with?", or a transfer completed. No agent decision required.

**Router:** `src/routes/buildops.ts`  
**Handler:** `src/services/buildops/retell/index.ts`

| Step | Operation | Table / Service |
|---|---|---|
| 1 | Set `status = 'ended'` | `buildops_inbound_calls` |

No job creation occurs here — that already happened in `prepare_job` during the call.

---

### Summary Table

| # | Endpoint | Trigger | Handler | DB tables touched | External API |
|---|---|---|---|---|---|
| 1 | `POST /retell/webhook` (`call_inbound`) | Retell — automatic on every inbound call | `retell/index.ts` | `buildops_tenants`, `buildops_inbound_calls`, `buildops_customers` | — |
| 2 | `POST /fn/lookup_customer_fuzzy` | Agent — when `call_inbound` → `not_found` | `handleLookupFuzzy` | `buildops_inbound_calls`, `buildops_customers` | — |
| 3 | `POST /fn/confirm_customer` | Agent — when any step returns `multiple_matches` | `handleConfirmCustomer` | `buildops_inbound_calls`, `buildops_customers` | — |
| 4 | `POST /fn/match_property` | Agent — when confirmed customer has `property_count > 1` | `handleMatchProperty` | `buildops_inbound_calls`, `buildops_customers`, `buildops_properties` | — |
| 5 | `POST /fn/prepare_job` | Agent — once customer + property are both resolved | `handlePrepareJob` | `buildops_inbound_calls`, `buildops_customers`, `buildops_properties`, `buildops_jobs` | BuildOps `GET /v1/customers/{id}`, `POST /v1/jobs` |
| 6 | `POST /fn/add_representative` | Agent — when `new_number_detected: true` and caller says YES to saving their number | `handleAddRepresentative` | `buildops_representatives`, `buildops_customers`, `buildops_properties` | BuildOps `POST /v1/properties/{id}/representatives` |
| 7 | `POST /retell/webhook` (`call_ended`) | Retell — automatic on call disconnect / end_call / transfer complete | `retell/index.ts` | `buildops_inbound_calls` | — |
