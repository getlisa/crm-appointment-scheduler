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

- `POST /api/buildops/retell/webhook` — Retell AI webhook (call lifecycle + tool calls)

### How it works

1. **Inbound call** (`call_inbound`): tenant resolved by called number, caller phone looked up against `buildops_customers`. Single match auto-confirms; multiple matches hand off to agent disambiguation; no match triggers fuzzy search.
2. **Fuzzy search** (`lookup_customer_fuzzy`): agent sends caller-provided name/address; scored via Jaro-Winkler, Soundex, and token-set ratio across weighted fields.
3. **Job creation** (`prepare_job`): live account status checked via BuildOps API; blocked accounts (creditHold, inactive, suspended, collections) are refused. Job created immediately during the call.
4. **Call ended** (`call_ended`): session marked closed.

### Retell custom functions

| Function | Handler | Purpose |
|---|---|---|
| `lookup_customer_by_phone` | `handleLookupByPhone` | GIN exact-match on caller's number |
| `lookup_customer_fuzzy` | `handleLookupFuzzy` | Scored fuzzy search by name/address |
| `confirm_customer` | `handleConfirmCustomer` | Disambiguate multiple matches |
| `get_properties_for_customer` | `handleGetProperties` | List service locations |
| `match_property` | `handleMatchProperty` | Select a property from the list |
| `prepare_job` | `handlePrepareJob` | Blocked-status check + job creation |
| `add_task_to_job` | `handleAddTaskToJob` | Append task line items to a job |
| `save_caller_number` | `handleSaveCallerNumber` | Persist a new phone number |
| `add_representative` | `handleAddRepresentative` | Create a new contact on the account |
| `transfer_call` | `handleTransferCall` | Route call to department/on-call tech |

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
- `RETELL_LLM_ID=...` (Retell agent/LLM ID to override on inbound)

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
