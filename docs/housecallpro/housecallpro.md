# HouseCall Pro Integration — Overview (start here)

A Retell voice agent answers inbound calls for HouseCall Pro (HCP) tenants, identifies the
caller, resolves the service address, and **logs a job in HCP** — all within the call. This
is the map of how the pieces fit; the deeper docs are linked at the bottom.

---

## 1. Architecture & call routing

```
[ Customer ] dials an HCP tracking/marketing line (e.g. +17473492132 = "Angie's Leads")
     │  HCP forwards →
     ▼
[ Twilio number + Twilio Function ]  client.call.registerPhoneCall({
     │      from_number: caller,
     │      to_number:   tenant DID (+17478373403, matches housecallpro_tokens.no),
     │      retell_llm_dynamic_variables: { lead_source_number: <the tracking line> } })
     │  → <Dial><Sip> into Retell with the returned call_id
     ▼
[ Retell agent ]  — call is PRE-REGISTERED, so Retell does NOT fire call_inbound
     │  Reaches this backend only via:
     │    • POST /retell/webhook   event=call_started   ← session is created here
     │    • POST /retell/webhook   event=call_ended
     │    • POST /fn/*             custom-function calls during the conversation
     ▼
[ crm-appointment-scheduler ]  session state → book_job stamps the HCP job
```

**Auth:** static per-tenant API key (`Authorization: Token <api_key>`) in `housecallpro_tokens`,
resolved by the dialed number (`to_number` → `housecallpro_tokens.no`).

> **⚠️ Gotcha #1 — `call_inbound` never fires.** Because the Twilio Function pre-registers the
> call, Retell skips its inbound-call webhook entirely. Identification and session creation do
> **not** happen at `call_inbound`; they happen at `call_started` + `/fn/customer_lookup`. See
> [lead-source-attribution.md](./lead-source-attribution.md) §2.

---

## 2. Two agents

| Agent | Role | Terminal action |
|---|---|---|
| **Office Hours** | identify → (create) customer → match/create service address → **book the job** | `book_job` → HCP `POST /jobs` (unscheduled "new job") |
| **After Hours** | identify → capture the request | `escalate` (emails the tenant inbox; no booking) |

The agent configs live in [`retell/`](../../retell/) and are imported into Retell (their
`agent_id` is blank in the export, so import into the correct agent).

---

## 3. Office-Hours call flow

1. **`call_started`** → `ensureCallSession` creates `housecallpro_callsessions` with
   `caller = from_number`, `to_number`, `lead_source_number` (from the dynamic variable), and
   `retell_call_id`. `/fn/*` resolve the session by `retell_call_id` (create-if-missing fallback).
2. **Identify** — agent calls **`customer_lookup`** (phone match on the caller).
   - `found` → greet by first name → go to address.
   - `not_found` → **`lookup_customer_fuzzy`** (name/zip) → if still not found → **`create_customer`**.
   - `multiple_matches` → **`confirm_customer`** with the chosen candidate.
