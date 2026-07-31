# HouseCall Pro Endpoint Testing — Curl Reference

Base URL (local): `http://localhost:8080`
Production base: `https://crm-appointment-scheduler.vercel.app`

All commands are single-line Windows CMD compatible.

HouseCall Pro (HCP) auth is a **static per-tenant API key** stored in `housecallpro_tokens.api_key`, resolved by the dialed number (`no`). The backend adds `Authorization: Token <api_key>` on every HCP API call — you never pass it in these requests.

**Booking model:** the **Office-Hours** agent identifies → (creates) the customer → matches/creates the service address → books the job into `housecallpro_jobs`. The **After-Hours** agent identifies → captures the request via `escalate` (no booking).

---

## Step 1 — List tenants + sync status (verify setup)

```
curl http://localhost:8080/api/housecallpro/admin/tokens
```

**Expected response**
```json
{"tokens":[{"no":"+18185551234","tenant_id":"714899a2-2ea5-43da-a966-8bce85658f01","agent_id":"agent_xxx","name":"Zephyr Heating and Air LLC"}]}
```

```
curl http://localhost:8080/api/housecallpro/admin/sync-status
```

**Expected response**
```json
{"tenants":[{"no":"+18185551234","name":"Zephyr Heating and Air LLC","tenant_id":"714899a2-2ea5-43da-a966-8bce85658f01","sync_customer_page":7,"cached_customers":612}]}
```

---

## Step 2 — Create inbound call session

Use `to_number` = the tenant's registered number (`housecallpro_tokens.no`). Use `from_number` = a caller number; if its last-10 digits match `housecallpro_customers.normalized_mobile` the caller is identified.

Retell's real `call_id` is assigned at `call_started`; at `call_inbound` it may be absent. `/fn/*` calls are correlated by `retell_call_id`, falling back to caller + tenant.

```
curl -X POST http://localhost:8080/api/housecallpro/retell/webhook -H "Content-Type: application/json" -d "{\"event\": \"call_inbound\", \"call_inbound\": {\"to_number\": \"+18185551234\", \"from_number\": \"9176179615\"}}"
```

### Case A — Customer found (mobile matches)
```json
{"call_inbound":{"override_agent_id":"agent_xxx","dynamic_variables":{"status":"found","identified":"true","customer_id":"cus_a4e202950f6447fd8d3b1a7e9d9cd531","customer_name":"Matt Sollett","caller_name":"Matt","first_name":"Matt","last_name":"Sollett","from_number":"9176179615","new_number_detected":"false","multiple_matches":"false","candidates_count":"0","candidates":"[]"}}}
```

### Case B — Customer not found (mobile not in cache)
```json
{"call_inbound":{"override_agent_id":"agent_xxx","dynamic_variables":{"status":"not_found","identified":"false","customer_id":"","customer_name":"","caller_name":"","first_name":"","last_name":"","from_number":"5551230000","new_number_detected":"true","multiple_matches":"false","candidates_count":"0","candidates":"[]"}}}
```

### Case C — Multiple matches (shared number)
```json
{"call_inbound":{"override_agent_id":"agent_xxx","dynamic_variables":{"status":"multiple_matches","identified":"false","from_number":"9176179615","multiple_matches":"true","candidates_count":"2","candidates":"[{\"id\":\"cus_a4e...\",\"name\":\"Matt Sollett\"},{\"id\":\"cus_b12...\",\"name\":\"Anne Sollett\"}]"}}}
```

### call_started (swap temp → real call_id)
```
curl -X POST http://localhost:8080/api/housecallpro/retell/webhook -H "Content-Type: application/json" -d "{\"event\": \"call_started\", \"call\": {\"call_id\": \"call_abc123\", \"to_number\": \"+18185551234\", \"from_number\": \"9176179615\"}}"
```
```json
{"ok":true}
```

---

## Step 3a — Lookup customer fuzzy *(if not_found)*

Office-Hours only. Agent asks for a name (optionally address/zip) and calls this.

```
curl -X POST http://localhost:8080/api/housecallpro/fn/lookup_customer_fuzzy -H "Content-Type: application/json" -d "{\"call\": {\"call_id\": \"call_abc123\"}, \"args\": {\"name\": \"Matt Sollett\", \"zip\": \"91506\"}}"
```

