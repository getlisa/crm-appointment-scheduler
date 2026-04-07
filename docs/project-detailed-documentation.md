# CRM Appointment Scheduler - Detailed Project Documentation

## 1) Project overview

`crm-appointment-scheduler` is a Node.js + TypeScript backend that integrates with ServiceTitan and exposes APIs for:

- tenant connection and credential storage
- CRM/job-type synchronization into Supabase
- job type resolution from customer reason text
- technician matching by skills
- availability checking across job + non-job technician events
- customer/location resolution
- final job booking in ServiceTitan

The app is designed for agent workflows (for example voice/AI assistants) that need to go from free-text issue description to confirmed appointment slot.

## 2) Tech stack

- Runtime: Node.js (ESM)
- HTTP server: Express + CORS
- Validation: Zod
- Data storage/cache: Supabase (`@supabase/supabase-js`)
- Build tooling: TypeScript + `tsx`

Key scripts (`package.json`):

- `npm run dev` -> watch-mode server via `tsx`
- `npm run build` -> TypeScript compile
- `npm run check` -> TypeScript type check (no emit)

## 3) Runtime entrypoint and routing

Server entrypoint: `src/server.ts`

- Registers JSON body parser and permissive CORS.
- Exposes health check:
  - `GET /health`
- Mounts ServiceTitan routes:
  - `/api/servicetitan/*` from `src/routes/servicetitan.ts`

## 4) Environment configuration

Environment parsing: `src/config/env.ts`

Required variables:

- `SERVICETITAN_CAMPAIGN_ID`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Optional variables:

- `PORT` (defaults to `8080`)
- `SERVICETITAN_ENV` (`integration` or `production`, default `integration`)
- `SERVICETITAN_FALLBACK_TECHNICIAN_ID` (used when no skill match)

## 5) High-level architecture

### 5.1 Route layer

File: `src/routes/servicetitan.ts`

Responsibilities:

- request parsing/validation (`zod`)
- orchestration of service/client calls
- timezone-aware output shaping
- stable API response contracts (`{ success, data|error }`)

### 5.2 ServiceTitan client layer

File: `src/services/servicetitan/client.ts`

Responsibilities:

- OAuth token management
- REST calls to ServiceTitan endpoints
- pagination where needed
- per-technician daily schedule assembly
- normalization of non-job events into blockable windows

### 5.3 Scheduling/availability engine

Files:

- `src/services/servicetitan/availability.ts`
- `src/services/servicetitan/agent-check.ts`
- `src/services/servicetitan/date-window.ts`

Responsibilities:

- compute free slots from technician shifts and busy windows
- support specific-window validation and day-slots search modes
- generate alternatives and global earliest options
- convert between local wall-clock and UTC safely

### 5.4 Persistence/cache layer

Files:

- `src/services/servicetitan/store.ts`
- `src/services/servicetitan/credentials.ts`
- `src/lib/supabase.ts`

Responsibilities:

- persist tenant credentials/timezone
- sync and cache technicians/job types/customers/locations
- load knowledge base for job-type matching
- helper lookups for customer/location resolution

## 6) Current API surface

All routes are under `/api/servicetitan`.

- `POST /connect`
- `POST /sync`
- `POST /agent/match-technicians`
- `GET /job-types/knowledge-base`
- `POST /agent/resolve-job-type`
- `POST /agent/check-availability`
- `POST /agent/check-availability-by-reason`
- `POST /agent/resolve-customer-location`
- `POST /agent/book`

For request/response examples, see:

- `docs/servicetitan-agent-apis.md`
- `docs/check-availability-by-reason-and-book.md`

## 6.1 API important points (must-know)

- All routes are mounted under `/api/servicetitan`.
- Standard response envelope:
  - success: `{ "success": true, "data": ... }`
  - error: `{ "success": false, "error": "<message>" }`
- All scheduling/booking APIs are tenant-scoped via `tenantId`.
- ServiceTitan upstream I/O is UTC-centric; response presentation is tenant-time localized.
- `check-availability-by-reason` is the high-level orchestration endpoint:
  - reason -> job type -> skills -> technician matching -> availability
