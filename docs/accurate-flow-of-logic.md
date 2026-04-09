# Accurate Flow of Logic (Issue -> Technician -> Schedule -> Booking)

This document describes the exact logical flow currently implemented in the project, with practical implementation details and dependencies.

---

## 1) Purpose of this flow

Convert a customer-reported issue into a bookable appointment by:

1. understanding the issue
2. identifying skilled technicians
3. collecting each selected technician's job + non-job busy events
4. computing real availability
5. booking with validated IDs and times

---

## 2) Libraries and core modules used

### Runtime / framework

- `express` - HTTP API server and routing
- `cors` - cross-origin handling
- `dotenv` - environment loading
- `typescript` + `tsx` - compile and run TypeScript

### Validation and typing

- `zod` - request schema validation and coercion

### Data and storage

- `@supabase/supabase-js` - persistence for tenant credentials and sync/cache tables

### Internal logic modules

- `src/routes/servicetitan.ts` - orchestration layer (routes, schemas, request/response shaping)
- `src/services/servicetitan/client.ts` - ServiceTitan API client (auth, CRUD, schedule fetch)
- `src/services/servicetitan/availability.ts` - busy-to-free slot computation
- `src/services/servicetitan/agent-check.ts` - mode-specific availability outputs (`specific_window`, `day_slots`, `earliest_in_range`)
- `src/services/servicetitan/date-window.ts` - UTC/local time conversion, shift window aggregation, no-date anchor resolution
- `src/services/servicetitan/store.ts` - skill/job/customer/location DB helpers (Supabase reads/upserts)
- `src/services/servicetitan/credentials.ts` - tenant credential + timezone storage/retrieval
- `src/services/servicetitan/job-book-payload.ts` - builds ServiceTitan JPM job creation payload (appointment window, arrival window, technician IDs, campaign ID)
- `src/services/servicetitan/job-type-normalize.ts` - normalizes raw ServiceTitan job-type payloads (handles camelCase/PascalCase, duration extraction from multiple field names, skill array shapes)
- `src/services/servicetitan/types.ts` - shared TypeScript type definitions for all ServiceTitan models
- `src/config/env.ts` - environment variable schema validation (via `zod`) and typed env export

---

## 3) High-level canonical flow

`Customer issue -> job type resolution -> skill extraction -> technician matching -> technician-scoped schedule fetch (job + non-job) -> availability calculation -> customer/location resolution -> booking`

---

## 4) Detailed step-by-step runtime flow

## Step A - Receive issue from user

Entry point for combined flow:

- `POST /api/servicetitan/agent/check-availability-by-reason`

Retell / custom function runner compatibility:

- The route uses `normalizedRequestPayload(req)` which extracts from `body.arguments` if present, otherwise uses `body` directly. This enables Retell-style function calling where arguments are nested under `body.arguments`.

Inputs:

- `tenantId` (required, coerced from string to number)
- `reason` (required, free-text issue string)
- `topN` (optional, integer 1-10, default `3`) - controls how many top job-type matches to consider for skill extraction
- optional schedule constraints:
  - `date` (YYYY-MM-DD)
  - `startTime` or `time` (HH:MM or HH:MM:SS, `time` is Retell-friendly alias for `startTime`)
  - `endTime` (HH:MM or HH:MM:SS)
  - `duration` (positive integer, minutes - overrides duration from matched job type and the default 60)
  - `slotPreviewLimit` (integer 0-2000, default `0`)

Route parsing:

- Zod schemas validate and normalize request payload.
- `time` acts as alias for `startTime`; providing both simultaneously returns a validation error.
- `date` is required when `startTime` or `time` is set (enforced via `superRefine`).

## Step B - Resolve issue to job context

Route logic:

1. load job type knowledge base from DB cache (`servicetitan_job_types` where `is_active=true`, ordered by `name`)
2. score/rank all active job types against issue text using token-based scoring:
   - tokenization: split on non-alphanumeric, lowercase, discard single-char tokens
   - for each searchable field (`name`, `code`, `summary`, `intentHints`, `skillNames`):
     - exact token match in field tokens: **+3**
     - substring match within field text: **+2**
   - full intent-hint phrase match (case-insensitive): **+5** per matching hint