**Expected response**
```json
{"result":"{\"status\":\"found\",\"identified\":true,\"confidence_tier\":1,\"requires_review\":false,\"customer_id\":\"cus_a4e202950f6447fd8d3b1a7e9d9cd531\",\"customer_name\":\"Matt Sollett\",\"first_name\":\"Matt\",\"last_name\":\"Sollett\",\"tier_reason\":\"name_exact_single_customer\"}"}
```

Other statuses: `multiple_matches` (with `candidates[]`), or `not_found` (agent then offers to create a new customer).

---

## Step 3b — Confirm customer *(if multiple_matches)*

Pass the `id` of the candidate the caller confirmed.

```
curl -X POST http://localhost:8080/api/housecallpro/fn/confirm_customer -H "Content-Type: application/json" -d "{\"call\": {\"call_id\": \"call_abc123\"}, \"args\": {\"candidate_id\": \"cus_a4e202950f6447fd8d3b1a7e9d9cd531\"}}"
```

**Expected response**
```json
{"result":"{\"status\":\"confirmed\",\"customer_id\":\"cus_a4e202950f6447fd8d3b1a7e9d9cd531\",\"customer_name\":\"Matt Sollett\",\"first_name\":\"Matt\",\"last_name\":\"Sollett\"}"}
```

---

## Step 3c — Create customer *(if not_found and no fuzzy match)*

Non-customer flow. `mobile_number` defaults to the caller's number when omitted. The customer is created in HCP (`POST /customers`, tagged `Clara`), cached, and set on the session.

```
curl -X POST http://localhost:8080/api/housecallpro/fn/create_customer -H "Content-Type: application/json" -d "{\"call\": {\"call_id\": \"call_abc123\"}, \"args\": {\"first_name\": \"Jane\", \"last_name\": \"Doe\", \"email\": \"jane@example.com\"}}"
```

**Expected response**
```json
{"result":"{\"status\":\"created\",\"customer_id\":\"cus_9f0e...\",\"customer_name\":\"Jane Doe\"}"}
```

---

## Step 3d — Match address *(after customer identified)*

Fetches the customer's addresses (once, cached in `service_address_map`) and fuzzy-matches the spoken address.

```
curl -X POST http://localhost:8080/api/housecallpro/fn/match_address -H "Content-Type: application/json" -d "{\"call\": {\"call_id\": \"call_abc123\"}, \"args\": {\"spoken_address\": \"416 North Reese Place\"}}"
```

**Expected response**
```json
{"result":"{\"status\":\"matched\",\"address_id\":\"adr_4f68db6cfc2d4dbb9c5b33dba282aeaa\",\"address\":\"416 N Reese Pl, Burbank, CA 91506\"}"}
```

Other statuses: `ambiguous` (with `candidates[]`), `not_found`, or `no_addresses` → collect the address and call `create_address`.

---

## Step 3e — Create address *(if match_address is not_found / no_addresses)*

```
curl -X POST http://localhost:8080/api/housecallpro/fn/create_address -H "Content-Type: application/json" -d "{\"call\": {\"call_id\": \"call_abc123\"}, \"args\": {\"street\": \"123 Main St\", \"city\": \"San Diego\", \"state\": \"CA\", \"zip\": \"92101\"}}"
```

**Expected response**
```json
{"result":"{\"status\":\"created\",\"address_id\":\"adr_0b9f...\",\"address\":\"123 Main St, San Diego, CA 92101\"}"}
```

The new `address_id` becomes the session's selected address, so `book_job` can omit it.

---

## Step 3f — Book job

Office-Hours only. Creates the job in HCP (`POST /jobs`) as an **unscheduled "new job"** — no `schedule` and no `line_items` are sent, so it lands in the office's New pipeline for them to schedule. `service_name` describes the issue; `scheduled_start`/`scheduled_end` are optional and only capture the caller's *requested* window (recorded in the job `notes` as free text — not a booked time). `address_id` is optional — the selected address from match/create is used if omitted.

