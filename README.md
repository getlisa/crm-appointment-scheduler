# crm-appointment-scheduler

Node backend for ServiceTitan, BuildOps, and HouseCall Pro integrations — technician scheduling, inbound call handling, and job creation via AI voice agent.

---

## ServiceTitan

Handles technician scheduling and appointment management for ServiceTitan tenants.

### Endpoints

- `POST /api/servicetitan/connect`
- `POST /api/servicetitan/sync?tenantId=<id>&date=YYYY-MM-DD`
- `GET /api/servicetitan/schedule?tenantId=<id>&date=YYYY-MM-DD`
- `GET /api/servicetitan/availability?tenantId=<id>&date=YYYY-MM-DD&duration=120`

### Expected Supabase tables

- `st_tenants`
- `st_technicians`
- `st_appointments`
- `st_appointment_assignments`

### API reference

See [servicetitan_api.md](servicetitan_api.md).

---

## BuildOps

Handles inbound HVAC service calls routed through Retell AI. When a customer calls, the agent identifies them via phone lookup and fuzzy name/address search, then creates a job in BuildOps — all within the call.

### Endpoints

- `POST /api/buildops/retell/webhook` — Retell lifecycle events (`call_inbound`, `call_ended`)
- `POST /api/buildops/fn/lookup_customer_fuzzy` — Fuzzy name/address/zip customer search
- `POST /api/buildops/fn/confirm_customer` — Confirm candidate from multiple matches
- `POST /api/buildops/fn/match_property` — Fuzzy-match spoken address to a property
- `POST /api/buildops/fn/prepare_job` — Account status check + job creation
- `POST /api/buildops/fn/add_representative` — Create new contact on account
- `POST /api/buildops/admin/tenant` — Register or update a tenant
- `GET  /api/buildops/admin/tenants` — List all tenants (no secrets)

### How it works

1. **Inbound call** (`call_inbound`): tenant resolved by called number, caller phone looked up against `buildops_customers`. Single match auto-confirms; multiple matches hand off to agent disambiguation; no match triggers fuzzy search.
2. **Fuzzy search** (`lookup_customer_fuzzy`): agent sends caller-provided name/address; scored via Jaro-Winkler, Soundex, and token-set ratio across weighted fields.
3. **Job creation** (`prepare_job`): live account status checked via BuildOps API; blocked accounts (creditHold, inactive, suspended, collections) are refused. Job created immediately during the call.
4. **Call ended** (`call_ended`): session marked closed.

### Retell custom functions

| Function | Endpoint | Handler | Purpose |
|---|---|---|---|
| `lookup_customer_fuzzy` | `POST /api/buildops/fn/lookup_customer_fuzzy` | `handleLookupFuzzy` | Name/address/zip fuzzy search |
| `confirm_customer` | `POST /api/buildops/fn/confirm_customer` | `handleConfirmCustomer` | Confirm which candidate from multiple matches |
| `match_property` | `POST /api/buildops/fn/match_property` | `handleMatchProperty` | Fuzzy-match spoken address to a property |
| `prepare_job` | `POST /api/buildops/fn/prepare_job` | `handlePrepareJob` | Validate account + create job during call |
| `add_representative` | `POST /api/buildops/fn/add_representative` | `handleAddRepresentative` | Create new named contact on the account |

### Expected Supabase tables

- `buildops_tenants` — one row per HVAC company (inbound number → tenant credentials)
- `buildops_customers` — mirrored customer + all phone numbers (GIN indexed)
- `buildops_properties` — service locations per customer
- `buildops_representatives` — contacts/reps per customer
- `buildops_inbound_calls` — active call sessions
- `buildops_jobs` — mirrored job records

Migration: [migrations/buildops/20260512_001_buildops_core_tables.sql](migrations/buildops/20260512_001_buildops_core_tables.sql)

### Sync

Customer, property, and representative data is kept in sync via a cron job:

- **Full sync** — fetches all records from BuildOps API, upserts to Supabase. Run once on first setup.
- **Incremental sync** — detects dirty records via rep changes, property timestamps, and customer version bumps. Runs on a schedule.
- **Jobs sync** — watermarked by `MAX(last_updated_at)` from `buildops_jobs`; fetches only jobs updated since the last run.

See [docs/buildops/sync.md](docs/buildops/sync.md) for full details.

### Env

- `BUILDOPS_API_URL=https://public-api.live.buildops.com`
- `LLM_ID=...` (Retell agent/LLM ID to override on inbound)

### Documentation

| Doc | Contents |
|---|---|
| [docs/buildops/call-flow.md](docs/buildops/call-flow.md) | Full webhook lifecycle, all custom functions, outcome cases |
| [docs/buildops/fuzzy-search.md](docs/buildops/fuzzy-search.md) | Matching algorithms, scoring weights, threshold bands, multiple-match handling |
| [docs/buildops/database-schema.md](docs/buildops/database-schema.md) | Supabase table schemas and indexes |
| [docs/buildops/sync.md](docs/buildops/sync.md) | Full and incremental sync architecture, dirty detection, deletion handling |
| [buildops_api.md](buildops_api.md) | BuildOps REST API reference (all 16 endpoints) |