3. filter to matches with score > 0, take top `topN` (default 3)
4. pick top match (highest score)
5. derive:
   - `jobTypeId` from top match
   - `priority` from top match row (`row.priority`)
   - `businessId` from top match row (`row.businessUnitId`, which is the first entry from `businessUnitIds` array in raw ServiceTitan data)
   - skills list: aligned to top `topN` matches using round-robin algorithm:
     - first pass: take one skill (first skill) per match in rank order
     - fill pass: take additional skills from the same rows, cycling through matches, rank order then position within row, until `topN` unique skills are collected
   - resolved duration: `request.duration ?? top.row.durationMinutes ?? 60`

If no meaningful match (all scores = 0):

- returns `400` with `"No job type match for the given reason"`.

If matched type yields no skills:

- returns `400` with `"No skills available for the matched job type"`.

## Step C - Match skilled technicians

Logic:

1. fetch active technician rows from DB (`servicetitan_technicians` where `is_active=true` and `tenant_id` matches)
2. compare requested skill strings against each technician's skill names using **bidirectional** case-insensitive substring matching:
   - for each required skill `req` and each technician skill `name`: `name.includes(req) || req.includes(name)`
   - this means "HVAC" matches "HVAC Repair" and vice versa
3. retain technicians satisfying **all** required skills (`.every()`)
4. if zero technicians match AND `SERVICETITAN_FALLBACK_TECHNICIAN_ID` env is set:
   - inject a single fallback technician with `usedFallback: true` and empty `matchedSkills`
   - log a warning when fallback is used

Output per technician:

- `technicianId` (string)
- `name` (string, falls back to `"Technician {id}"`)
- `matchedSkills` (string array of the actual skill names that matched)
- `usedFallback` (boolean, only present and `true` for injected fallback)

## Step D - Build technician schedules from ServiceTitan APIs

Core method:

- `ServiceTitanClient.getDailyTechnicianSchedule(...)`

Important current behavior:

- **Internal re-fetch**: `getDailyTechnicianSchedule` calls `getTechnicians()` internally (full list from API), then filters to requested IDs. This means an extra API call per schedule fetch to get technician metadata (shifts, skills, bio, etc.) even though technician IDs are already known from Step C.
- **Technician-scoped fetch**:
  - only requested/matched technician IDs are selected from the full list
  - selected technician IDs are logged before schedule fetch for debugging
- For each selected technician, in **parallel** (`Promise.all`):
  - fetch job appointments via JPM appointments endpoint with `technicianId`
    - uses `startsOnOrAfter` and `startsBefore` (exclusive upper bound)
    - response fields captured: `id`, `start`, `end`, `arrivalWindowStart`, `arrivalWindowEnd`, `duration` (seconds), `status`
  - fetch non-job appointments via dispatch non-job endpoint with `technicianId`
    - uses `startsOnOrAfter` and `startsOnOrBefore` (inclusive upper bound, different param name than jobs)
- Job appointment query window comes from `getUtcDayWindow(date, 'UTC')` which produces **UTC midnight-to-midnight** bounds (not tenant-local midnight)
- Non-job requests use UTC day bounds derived from the same window:
  - `startsOnOrAfter: YYYY-MM-DDT00:00:00Z`
  - `startsOnOrBefore: YYYY-MM-DDT23:59:59Z`
- Non-job endpoint paginates (safety stop at page 100); job types paginate with safety stop at page 100
- Results are sorted alphabetically by technician name

### Job appointment busy window computation (critical)

For each job appointment, the busy window is computed dynamically rather than blindly using the raw `start`/`end`:

1. **Busy start** = `arrivalWindowStart` (preferred) → fallback to `start`
2. **Busy end** (tried in priority order):
   - if `arrivalWindowStart` and `duration` (seconds, > 0) are both present: `arrivalWindowStart + duration`
   - else if `arrivalWindowEnd` is present: use `arrivalWindowEnd`
   - else: fallback to `end`
3. **Status-based filtering**: appointments with status `"Done"`, `"Completed"`, `"Canceled"`, or `"Cancelled"` are marked `blocksBooking: false`, meaning they still appear in the schedule but do **not** block availability slots. This handles early finishes, cancellations, and completed jobs that the technician is already done with.

### Non-job event normalization (critical)

Because non-job payloads can vary:

- start can come from (tried in order): `start` | `startsOn` | `startTime` | `from`
- end can come from (tried in order): `end` | `endsOn` | `endTime` | `to`
- if no valid end (or end <= start):
  - try duration fields (tried in order): `durationMinutes` | `durationInMinutes` | `durationMins` | `duration`
  - each field is tried first as a numeric minute count, then as an `HH:MM:SS` or `HH:MM` time string (e.g. `'02:00:00'` → 120 minutes)
  - if duration > 0, compute end = start + duration minutes
  - else fallback to queried UTC day end (`startsOnOrBefore` value)
- if no valid start at all, the event is **skipped entirely** (returns null)

This prevents missing-end events from being dropped while still discarding events with no parseable start.

## Step E - Convert schedules to availability

Busy event model:

- `job_appointment` and `non_job_appointment` both normalized into `busyEvents` array, sorted by start time
- each event has buffer policy:
  - jobs: `pre=30 min`, `post=30 min`
  - non-jobs: `pre=0`, `post=0`
- `blocksBooking` flag per event:
  - job appointments with a non-blocking status (`Done`, `Completed`, `Canceled`, `Cancelled`) have `blocksBooking: false` — they are excluded from the busy-to-free computation
  - all other job appointments and all non-job appointments have `blocksBooking: true`
- legacy fallback: if `busyEvents` array is empty, `availability.ts` reconstructs busy events from the `appointments` array (with job buffers), ensuring backward compatibility with older cached schedule data

Slot engine (`availability.ts`):

1. derive shift block per technician:
   - if technician has valid `shiftStart` and `shiftEnd` (converted from local wall-clock to UTC) **and** end > start: use as shift block
   - overnight shifts where end <= start are **excluded** (fall back to route day window)
   - otherwise: use the route-level UTC day window as fallback
2. apply pre/post buffer minutes to each busy event
3. merge overlapping/adjacent busy windows (sorted, then greedy merge)
4. compute free gaps by walking from shift start through merged busy intervals
5. filter free gaps by minimum duration (requestedDurationMinutes)

Output modes (`agent-check.ts`):

- `specific_window` - date + startTime provided: checks if the exact requested window fits; provides earliest alternative per technician if not
- `day_slots` - date only, no startTime: finds all bookable windows of the requested duration; windows are consecutive non-overlapping blocks stepped by `durationMinutes` within each free gap
- `earliest_in_range` - no date: auto-resolves search date (today if within aggregate shift hours of requested technicians, otherwise tomorrow), then runs `day_slots` logic on that date

All response times are localized to tenant timezone for client display via `Intl.DateTimeFormat`.

## Step F - Return booking context with availability

`check-availability-by-reason` response wraps the scheduling result with booking context. The exact shape varies per mode:

**All modes include:**
- `mode` (string: `specific_window` | `day_slots` | `earliest_in_range`)
- `timeZone` (tenant timezone)
- `durationMinutes` (resolved duration used)
- `jobTypeId` (from top match)
- `priority` (from top match, nullable)
- `businessId` (from top match, nullable)
- `technicians` (array with per-technician results)

**`specific_window` mode adds:**
- `date`
- `requestedWindow` (`{ start, end }` in local time)
- per technician: `fitsRequest`, `doesNotFitReason`, `earliestAlternative`
- `globalEarliestAlternative` (`{ technicianId, start, end }` or null)

**`day_slots` mode adds:**
- `date`
- `requestedWindow` (always null)
- per technician: `hasAvailability`, `earliestSlot`, `slotsPreview` (array of `{ start, end }`)
- `globalEarliestSlot` (`{ technicianId, start, end }` or null)

**`earliest_in_range` mode adds:**
- `searchDate` (auto-resolved date)
- `searchAnchorStrategy` (`today_within_shift_hours` | `next_day_outside_shift_hours` | `today_no_shift_aggregate_for_requested_technicians`)
- `requestedWindow` (always null)
- per technician: `hasAvailability`, `earliestSlot` (includes `date` field), `slotsPreview`
- `globalEarliestSlot` (`{ technicianId, date, start, end }` or null)

This allows direct transition to booking once user picks technician + slot.

## Step G - Resolve customer/location (if not already known)

Endpoint:

- `POST /api/servicetitan/agent/resolve-customer-location`