- `book` does not accept `reason`; it needs resolved booking IDs/fields.
- `technicianId` in match/check payloads is often string; `book` requires numeric `technicianId`.
- Non-job events are included in blocking logic; missing non-job `end` is normalized safely.
- Fallback technician can be injected when no skill matches and env fallback is configured.
- `slotPreviewLimit` is bounded to avoid oversized responses.

## 6.2 API contracts (authoritative shape)

### Common contract

- Method: mostly `POST` (except `GET /job-types/knowledge-base`)
- Content type: `application/json` for `POST`
- Error status: typically `400` for validation and business-rule failures
- Validation: Zod schemas in `src/routes/servicetitan.ts`

### Contract snapshots by endpoint

1) `POST /connect`

- Request:
  - `tenantId` number
  - `clientId` string
  - `clientSecret` string
  - `appKey` string
  - `timezone` string (IANA)
- Success:
  - `success: true`
  - message string
- Side effects:
  - saves tenant credentials/timezone in Supabase

2) `POST /sync`

- Query:
  - `tenantId` number
  - `includeCrm` boolean (default true)
- Success data:
  - counts for synced entity totals
- Side effects:
  - upserts technicians/job types (+ customers/locations if enabled)

3) `POST /agent/resolve-job-type`

- Request:
  - `tenantId`, `reason`, optional `topN (1..10)`
- Success data:
  - `skills: string[]`
  - `duration: number | null`
  - `priority: string | null`
  - `businessId: number | null`
  - `jobTypeId: number | null`

4) `POST /agent/match-technicians`

- Request:
  - `tenantId`
  - `skills: string[]` (min 1)
- Success data:
  - array of `{ technicianId: string, name: string, matchedSkills: string[] }`

5) `POST /agent/check-availability`

- Request:
  - `tenantId`
  - `technicianIds: string[]`
  - optional `date`, `startTime`, `endTime`, `duration`, `slotPreviewLimit`
- Response modes:
  - `specific_window`
  - `day_slots`
  - `earliest_in_range`
- Output includes localized tenant-time windows.

6) `POST /agent/check-availability-by-reason`

- Request:
  - `tenantId`, `reason`, optional `topN`, `date`, `startTime|time`, `endTime`, `duration`, `slotPreviewLimit`
- Success data:
  - same mode payload as check-availability
  - plus booking context:
    - `jobTypeId`
    - `priority`
    - `businessId`

7) `POST /agent/resolve-customer-location`

- Request:
  - either `customerId + locationId`
  - or `customerName + phone + address`
- Success data:
  - resolved IDs + creation/match status fields

8) `POST /agent/book`

- Request:
  - booking identifiers and selected schedule window
  - plus customer/location identifiers or customer context
- Success data:
  - `jobId`, `appointmentId`, localized and UTC windows, and resolution status metadata

## 6.3 API contract invariants and guarantees

- Contract envelope remains consistent (`success` boolean + `data|error`).
- Availability result windows in response are tenant-localized display values.
- Booking output includes both localized values and UTC timestamps (`startUtc`, `endUtc`).
- `check-availability-by-reason` always returns booking context fields when successful.
- Validation prevents ambiguous time inputs (`startTime` and `time` together).
- Duration defaults and constraints are enforced in schema parsing.

## 7) End-to-end appointment flow

Typical happy path:

1. Connect tenant (`/connect`) and store credentials + timezone.
2. Sync metadata (`/sync`) to populate Supabase caches.
3. Resolve job type from customer reason (`/agent/resolve-job-type`).
4. Match technicians by required skills (`/agent/match-technicians`).
5. Check availability for matched technicians (`/agent/check-availability`) or run combined flow (`/agent/check-availability-by-reason`).
6. Resolve customer/location IDs (`/agent/resolve-customer-location`) if needed.
7. Book appointment (`/agent/book`).

## 8) Availability engine details

### 8.1 Time model