---

## HouseCall Pro

Handles inbound HVAC service calls routed through Retell AI for HouseCall Pro (HCP) tenants. Auth is a static per-tenant API key (`Authorization: Token <api_key>` in `housecallpro_tokens`, keyed by the dialed number). When a customer calls, the agent identifies them, resolves the service address, and **logs a job in HCP** — all within the call.

### Endpoints

- `POST /api/housecallpro/retell/webhook` — Retell lifecycle (`call_inbound` identify+greet, `call_started`, `call_ended`)
- `POST /api/housecallpro/fn/lookup_customer_fuzzy` — Fuzzy name/zip customer search
- `POST /api/housecallpro/fn/confirm_customer` — Confirm candidate from multiple matches
- `POST /api/housecallpro/fn/create_customer` — Create a new customer (non-customer flow)
- `POST /api/housecallpro/fn/match_address` — Fuzzy-match a spoken address to a customer address
- `POST /api/housecallpro/fn/create_address` — Add a new service address
- `POST /api/housecallpro/fn/book_job` — Log the service request as a job
- `POST /api/housecallpro/fn/escalate` — After-Hours request capture
- `POST /api/housecallpro/admin/token`, `GET /api/housecallpro/admin/tokens`, `POST /api/housecallpro/sync`, `GET /api/housecallpro/admin/sync-status`

### Job creation

`book_job` creates the job in HCP (`POST /jobs`) as an **unscheduled "new job"** — it sends **no `schedule` and no `line_items`**, so the job lands in the office's *New* pipeline for them to schedule themselves. The issue and the caller's requested availability are captured as free text in the job **`notes`**:

```
Issue Description :- <issue the caller described>
Job between <requested start> to <requested end>
```

The row is mirrored to `housecallpro_jobs` (the requested window is kept there as an internal record only — it is not sent to HCP), and the agent tells the caller their request is logged and the team will confirm the appointment time (it never promises a booked slot).

### Lead-source attribution

The number the customer originally dialed is an HCP marketing/tracking line (a Google LSA line, a Yelp line, etc.). It is preserved through the telephony flow and surfaced to the webhook as `lead_source_number` (= Retell's `to_number`) — see [docs/housecallpro/lead-source-attribution.md](docs/housecallpro/lead-source-attribution.md) for how the tracking line survives the forward. At booking time `book_job` (and `create_customer`) look that number up in the `housecallpro_lead_sources` table (`lead_phone_no` → `lead_name` / `lead_source_id`) and stamp the resolved lead source onto the job/customer's `lead_source`, falling back to `Clara` when the line has no mapping. This attributes every booked job to the marketing source the customer actually called.

### Expected Supabase tables

- `housecallpro_tokens` — one row per HCP tenant (dialed number → API key, agent id, sync cursor)
- `housecallpro_customers` — mirrored customers (`normalized_mobile` for caller ID, trigram-indexed names, `address_ids`)
- `housecallpro_callsessions` — active call sessions (match tier, selected slot/address, escalation)
- `housecallpro_jobs` — mirrored job records
- `housecallpro_lead_sources` — dialed tracking line → HCP lead source (for attribution)

Migrations: [migrations/20260722_001_housecallpro_jobs.sql](migrations/20260722_001_housecallpro_jobs.sql), [migrations/20260723_001_housecallpro_customer_phone_and_sync.sql](migrations/20260723_001_housecallpro_customer_phone_and_sync.sql), [migrations/20260731_001_housecallpro_lead_sources.sql](migrations/20260731_001_housecallpro_lead_sources.sql)

### Sync

The `housecallpro_cron` Supabase Edge Function keeps `housecallpro_customers` in sync one page per run (advancing `housecallpro_tokens.sync_customer_page`), with per-row dirty detection against `housecallpro_updated_at`. First-time ingestion is triggered via `POST /api/housecallpro/sync?no=<number>`.

### Documentation

| Doc | Contents |
|---|---|
| [docs/housecallpro/endpoint_responses.md](docs/housecallpro/endpoint_responses.md) | Every endpoint's request/response, admin sync, gotchas |
| [docs/housecallpro/lead-source-attribution.md](docs/housecallpro/lead-source-attribution.md) | How the dialed HCP tracking line is recovered and surfaced as `lead_source_number` |

---

## Run

```bash
npm install
npm run dev
```

## Env (shared)

- `PORT=8080`
- `SUPABASE_URL=...`
- `SUPABASE_SERVICE_ROLE_KEY=...`
- `SERVICETITAN_ENV=integration`
- `SERVICETITAN_CAMPAIGN_ID=...` (JPM job booking campaign)
