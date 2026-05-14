# crm-appointment-scheduler

Node backend for ServiceTitan and BuildOps integrations — technician scheduling, inbound call handling, and job creation via AI voice agent.

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