Logic (cascade resolution):

1. if both `customerId` and `locationId` are provided, accept directly (status: `ids_provided`)
2. otherwise, requires `customerName` + `phone` + `address` (with `street`, `city`, `state`, `zip`, `country`; `unit` optional)

**Customer resolution cascade:**

1. search local cache (`servicetitan_customers`) by **normalized phone** (digits-only, all non-digit characters stripped)
2. among cached matches, find one whose address matches using **case-insensitive, whitespace-normalized comparison** across all 6 address fields (`street`, `unit`, `city`, `state`, `zip`, `country`)
3. if not in cache: call ServiceTitan CRM API (`findCustomers`) with phone + address filters; upsert results into cache
4. among API results, prefer address match; fall back to first result
5. if still no customer: create via ServiceTitan API; the create call **embeds a location** in the payload (`locations: [{ name, address }]`), so a matching location may be created alongside the customer; upsert new customer into cache

**Location resolution cascade** (using resolved `customerId`):

1. search local cache (`servicetitan_locations`) by `customerId`, match by address (same 6-field comparison)
2. if not in cache: call ServiceTitan CRM API (`findLocations`) with `customerId` + address fields; upsert results into cache
3. among API results, prefer address match; fall back to first result
4. if still no location: create via ServiceTitan API with `customerId` + `name` + `address`; upsert into cache

**Response includes:**
- `customerId`, `locationId` (resolved numbers)
- `status`: one of `ids_provided` | `matched_existing` | `customer_matched_location_created` | `customer_created_location_matched` | `customer_and_location_created`
- `customerCreated`, `locationCreated` (booleans)

## Step H - Book appointment

Endpoint:

- `POST /api/servicetitan/agent/book`

Also uses `normalizedRequestPayload(req)` for Retell compatibility (same as Step A).

Required booking fields:

- `tenantId`
- `businessUnitId` (number - this is what `check-availability-by-reason` returns as `businessId`; caller maps the name)
- `jobTypeId` (number)
- `priority` (string)
- `date` (YYYY-MM-DD)
- `startTime` (HH:MM or HH:MM:SS)
- `endTime` or `duration` (at least one required; `duration` defaults to 60 if neither is set explicitly)
- `technicianId` (number - must be converted from string used in availability outputs)
- `summary` (optional string)
- and either:
  - `customerId + locationId` (both numbers), or
  - `customerName + phone + address` (to resolve/create via the same cascade as Step G, executed inline)

Booking flow internals:

1. resolve customer/location IDs (same `resolveCustomerAndLocationIds` logic as Step G, runs inline)
2. convert local wall-clock `startTime`/`endTime` to UTC using tenant timezone
3. validate end > start
4. build ServiceTitan JPM payload via `buildServiceTitanJobsPayload`:
   - all IDs are stringified for the API (`customerId`, `locationId`, `businessUnitId`, `jobTypeId`, `technicianIds`)
   - includes `campaignId` from `SERVICETITAN_CAMPAIGN_ID` env variable
   - sets `arrivalWindowStart` and `arrivalWindowEnd` to the appointment start/end UTC
   - sets `summary` to provided value or defaults to `"Scheduled appointment"` if empty/omitted
5. POST to ServiceTitan JPM `/jobs` endpoint
6. response includes:
   - `jobId`, `appointmentId` (from ServiceTitan response)
   - `customerId`, `locationId`, `status`, `customerCreated`, `locationCreated`
   - `technicianId`
   - `start`, `end` (localized to tenant timezone)
   - `startUtc`, `endUtc` (UTC)

---

## 5) Database involvement in this flow

Tables involved:

- `servicetitan_tenants` - tenant credentials (`client_id`, `client_secret`, `app_key`) and `timezone` (IANA string)
- `servicetitan_technicians` - skill matching source; stores `skills` (JSON array of `{ id, name }`), `shift_start`, `shift_end`, `bio`, `positions`, `permissions`
- `servicetitan_job_types` - issue-to-job-type knowledge base; stores `name`, `code`, `summary`, `duration_seconds`, `skills`, `priority`, `business_unit_id`, `intent_hints`
- `servicetitan_customers` - customer resolution cache; stores `normalized_phone` (digits-only) for lookup, plus full address fields
- `servicetitan_locations` - location resolution cache; stores `customer_id` (FK validated on upsert) and address fields
- `servicetitan_appointments`, `servicetitan_appointment_assignments` - sync snapshot/cached helper paths (legacy)