3. **Address** — **`match_address`** against the customer's saved addresses.
   - `ambiguous` / `not_found` → ask for the full address (street # + name + ZIP), retry `match_address`
     **once**, then **`create_address`**. `no_addresses` → `create_address`.
4. **Book** — **`book_job`** with a short `service_name` (+ optional requested window). Server
   resolves `customer_id`, `address_id`, and `lead_source` from session state (see §4).

---

## 4. Session state is the source of truth for `book_job`

The agent never threads IDs. `book_job` reads everything from the session set by prior steps:

| `book_job` input | Source (session) | Set by |
|---|---|---|
| `customer_id` | `housecallpro_customer_id` | `customer_lookup` / `confirm_customer` / `lookup_customer_fuzzy` / `create_customer` |
| `address_id` | `service_address_map.selectedAddressId` (or an explicit arg) | `match_address` (confident) / `create_address` |
| `lead_source` | `resolveLeadSource(lead_source_number ?? to_number)` → `lead_name` ?? `lead_source_id` ?? `Clara` | `call_started` captures `lead_source_number` |

> **⚠️ Gotcha #2 — HCP validates `lead_source` by name.** The stamped value must be an **exact
> configured lead source name** in that HCP account, or `POST /jobs` returns
> `400 "Lead source not found"` and no job is created. Keep `housecallpro_lead_sources.lead_name`
> in sync with HCP (mind whitespace/newlines).

---

## 5. Supabase tables

| Table | Purpose |
|---|---|
| `housecallpro_tokens` | one row per tenant: dialed number (`no`) → `api_key`, `agent_id`, `emailto`/`ccMail`, `sync_customer_page` |
| `housecallpro_customers` | mirrored customer cache: `normalized_mobile` (last-10, for caller ID), trigram-indexed names, `address_ids`, `lead_source` |
| `housecallpro_callsessions` | one row per call: matched customer, `service_address_map`, `lead_source_number`, status, job refs |
| `housecallpro_jobs` | mirrored records of jobs booked by the agent (requested window kept here only) |
| `housecallpro_lead_sources` | global map: dialed tracking line (`lead_phone_no`) → HCP `lead_name` / `lead_source_id` |

> **⚠️ Gotcha #3 — never delete the `id` column from `housecallpro_tokens`.** It is the table's
> primary-key UUID column. If it is edited out / dropped while managing tokens in the Supabase
> table editor, token upserts (`POST /api/housecallpro/admin/token`) and tenant resolution break.
> Add/edit rows freely, but leave the `id` column in place.

Migrations: [`20260722_001_housecallpro_jobs.sql`](../../migrations/20260722_001_housecallpro_jobs.sql),
[`20260723_001_housecallpro_customer_phone_and_sync.sql`](../../migrations/20260723_001_housecallpro_customer_phone_and_sync.sql),
[`20260731_001_housecallpro_lead_sources.sql`](../../migrations/20260731_001_housecallpro_lead_sources.sql),
[`20260731_002_housecallpro_callsession_lead_source_number.sql`](../../migrations/20260731_002_housecallpro_callsession_lead_source_number.sql).

---

## 6. Endpoints

Router: [`src/routes/housecallpro.ts`](../../src/routes/housecallpro.ts). Mounted at `/api/housecallpro`.

| Endpoint | Purpose |
|---|---|
| `POST /retell/webhook` | Retell lifecycle — `call_started` (create session), `call_ended`. (`call_inbound` never fires here; the handler remains only for a hypothetical direct-inbound tenant.) |
| `POST /fn/customer_lookup` | identify the caller by phone (replaces `call_inbound` identification) |
| `POST /fn/lookup_customer_fuzzy` | fuzzy name/zip lookup when the phone match failed |
| `POST /fn/confirm_customer` | confirm a candidate after `multiple_matches` |
| `POST /fn/create_customer` | create a new HCP customer (returns `first_name` for the greeting) |
| `POST /fn/match_address` | fuzzy-match the spoken address to a saved one (one retry rule) |
| `POST /fn/create_address` | add a new service address |
| `POST /fn/book_job` | log the service request as an HCP job |
| `POST /fn/escalate` | After-Hours request capture |
| `POST /admin/token`, `GET /admin/tokens`, `GET /admin/sync-status`, `POST /sync` | onboarding + sync |

---

## 7. Sync

The `housecallpro_cron` Supabase Edge Function keeps `housecallpro_customers` current one page
per run (advancing `housecallpro_tokens.sync_customer_page`), with per-row dirty detection
against `housecallpro_updated_at`. First-time full ingestion: `POST /api/housecallpro/sync?no=<number>`
or `npm run hcp:ingest -- --no=<number>`. If the cache is empty, phone identification returns
`not_found` for everyone.

---

## 8. Deeper docs

- [lead-source-attribution.md](./lead-source-attribution.md) — the Twilio-Function/`registerPhoneCall`
  flow, why `call_inbound` never fires, the `call_started` payload, and the lead-source rules.
- [endpoint_responses.md](./endpoint_responses.md) — every endpoint's request/response with curl
  examples, plus the full mistakes-&-gotchas list.