The job's `lead_source` is resolved from the dialed tracking line (`to_number` / `lead_source_number`) via `housecallpro_lead_sources`, falling back to `Clara` when no mapping exists. The request writes `housecallpro_jobs` (the requested window is kept there for our records only).

The job `notes` sent to HCP look like:
```
Issue Description :- AC not cooling
Job between 2026-07-24T14:00:00 to 2026-07-24T16:00:00
```

```
curl -X POST http://localhost:8080/api/housecallpro/fn/book_job -H "Content-Type: application/json" -d "{\"call\": {\"call_id\": \"call_abc123\"}, \"args\": {\"service_name\": \"AC not cooling\", \"scheduled_start\": \"2026-07-24T14:00:00\", \"scheduled_end\": \"2026-07-24T16:00:00\"}}"
```

**Expected response** (no scheduled times; `work_status` is HCP's new-job status, `scheduled:false`)
```json
{"result":"{\"status\":\"created\",\"job_id\":\"job_5f2c...\",\"invoice_number\":\"1042\",\"work_status\":\"new job\",\"scheduled\":false}"}
```

---

## Step 3g — Escalate *(After-Hours)*

After-Hours captures the request instead of booking. Sets `escalation_type` / `escalation_summary` on the session and emails the tenant inbox.

```
curl -X POST http://localhost:8080/api/housecallpro/fn/escalate -H "Content-Type: application/json" -d "{\"call\": {\"call_id\": \"call_abc123\"}, \"args\": {\"escalation_type\": \"emergency\", \"summary\": \"No cooling, caller Matt Sollett, callback 917-617-9615\", \"caller_name\": \"Matt Sollett\"}}"
```

**Expected response**
```json
{"result":"{\"status\":\"captured\",\"escalation_type\":\"emergency\",\"message\":\"Your request has been logged. Our team will follow up during business hours.\"}"}
```

---

## Step 4 — End call

```
curl -X POST http://localhost:8080/api/housecallpro/retell/webhook -H "Content-Type: application/json" -d "{\"event\": \"call_ended\", \"call\": {\"call_id\": \"call_abc123\", \"disconnection_reason\": \"user_hangup\"}}"
```
```json
{"ok":true}
```

---

## Admin — Sync

**First-time full ingestion** (standalone script; no server needed):
```
npm run hcp:ingest -- --no=+18185551234
```

**On-demand full ingestion via HTTP:**
```
curl -X POST "http://localhost:8080/api/housecallpro/sync?no=+18185551234"
```
```json
{"ok":true,"tenant_id":"714899a2-...","pages":43,"customers_upserted":4282}
```

The scheduled edge function `housecallpro_cron` then keeps the cache incrementally in sync (one page per run, advancing `housecallpro_tokens.sync_customer_page`).

---

## Mistakes & Gotchas

### 1. `from_number` not matching → `status: not_found`
Identification uses `housecallpro_customers.normalized_mobile` (the generated last-10 of `mobile_number`). If the caller's number is not cached, the session is created but returns `not_found`. The Office-Hours agent continues with `lookup_customer_fuzzy` / `create_customer`.
**Fix:** run the first-time ingestion (or the cron) so the tenant's customers are cached.

### 2. `normalized_mobile` is null → never matches
`normalized_mobile` is a generated column added by `migrations/20260723_001_housecallpro_customer_phone_and_sync.sql`. If that migration has not been applied, phone identification silently returns `not_found` for everyone.
**Fix:** apply the migration.

### 3. `create_address` / `book_job` → `"error: no customer identified yet"`
These require `housecallpro_callsessions.housecallpro_customer_id` to be set — i.e. the caller must be identified (phone match, `confirm_customer`, `lookup_customer_fuzzy` accept, or `create_customer`) first.
**Fix:** run the identification step before address/booking.

### 4. `book_job` → `"error: no address selected"`
`book_job` needs an `address_id` — either passed explicitly or set as the session's selected address by a prior `match_address` (matched) or `create_address`.
**Fix:** call `match_address`/`create_address` first, or pass `address_id`.

### 5. `book_job` → `"error: job creation failed — HCP POST /jobs → 422 ..."`
HCP rejected the payload — usually an `address_id` that does not belong to the customer. (No `schedule` or `line_items` are sent anymore, so those are no longer a source of 422s.)
**Fix:** use an `address_id` from this customer's `match_address`/`create_address`.

### 6. `create_customer` FK error on cache upsert
The new customer is cached via a composite FK to `housecallpro_tokens(tenant_id)`. If the token row's `tenant_id` differs from the session's, the cache upsert fails (the HCP customer is still created). This should not happen in normal flow since both come from the same token.

### 7. Session not found on `/fn/*`
`/fn/*` looks up the session by `retell_call_id`. If `call_started` never fired (so the real `call_id` was never swapped in), it falls back to the most recent active session for caller + tenant. A private/withheld caller number can break the fallback.
**Fix:** ensure Retell sends `call_started`; it is wired to the same webhook URL automatically.

---

## Retell Webhook & Custom Function URL Setup

### Inbound Webhook URL

Set on the **phone number** (`inbound_webhook_url`), not the agent. It populates the `status` / `customer_id` / `caller_name` dynamic variables at call start.

```
https://crm-appointment-scheduler.vercel.app/api/housecallpro/retell/webhook
```

**Retell API:**
```
PATCH https://api.retellai.com/v2/phone-numbers/{phoneNumber}
Authorization: Bearer <RETELL_API_KEY>
Content-Type: application/json

{ "inbound_webhook_url": "https://crm-appointment-scheduler.vercel.app/api/housecallpro/retell/webhook" }
```

**Retell dashboard:** Phone Numbers → select number → *Inbound Webhook URL* → paste → Save.

The same endpoint also receives `call_started` and `call_ended` — no separate registration needed.

### Custom Function URLs

Configured per-function in the agent's LLM/tools (these are already present in the exported agent JSONs under `retellLlmData.general_tools`).

**URL pattern:** `https://crm-appointment-scheduler.vercel.app/api/housecallpro/fn/<function_name>`

| Function | Agent | URL |
|---|---|---|
| `lookup_customer_fuzzy` | Office | `.../api/housecallpro/fn/lookup_customer_fuzzy` |
| `confirm_customer` | Office | `.../api/housecallpro/fn/confirm_customer` |
| `create_customer` | Office | `.../api/housecallpro/fn/create_customer` |
| `match_address` | Office | `.../api/housecallpro/fn/match_address` |
| `create_address` | Office | `.../api/housecallpro/fn/create_address` |
| `book_job` | Office | `.../api/housecallpro/fn/book_job` |
| `escalate` | After-Hours | `.../api/housecallpro/fn/escalate` |

### Dynamic variables supplied at call start

| Variable | Meaning |
|---|---|
| `{{status}}` | `found` / `not_found` / `multiple_matches` / `error` |
| `{{customer_id}}` | HCP customer id (`cus_...`) when found |
| `{{customer_name}}` | Full name when found |
| `{{caller_name}}` | First name (After-Hours greeting) |
| `{{first_name}}` / `{{last_name}}` | Name parts when found |
| `{{from_number}}` | Caller number |
| `{{new_number_detected}}` | `true` when the caller was not matched |
| `{{multiple_matches}}` / `{{candidates}}` | Disambiguation list |

`BASE_URL` in `.env` must be this server's public origin (`https://crm-appointment-scheduler.vercel.app`); for local testing tunnel with `ngrok http 8080`.

---

## Full End-to-End Call Flow

### 1. `POST /api/housecallpro/retell/webhook` — event: `call_inbound`

**Triggered by:** Retell, automatically on every inbound call to the tenant's `to_number`.
**Router:** [src/routes/housecallpro.ts](../../src/routes/housecallpro.ts)

| Step | Operation | Table / Service |
|---|---|---|
| 1 | Resolve tenant by `to_number` | `resolveByInboundNumber()` → `housecallpro_tokens` |
| 2 | Insert session (`status = 'active'`) | `createCallSession()` → `housecallpro_callsessions` |
| 3 | Normalize caller to last-10, match | `findCustomersByPhone()` → `housecallpro_customers.normalized_mobile` |

Outcomes: `0 → not_found`, `1 → found` (matched customer written to session), `2+ → multiple_matches`. `override_agent_id` = the token's `agent_id`.

### 2. `POST /api/housecallpro/fn/lookup_customer_fuzzy` *(Office, if not_found)*

**Handler:** `handleLookupFuzzy` → `getFuzzyCandidates()` (`housecallpro_customers`, name trigram) → tier scoring → on accept `setMatchedCustomer()` (`housecallpro_callsessions`). Returns `found` / `multiple_matches` / `not_found`.

### 3. `POST /api/housecallpro/fn/confirm_customer` *(if multiple_matches)*

**Handler:** `handleConfirmCustomer` → `getCustomerByHcpId()` → `setMatchedCustomer()`.

### 4. `POST /api/housecallpro/fn/create_customer` *(Office, if not_found & no fuzzy match)*

**Handler:** `handleCreateCustomer` → HCP `POST /customers` (tag `Clara`) → `upsertCustomer()` (`housecallpro_customers`) → `setMatchedCustomer()`.

### 5. `POST /api/housecallpro/fn/match_address` *(Office)*

**Handler:** `handleMatchAddress` → HCP `GET /customers/{id}/addresses` (cached into `service_address_map`) → fuzzy score → returns `matched` / `ambiguous` / `not_found` / `no_addresses`; selected `address_id` stored on session.

### 6. `POST /api/housecallpro/fn/create_address` *(Office, if needed)*

**Handler:** `handleCreateAddress` → HCP `POST /customers/{id}/addresses` → `appendAddressId()` (`housecallpro_customers`) → set selected address on session.

### 7. `POST /api/housecallpro/fn/book_job` *(Office)*

**Handler:** `handleBookJob`

| Step | Operation | Table / Service |
|---|---|---|
| 1 | Verify `housecallpro_customer_id` + `address_id` | `housecallpro_callsessions` |
| 2 | Create job | HCP `POST /jobs` |
| 3 | Persist job | `insertJob()` → `housecallpro_jobs` |
| 4 | Mark session `job_created` + record slot | `setJobCreated()`, `setSelectedSlot()` → `housecallpro_callsessions` |
| 5 | Notify (best-effort) | SendGrid (`emailto` / `ccMail`) |

### 7-alt. `POST /api/housecallpro/fn/escalate` *(After-Hours)*

**Handler:** `handleEscalate` → `setEscalation()` (`status = 'escalated'`) → SendGrid notification. No job created.

### 8. `POST /api/housecallpro/retell/webhook` — event: `call_ended`

**Handler:** `setStatus()` → `housecallpro_callsessions` (maps Retell `disconnection_reason`, else `ended`).

### Summary Table

| # | Endpoint | Trigger | Handler | DB tables touched | External API |
|---|---|---|---|---|---|
| 1 | `POST /retell/webhook` (`call_inbound`) | Retell — automatic | router | `housecallpro_tokens`, `housecallpro_callsessions`, `housecallpro_customers` | — |
| 2 | `POST /fn/lookup_customer_fuzzy` | Office agent — when `not_found` | `handleLookupFuzzy` | `housecallpro_customers`, `housecallpro_callsessions` | — |
| 3 | `POST /fn/confirm_customer` | Office agent — when `multiple_matches` | `handleConfirmCustomer` | `housecallpro_customers`, `housecallpro_callsessions` | — |
| 4 | `POST /fn/create_customer` | Office agent — new caller | `handleCreateCustomer` | `housecallpro_customers`, `housecallpro_callsessions` | HCP `POST /customers` |
| 5 | `POST /fn/match_address` | Office agent — after identify | `handleMatchAddress` | `housecallpro_callsessions` | HCP `GET /customers/{id}/addresses` |
| 6 | `POST /fn/create_address` | Office agent — address not found | `handleCreateAddress` | `housecallpro_customers`, `housecallpro_callsessions` | HCP `POST /customers/{id}/addresses` |
| 7 | `POST /fn/book_job` | Office agent — customer + address set | `handleBookJob` | `housecallpro_jobs`, `housecallpro_callsessions` | HCP `POST /jobs` |
| 7-alt | `POST /fn/escalate` | After-Hours agent — request captured | `handleEscalate` | `housecallpro_callsessions` | SendGrid |
| 8 | `POST /retell/webhook` (`call_ended`) | Retell — automatic | router | `housecallpro_callsessions` | — |