- ServiceTitan API request/response times are treated as UTC.
- Availability fetch windows currently use UTC day boundaries.
- Final API output is localized to tenant timezone in route responses (`toClientTime`).
- Booking request local times (`date`, `startTime`, optional `endTime`) are converted to UTC before POSTing to ServiceTitan.

### 8.2 Busy event model

Defined in `src/services/servicetitan/types.ts`:

- `TechnicianBusyEventSource`: `job_appointment | non_job_appointment`
- `TechnicianBusyEvent` contains:
  - `start`, `end`, source, optional status
  - `blocksBooking`
  - per-event pre/post buffers

`DailyTechnicianSchedule` contains both:

- `busyEvents` (primary source of truth)
- `appointments` (legacy compatibility field)

### 8.3 Job + non-job event ingestion

Inside `ServiceTitanClient.getDailyTechnicianSchedule(...)`:

- technician set is narrowed to `technicianIds` input when provided
- for each selected technician:
  - fetches job appointments via JPM appointments endpoint filtered by `technicianId`
  - fetches non-job appointments via dispatch non-job endpoint
- logs selected technician IDs for debugging
- normalizes non-job windows, including fallback behavior when end time is missing:
  - explicit end fields
  - duration-based end
  - fallback to queried UTC day end

### 8.4 Slot computation

`computeDailyAvailability(...)`:

- builds shift block from technician shift or fallback window
- converts busy events into buffered busy windows
- merges overlaps
- computes free gaps
- filters gaps by requested minimum duration

`agent-check.ts` adds:

- specific-window fit check + earliest alternatives
- day-slots mode + preview window expansion
- global earliest slot/alternative across technicians

## 8.5 Tricky logic and edge cases (important)

These are the highest-risk areas where subtle bugs can appear if behavior changes.

1) UTC upstream vs tenant-local output

- Upstream ServiceTitan calls for schedule windows are made in UTC day windows.
- User-facing payloads are converted to tenant timezone for readability.
- Booking input (`date`, `startTime`, optional `endTime`) is interpreted as tenant-local wall time and converted to UTC for ServiceTitan.
- Why tricky:
  - mixing UTC fetch windows with tenant-local display can create off-by-one-day confusion if changed carelessly.

2) Per-technician schedule fetch strategy

- Current availability flow fetches job and non-job events per selected technician (single-value `technicianId` filter).
- This replaced the old tenant-wide appointment fetch + assignment join path for live availability checks.
- Why tricky:
  - reducing scope improves accuracy and performance, but assumes filtered appointment API is assignment-correct for your tenant.

3) Non-job event normalization when `end` is missing

- Non-job payloads can return `start` with missing `end`.
- Normalization logic attempts:
  - explicit end fields (`end`, `endsOn`, `endTime`, `to`)
  - duration-derived end (`durationMinutes`, etc.)
  - final fallback: block until UTC day-end of query window
- Why tricky:
  - without fallback, blocking events can be silently dropped, causing false availability.

4) Busy event unification and buffer policy

- Availability uses a unified busy-event model:
  - `job_appointment` and `non_job_appointment`
- Buffer policy differs by source:
  - jobs: +/-30 minutes
  - non-jobs: 0 minutes
- Why tricky:
  - accidental buffer changes can dramatically alter slot outcomes.

5) Requested technician filtering and fallback behavior

- Schedules are built only for `technicianIds` provided by caller (or all when omitted).
- Skill matching may produce zero results; fallback technician can be injected by env.
- Why tricky:
  - if selected technician list is wrong, availability appears incorrect even if slot engine is correct.

6) Three availability modes with different semantics

- `specific_window`: validates exact requested window and returns alternatives.
- `day_slots`: returns earliest + preview windows for one day.
- `earliest_in_range`: no input date; anchor day is selected by aggregate shift-time logic.
- Why tricky:
  - mode-specific output shape and semantics are easy to mix up in client integrations.

7) Shift-window fallback behavior

- If technician shift bounds are missing/invalid, route-provided day window is used.
- Why tricky:
  - missing shift metadata can produce broader-than-expected search windows.

8) Slot preview expansion cap

- Preview windows are expanded in fixed duration increments.
- Hard cap protects output size and processing cost.
- Why tricky:
  - changing increment or cap changes UI behavior and perceived availability density.