Important upsert behaviors:

- **`intent_hints` preservation**: during job type sync, existing `intent_hints` values in DB are preserved and not overwritten. The sync reads current hints before upserting, merging them back in. This allows manually curated hints to survive re-syncs.
- **Location FK validation**: when upserting locations, `customer_id` references are validated against existing `servicetitan_customers` rows. If a customer doesn't exist in the cache, `customer_id` is set to null to avoid FK violations.
- **Phone normalization**: customer phone is stored both raw and as `normalized_phone` (digits-only) for consistent lookup regardless of formatting.

Flow usage:

- issue resolution + technician matching mostly read from cached DB tables
- live schedule availability uses upstream API fetches per technician (not cached data)
- booking writes upstream to ServiceTitan; customer/location cache may be upserted when created/resolved

---

## 6) Timezone/UTC contract (authoritative)

- Upstream ServiceTitan schedule calls: UTC parameters
- Internal schedule arithmetic: UTC timestamps
- API response schedule windows: tenant-local display strings
- Booking request local times: converted to UTC for ServiceTitan payload

This separation avoids mixed-timezone drift and keeps end-user output readable.

---

## 7) Important minor details (easy to miss)

- `technicianId` is string in matching/availability outputs; convert to number for booking.
- `check-availability-by-reason` and `book` both use `normalizedRequestPayload(req)` to support Retell-style payloads where arguments are nested under `body.arguments`.
- `check-availability-by-reason` accepts either `startTime` or `time` (not both); providing both returns a Zod validation error.
- `slotPreviewLimit=0` means uncapped up to hard safety cap of **2000** per technician (`MAX_SLOTS_PREVIEW_PER_TECH`).
- Slot expansion produces consecutive non-overlapping windows of `durationMinutes` within each free gap, stepped by the duration itself (back-to-back, no overlap).
- Fallback technician is optional and controlled by `SERVICETITAN_FALLBACK_TECHNICIAN_ID` env; it is **only injected when zero technicians match**, not added alongside matches.
- Non-job events can block even when `end` is absent due to normalization fallback to UTC day-end.
- Non-job events with no parseable `start` at all are silently dropped.
- Selected technician IDs are logged before schedule fetch for debugging.
- `getDailyTechnicianSchedule` internally calls `getTechnicians()` (API fetch), meaning an extra upstream call per schedule request.
- `getUtcDayWindow` is called with timezone `'UTC'` (not tenant timezone), producing strict UTC midnight boundaries.
- Time normalization: `HH:MM` inputs are padded to `HH:MM:00` before conversion.
- Booking payload stringifies all numeric IDs (`customerId`, `locationId`, `businessUnitId`, `jobTypeId`, `technicianIds`) for the ServiceTitan API.
- `campaignId` is a required env variable (`SERVICETITAN_CAMPAIGN_ID`) included in every booking payload.
- Booking default summary is `"Scheduled appointment"` when `summary` is omitted or empty.
- Job type normalization handles both camelCase and PascalCase field names from ServiceTitan, plus multiple duration field names (`duration`, `durationSeconds`, `estimatedDurationInSeconds`, `durationMinutes`, `soldHours`).
- Job type skill arrays can be `string[]` or `{ id, name }[]`; both shapes are normalized.
- Pagination safety stops: non-job appointments at page 100, job types at page 100, customers at page 200, locations at page 200.
- The `sync` endpoint accepts optional `includeCrm` query param (default `true`); set to `false` to skip customer/location sync.
- Auth token is cached in memory with a 60-second safety margin before expiry (`expires_in - 60`).

---

## 8) Failure points and expected behavior

- No job-type match (all scores = 0) -> `400` with `"No job type match for the given reason"`.
- No skills from matched type -> `400` with `"No skills available for the matched job type"`.
- No technician matches and no fallback -> `400` with `"No technicians matched the required skills; set SERVICETITAN_FALLBACK_TECHNICIAN_ID for a last-resort tech"`.
- Invalid or non-finite resolved duration -> `400` with `"Invalid duration for availability check"`.
- Invalid time/date combinations -> Zod schema validation errors (`400`) or runtime checks (e.g. `"End must be after start"`, `"date is required when startTime or time is set"`).
- Both `startTime` and `time` provided simultaneously -> `400` Zod error `"Provide only one of startTime or time"`.
- Missing customer/location context at booking -> `400` with `"Provide customerId + locationId, or provide customerName + phone + address to resolve/create them"`.
- Tenant not configured -> throws `"ServiceTitan tenant not configured for tenantId=..."`.
- ServiceTitan auth failure -> throws `"ServiceTitan auth failed: {status} {body}"`.
- ServiceTitan API call failure -> throws `"ServiceTitan API failed: {status} {body}"`.
- ZodError exceptions are logged as flattened JSON to avoid `util.inspect` crash in some environments (Vercel).

---

## 9) Minimal operational sequence (for integrators)

1. Connect tenant (`/connect`)
2. Sync metadata (`/sync`)
3. Check by reason (`/agent/check-availability-by-reason`)
4. Resolve customer/location if needed (`/agent/resolve-customer-location`)
5. Book (`/agent/book`)

This is the shortest reliable implementation path.

### Additional standalone endpoints (outside main flow)

These endpoints exist and can be called independently but are not required for the canonical flow:

- `GET /api/servicetitan/job-types/knowledge-base` - returns the cached job-type knowledge base for a tenant
- `POST /api/servicetitan/agent/match-technicians` - matches technicians by skill list without resolving a job type
- `POST /api/servicetitan/agent/resolve-job-type` - resolves job type from reason text without checking availability
- `POST /api/servicetitan/agent/check-availability` - checks availability for given technician IDs without resolving from a reason (requires `technicianIds` directly)
- `GET /health` - returns `{ ok: true, service: "crm-appointment-scheduler" }`

---

## 10) ServiceTitan APIs called in this flow

This section lists the upstream ServiceTitan endpoints used by the runtime logic, grouped by stage.

## A) Authentication

1. OAuth token

- Method: `POST`
- Endpoint:
  - Integration: `https://auth-integration.servicetitan.io/connect/token`
  - Production: `https://auth.servicetitan.io/connect/token`
- Content-Type: `application/x-www-form-urlencoded` (not JSON)
- Body: `grant_type=client_credentials&client_id=...&client_secret=...`
- Purpose:
  - get bearer token via client credentials grant
- Notes:
  - token cached in memory until `expires_in - 60` seconds (60-second safety margin)
  - environment (`integration` | `production`) controlled by `SERVICETITAN_ENV` env variable (default: `integration`)
  - API base URL also switches: `api-integration.servicetitan.io` vs `api.servicetitan.io`

## B) Technician and scheduling data (availability flow)

2. Technicians list

- Method: `GET`
- Endpoint:
  - `/settings/v2/tenant/{tenantId}/technicians`
- Key query params:
  - `active=true`
  - `includeTotal=true`
  - `pageSize`
- Purpose:
  - load technician metadata (id, shift, skills, name, etc.)

3. Job appointments per selected technician

- Method: `GET`
- Endpoint:
  - `/jpm/v2/tenant/{tenantId}/appointments`
- Key query params:
  - `active=true`
  - `startsOnOrAfter=<UTC start>` (inclusive)
  - `startsBefore=<UTC end>` (exclusive - note: different param name than non-job endpoint)
  - `technicianId=<single technician id>`
  - `pageSize` (default 500)
- Purpose:
  - fetch assigned job appointments for each selected technician in schedule window
- Note:
  - single page fetch (no pagination loop)

4. Non-job appointments per selected technician

- Method: `GET`
- Endpoint:
  - `/dispatch/v2/tenant/{tenantId}/non-job-appointments`