9) Defensive parsing of non-job schemas

- Non-job appointment schema is treated as partially unknown (`Record<string, unknown>` style).
- Start/end/duration fields are resolved via tolerant field mapping.
- Why tricky:
  - upstream schema variants can break strict parsers; tolerant parsing prevents regressions.

10) Local date anchor logic (no-date mode)

- For no-date requests, anchor day is chosen from local current time vs aggregate technician shift window.
- Why tricky:
  - this can intentionally return tomorrow even when caller expected today, depending on local shift context.

## 8.6 Regression checklist for scheduling changes

Run this checklist after any change to time-window building, busy-event normalization, or slot computation.

1) Non-job event with missing end

- Input:
  - one non-job event with `start` present, `end` missing
- Expectation:
  - event still blocks via duration or day-end fallback
  - no false-positive slot during blocked period

2) Non-job event with explicit end

- Input:
  - non-job event with valid `start` + `end`
- Expectation:
  - exact blocked interval respected (no additional hidden extension beyond configured buffer policy)

3) Job + non-job overlap merge

- Input:
  - overlapping job and non-job intervals
- Expectation:
  - merged busy block used
  - no duplicate/fragmented artificial free gap

4) Technician-scoped fetch correctness

- Input:
  - request with a subset of technician IDs
- Expectation:
  - logs show only selected IDs fetched
  - no schedule API calls for non-selected technicians

5) Skill match + fallback behavior

- Input:
  - reason/skills with no match
- Expectation:
  - fallback technician is used only when env fallback is configured
  - otherwise clean no-technician-match error

6) UTC window integrity

- Input:
  - date-based availability request
- Expectation:
  - upstream schedule calls use UTC day bounds
  - output windows remain tenant-localized

7) Tenant-local booking conversion

- Input:
  - `book` request with local `date` + `startTime` (+ `endTime` or `duration`)
- Expectation:
  - ServiceTitan receives UTC timestamps
  - response includes both localized and UTC values

8) Specific-window mode validation

- Input:
  - `date` + `startTime` + `endTime` where window conflicts with busy event
- Expectation:
  - `fitsRequest=false`
  - meaningful `doesNotFitReason`
  - earliest alternative returned when available

9) Day-slots mode density and cap

- Input:
  - date-only mode with large open gaps and high/zero `slotPreviewLimit`
- Expectation:
  - preview list increments by duration-sized steps
  - cap logic respected, response size bounded

10) No-date anchor selection

- Input:
  - request without `date` around shift boundary times
- Expectation:
  - anchor strategy and selected date are consistent with local shift logic
  - earliest slot is computed on selected anchor day

11) Shift metadata missing

- Input:
  - technician with missing/invalid shift start/end
- Expectation:
  - fallback day window applied
  - slot computation still stable (no crash)

12) Multi-technician global earliest

- Input:
  - multiple technicians with different earliest slots
- Expectation:
  - `globalEarliestSlot` / `globalEarliestAlternative` points to true minimum start across all eligible technicians

13) Timezone edge day (DST transition)

- Input:
  - date near DST change in tenant timezone
- Expectation:
  - conversion remains consistent
  - no one-hour ghost slot or missing expected slot caused by conversion logic

14) Contract stability checks

- Input:
  - invoke all three availability modes
- Expectation:
  - envelope shape unchanged (`success`, `data|error`)
  - mode-specific fields present and type-stable

## 9) Technician matching and fallback behavior

Matching logic uses cached active technicians and checks skill-name overlap by normalized case-insensitive substring rules.

If no technicians match and `SERVICETITAN_FALLBACK_TECHNICIAN_ID` is configured:

- fallback technician is injected as last resort
- warning is logged for observability

## 10) Customer and location resolution

`resolveCustomerAndLocationIds(...)` in route layer:

- accepts direct IDs or customer context (name + phone + address)
- tries cache first, then ServiceTitan APIs
- can create customer/location when not found
- returns creation status flags used by response payload

Status values include:

- `ids_provided`
- `matched_existing`
- `customer_matched_location_created`
- `customer_created_location_matched`
- `customer_and_location_created`

## 11) Data/cache model in Supabase

Observed tables used by code:

- `servicetitan_tenants`
- `servicetitan_technicians`
- `servicetitan_job_types`
- `servicetitan_customers`
- `servicetitan_locations`
- `servicetitan_appointments`
- `servicetitan_appointment_assignments`

## 11.1 Database involvement by endpoint

- `/connect`
  - writes `servicetitan_tenants` credentials + timezone.
- `/sync`
  - writes:
    - `servicetitan_technicians`
    - `servicetitan_job_types`
    - optional CRM tables:
      - `servicetitan_customers`
      - `servicetitan_locations`
- `/agent/resolve-job-type`
  - reads `servicetitan_job_types` through knowledge-base loader.
- `/agent/match-technicians`
  - reads `servicetitan_technicians` and filters by skills.
- `/agent/check-availability*`
  - reads tenant credentials/timezone
  - fetches live ServiceTitan schedules
  - does not require cached appointment rows for live availability mode.
- `/agent/resolve-customer-location`
  - reads cached customers/locations first
  - may create entities in ServiceTitan
  - writes/upserts created or matched entities back to cache.
- `/agent/book`
  - resolves customer/location similarly
  - writes no direct booking row into Supabase in current implementation (books upstream in ServiceTitan).

## 11.2 Table purpose summary

- `servicetitan_tenants`
  - tenant auth and timezone source of truth for this service.
- `servicetitan_technicians`
  - active technician metadata, skills, shifts for matching/routing.
- `servicetitan_job_types`
  - normalized job-type cache for reason-to-job classification.
- `servicetitan_customers`, `servicetitan_locations`
  - CRM resolution cache to reduce repeated API lookups.
- `servicetitan_appointments`, `servicetitan_appointment_assignments`
  - snapshot/cached schedule data used by helper paths; live availability now uses per-tech upstream fetches.

Notes:

- credentials and timezone are stored per tenant
- sync APIs refresh cache rows with `updated_at`
- job-type knowledge base is built from cached job types

## 12) Logging and observability

Current logs include:

- ServiceTitan auth lifecycle (`Requesting new access token`, `Reusing cached access token`)
- outbound API request paths and query params
- selected technicians used for schedule fetch
- non-job appointment count and detailed events
- sync completion counts
- route-level structured error logging, including Zod flattening

## 13) Error handling strategy

- Input validation: strict Zod schemas with custom constraints.
- Operational/API errors: converted to HTTP `400` with `{ success: false, error }`.
- Route exception logger handles:
  - `ZodError` flatten output
  - standard `Error` message + stack
  - safe fallback stringification for unknown throws

## 14) Security and production guidance

- Never log or share raw bearer tokens/client secrets/app keys.
- Rotate credentials immediately if exposed.
- Consider redacting query logs in production if sensitive.
- Ensure service-role key is server-only and never sent to clients.

## 15) Known design choices and trade-offs

- Per-technician schedule fetch is now favored for availability (better relevance, less tenant-wide scanning).
- Non-job events with missing end are treated as blocking until day-end to avoid false availability.
- Legacy appointments field is still retained for compatibility while `busyEvents` is authoritative.
- Availability responses are localized; upstream API interactions remain UTC-centric.

## 16) Suggested next improvements

- Add unit tests for non-job normalization edge cases (missing end, duration fields, malformed timestamps).
- Add integration tests comparing availability before/after schedule strategy changes.
- Add concurrency controls/rate limiting for per-technician API fan-out.
- Add feature flags for verbose logs in production.
- Update `README.md` endpoint list (currently minimal/outdated compared to actual route surface).

## 17) Quick start (developer)

1. Add `.env` with required variables from section 4.
2. Install dependencies:
   - `npm install`
3. Run server:
   - `npm run dev`
4. Health check:
   - `GET /health`
5. Connect tenant and run sync before agent scheduling calls.

---

If you maintain this document, update it whenever route contracts, timezone behavior, or schedule-fetch strategy changes.