- Key query params:
  - `includeTotal=true`
  - `activeOnly=true`
  - `technicianId=<single technician id>`
  - `startsOnOrAfter=<UTC day start>` (inclusive)
  - `startsOnOrBefore=<UTC day end>` (inclusive - note: different param name than job endpoint's `startsBefore`)
  - `page`, `pageSize` (default 500)
- Purpose:
  - fetch non-job blockers (meetings, time off, etc.) per selected technician
- Note:
  - paginates until `hasMore=false`; safety stop at page 100

5. (Legacy/helper path) appointment assignments

- Method: `GET`
- Endpoint:
  - `/dispatch/v2/tenant/{tenantId}/appointment-assignments`
- Key query params:
  - `includeTotal=true`
  - `active=true`
  - `appointmentIds=<comma-separated ids>`
- Purpose:
  - old mapping strategy (appointments -> technician assignments)
- Current note:
  - live availability flow now uses per-technician appointment filtering instead.

## C) Job-type and booking context

6. Job types (sync/load source)

- Method: `GET`
- Endpoint:
  - `/jpm/v2/tenant/{tenantId}/job-types`
- Key query params:
  - `page`
  - `pageSize`
  - `includeTotal=true`
  - `active=true`
- Purpose:
  - build local knowledge base for issue-to-job-type matching

## D) CRM resolution for customer/location

7. Customers search/list

- Method: `GET`
- Endpoint:
  - `/crm/v2/tenant/{tenantId}/customers`
- Common query params used:
  - `includeTotal=true`
  - `page`, `pageSize`
  - optional filters like `phone`, `name`, address components
- Purpose:
  - find matching customer before create

8. Customer create

- Method: `POST`
- Endpoint:
  - `/crm/v2/tenant/{tenantId}/customers`
- Purpose:
  - create customer when not found

9. Locations search/list

- Method: `GET`
- Endpoint:
  - `/crm/v2/tenant/{tenantId}/locations`
- Common query params used:
  - `includeTotal=true`
  - `page`, `pageSize`
  - optional `customerId` and address fields
- Purpose:
  - find matching location before create

10. Location create

- Method: `POST`
- Endpoint:
  - `/crm/v2/tenant/{tenantId}/locations`
- Purpose:
  - create location when not found

## E) Final booking

11. Job booking

- Method: `POST`
- Endpoint:
  - `/jpm/v2/tenant/{tenantId}/jobs`
- Purpose:
  - create job + appointment window for selected technician
- Payload source:
  - built by `buildServiceTitanJobsPayload(...)`
  - all numeric IDs are stringified for the API
  - includes converted UTC appointment window (`start`, `end`)
  - includes `arrivalWindowStart` and `arrivalWindowEnd` (set to same as appointment start/end)
  - includes `campaignId` from `SERVICETITAN_CAMPAIGN_ID` env
  - includes `summary` (user-provided or defaults to `"Scheduled appointment"`)
  - `technicianIds` is an array (single element for this flow)

## F) Headers used on ServiceTitan calls

Every ServiceTitan **API** call (not auth) includes:

- `Authorization: Bearer <token>`
- `ST-App-Key: <tenant app key>`
- `Content-Type: application/json`

The auth token request uses `Content-Type: application/x-www-form-urlencoded` instead.

## G) Time parameter conventions used in calls

- schedule fetches use UTC boundaries in query params
- booking payload windows sent as UTC timestamps
- display conversion to tenant timezone happens only in this service's API responses

---

## 11) "No date" search anchor resolution (earliest_in_range mode)

When no `date` is provided, the system must decide which single day to search:

1. fetch full technician list via `getTechnicians()` API
2. filter to requested technician IDs
3. compute aggregate shift window: earliest `shiftStart` and latest `shiftEnd` among those technicians (ignoring overnight shifts where end <= start)
4. compare current local time (in tenant timezone) against the aggregate window:
   - **within shift hours**: search today (`today_within_shift_hours`)
   - **outside shift hours**: search tomorrow (`next_day_outside_shift_hours`)
   - **no valid shift data**: search today as fallback (`today_no_shift_aggregate_for_requested_technicians`)
5. the chosen date and strategy are included in the response

This ensures that queries made after business hours automatically look at the next working day.

---

## 12) Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PORT` | No | `8080` | HTTP server port |
| `NODE_ENV` | No | `development` | Environment name |
| `SERVICETITAN_ENV` | No | `integration` | ServiceTitan environment (`integration` or `production`) |
| `SERVICETITAN_CAMPAIGN_ID` | **Yes** | - | Campaign ID included in every booking payload |
| `SERVICETITAN_FALLBACK_TECHNICIAN_ID` | No | - | Fallback technician when no skill matches |
| `SUPABASE_URL` | **Yes** | - | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | **Yes** | - | Supabase service role key |

