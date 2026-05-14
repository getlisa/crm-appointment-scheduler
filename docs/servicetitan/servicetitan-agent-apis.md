# ServiceTitan agent APIs: resolve job type, match technicians, check availability, resolve customer/location

This document describes HTTP endpoints used to classify a visit, resolve ServiceTitan customer/location ids, find qualified technicians, and verify or discover time slots before booking. All routes are mounted under **`/api/servicetitan`**.

## Conventions

- **Methods:** `POST` for all three endpoints.
- **Body:** JSON (`Content-Type: application/json`).
- **Success:** HTTP `200` with `{ "success": true, "data": ... }`.
- **Failure:** HTTP `400` with `{ "success": false, "error": "<message>" }`.

---

## 1. Resolve job type

**`POST /api/servicetitan/agent/resolve-job-type`**

Maps a free-text **reason** (what the customer said) to ServiceTitan job types using a tenant **knowledge base** built from synced job types (name, code, summary, intent hints, skills).

### Request body

| Field       | Type                        | Required | Description                                              |
|------------|-----------------------------|----------|----------------------------------------------------------|
| `tenantId` | number (integer, positive)  | **Yes**  | Tenant whose knowledge base to use.                      |
| `reason`   | string (non-empty)          | **Yes**  | Customer description / call reason.                      |
| `topN`     | number (integer, 1–10)      | No       | Max ranked matches to return (default **3**). Only non-zero scores are included. |

### Success response — `data`

```json
{
  "success": true,
  "data": {
    "skills": [
            "DIAG P KITCHEN MISC",
            "DIAG P LEAK KITCHEN",
            "UNCLOG P BLOCKED KITCHEN"
        ],
    "duration": 60,
    "priority": "Normal",
    "businessId": 69205044,
    "jobTypeId": 37637
  }
}
```

- **`skills`:** Up to **`topN`** entries (default **3**), aligned with the ranked job-type matches. First pass: one skill per match in score order (first skill on each row). If fewer than **`topN`** skills were collected (e.g. only one job type matched), remaining slots are filled with the next distinct skills from those same ranked rows, in rank order. Uses **`skillNames`** when present, else raw **`skills`**. Empty array if nothing matched.
- **`duration`:** Appointment length in **minutes** for the **top-scoring** job type only (`durationMinutes` from the knowledge base), or **`null`** if unknown or no match.
- **`priority`:** Job-type priority from ServiceTitan (e.g. `"Normal"`), from the **top-scoring** match, or **`null`** if missing or no match.
- **`businessId`:** First element of ServiceTitan `businessUnitIds` for the **top-scoring** job type (`businessId` = `businessUnitIds[0]`). Or **`null`** if none or no match. Re-sync job types after adding DB columns so cache includes these fields.
- **`jobTypeId`:** ServiceTitan job type id for the **top-scoring** match, or **`null`** if no match.

Scoring uses token overlap on name, code, summary, intent hints, and skills (`resolveJobTypeFromReason` / `scoreJobTypeMatch` in `src/services/servicetitan/job-types-kb.ts`). **`topN`** limits how many job types are ranked; **`skills`** returns up to that many skill strings when the data allows.

---

## 2. Match technicians

**`POST /api/servicetitan/agent/match-technicians`**

Returns **active** technicians for the tenant whose **skill names** satisfy **every** required string (case-insensitive substring match in either direction). Data is loaded from the database cache populated by **`GET /api/servicetitan/sync`** (`servicetitan_technicians`).

### Request body

| Field       | Type                                      | Required | Description                                                                 |
|------------|-------------------------------------------|----------|-----------------------------------------------------------------------------|
| `tenantId` | number (integer, positive)                | **Yes**  | Tenant.                                                                     |
| `skills`   | array of strings (each non-empty), min 1  | **Yes**  | Required skill labels. Often taken from **`data.skills`** on resolve-job-type. |

### Success response — `data`

Array of matches:

```json
{
  "success": true,
  "data": [
    {
      "technicianId": "123",
      "name": "Jane Doe",
      "matchedSkills": ["HVAC", "…"]
    }
  ]
}
```

- **`technicianId`:** String (consistent with availability APIs).
- **`matchedSkills`:** That technician’s skills that overlap the requested strings (useful for display or debugging).

An empty **`data`** array means no active technician has all required skills.

---

## 3. Resolve customer and location

**`POST /api/servicetitan/agent/resolve-customer-location`**

Resolves (and if needed creates) ServiceTitan **`customerId`** and **`locationId`** using the same logic as **`/agent/book`**, without booking a job. Use this from Retell (or any client) to obtain IDs, then call **`book`** with **`customerId`** + **`locationId`** only.

### Request body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `tenantId` | number (integer, positive) | **Yes** | Tenant. |
| `customerId` | number | Conditional | With **`locationId`**, skips lookup. |
| `locationId` | number | Conditional | With **`customerId`**, skips lookup. |
| `customerName` | string | Conditional | With **`phone`** + **`address`**, used to find/create customer. |
| `phone` | string | Conditional | Same as book. |
| `address` | object | Conditional | **`street`**, **`city`**, **`state`**, **`zip`**, **`country`**, optional **`unit`**. |

Either **`customerId` + `locationId`**, or **`customerName` + `phone` + `address`**, is required.

### Success response — `data`

```json
{
  "success": true,
  "data": {
    "customerId": 47116,
    "locationId": 71773,
    "status": "matched_existing",
    "customerCreated": false,
    "locationCreated": false
  }
}
```

### `status` values

| `status` | Meaning |
|----------|--------|
| **`ids_provided`** | Caller sent both **`customerId`** and **`locationId`**; no ServiceTitan create calls. |
| **`matched_existing`** | Existing customer and existing location matched (cache/API); neither created. |
| **`customer_matched_location_created`** | Existing customer; **`POST /locations`** created a new location. |
| **`customer_created_location_matched`** | **`POST /customers`** created the customer; location matched (e.g. embedded or found). |
| **`customer_and_location_created`** | Both customer and location were created via ServiceTitan. |

**`customerCreated`** / **`locationCreated`** mirror the internal flags for tooling and debugging.

---

## 4. Check availability

**`POST /api/servicetitan/agent/check-availability`**

Given **one or more technician IDs** and a **duration**, evaluates schedule windows using ServiceTitan’s daily technician schedule and internal availability logic. Uses the tenant **timezone** from stored credentials (default **`UTC`** if missing). Response times are **localized** to that timezone as `YYYY-MM-DDTHH:mm:ss` strings.

### Request body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `tenantId` | number (integer, positive) | **Yes** | Tenant. |
| `technicianIds` | array of non-empty strings, min length 1 | **Yes** | Usually IDs returned from match-technicians. |
| `durationMinutes` | number (integer, positive) | **Conditional** | **Required** when **`startTime`** is omitted. Length of the slot to find or to validate. |
| `date` | `YYYY-MM-DD` | **Conditional** | **Required** if **`startTime`** is set. Optional for “earliest in range” mode (see below). |
| `startTime` | `HH:mm` or `HH:mm:ss` | No | If set, runs **specific-window** validation for that day. |
| `endTime` | `HH:mm` or `HH:mm:ss` | No | If **`startTime`** is set: provide **`endTime`** **or** **`durationMinutes`** to define the window end. |
| `slotPreviewLimit` | number (0–2000) | No | Default **0**. Caps how many preview windows per technician in day modes; **0** means no cap (implementation allows up to 2000). |

**Validation rules:**

- If **`startTime`** is present → **`date`** is required, and you must provide **`endTime`** or **`durationMinutes`** (to derive the end).
- If **`startTime`** is omitted → **`durationMinutes`** is required.

### Response modes

The handler returns one of three shapes, distinguished by **`data.mode`**.

#### A) `specific_window` — `date` + `startTime`

Checks whether the requested window fits each technician’s free slots.

**Example `data`:**

```json
{
  "mode": "specific_window",
  "date": "2026-04-01",
  "timeZone": "America/Los_Angeles",
  "durationMinutes": 60,
  "requestedWindow": { "start": "…", "end": "…" },
  "technicians": [
    {
      "technicianId": "123",
      "technicianName": "…",
      "fitsRequest": true
    },
    {
      "technicianId": "456",
      "technicianName": "…",
      "fitsRequest": false,
      "doesNotFitReason": "requested_time_unavailable",
      "earliestAlternative": { "start": "…", "end": "…" }
    }
  ],
  "globalEarliestAlternative": {
    "technicianId": "456",
    "start": "…",
    "end": "…"
  }
}
```

- **`doesNotFitReason`** (when **`fitsRequest`** is false) may include: `technician_not_found`, `no_contiguous_window_for_duration`, `requested_time_unavailable`.
- **`globalEarliestAlternative`:** Earliest alternative window across technicians, or **`null`**.

#### B) `day_slots` — `date` without `startTime`

Returns the earliest slot and optional slot previews per technician for that calendar day. Includes **`requestedWindow: null`**, **`globalEarliestSlot`**, per-technician **`hasAvailability`**, **`earliestSlot`**, and **`slotsPreview`**.

#### C) `earliest_in_range` — no `date`**

Chooses an anchor calendar day (today vs tomorrow) from aggregate shift logic for the requested technicians (`searchAnchorStrategy`, `searchDate`), then returns slot information for that day in a shape similar to day mode.

---

## 5. Check availability by reason

**`POST /api/servicetitan/agent/check-availability-by-reason`**

Single call equivalent to **`resolve-job-type`** → **`match-technicians`** → **`check-availability`**: derives **`skills`** and **duration** from the top job-type match for **`reason`**, resolves **technician IDs** (including optional **`SERVICETITAN_FALLBACK_TECHNICIAN_ID`** when no skill match), then runs the same three response modes as [**check availability**](#4-check-availability) above.

### Request body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `tenantId` | number | **Yes** | Tenant. |
| `reason` | string | **Yes** | Same as **`resolve-job-type`** (customer utterance / problem description). |
| `topN` | number (1–10) | No | Default **3**; controls skill alignment breadth from ranked matches. |
| `date` | `YYYY-MM-DD` | No | Same semantics as **`check-availability`**. Required if **`startTime`** or **`time`** is set. |
| `startTime` | `HH:mm` / `HH:mm:ss` | No | Same as **`check-availability`**. Do not send both **`startTime`** and **`time`**. |
| `time` | `HH:mm` / `HH:mm:ss` | No | Alias for **`startTime`** (e.g. voice agents). |
| `endTime` | `HH:mm` / `HH:mm:ss` | No | Same as **`check-availability`** when validating a specific window. |
| `duration` | integer (minutes) | No | Overrides duration from the matched job type; if still missing, **60** is used for slot search. |
| `slotPreviewLimit` | 0–2000 | No | Default **0** (no cap). |

### Response `data`

Same scheduling **`mode`** and fields as **`check-availability`** for that mode, **only** those fields (no extra debug objects), plus at the top level of **`data`**:

- **`jobTypeId`** — from the top job-type match for **`reason`**
- **`priority`** — from that row (or **`null`**)
- **`businessId`** — first business unit id for booking (or **`null`**)

Example (`earliest_in_range`): **`mode`**, **`timeZone`**, **`durationMinutes`**, **`jobTypeId`**, **`priority`**, **`businessId`**, **`searchAnchorStrategy`**, **`searchDate`**, **`requestedWindow`**, **`technicians`**, **`globalEarliestSlot`**.

If no job type scores for **`reason`**, no skills are derived, or no technicians match and fallback is not configured, the handler returns **400** with an error message.

---

## How these APIs connect for booking

The endpoint that creates the appointment is:

**`POST /api/servicetitan/agent/book`**

The server builds the ServiceTitan JPM job body (string ids where applicable, **`arrivalWindowStart` / `arrivalWindowEnd`**, **`campaignId`** from environment **`SERVICETITAN_CAMPAIGN_ID`** — not from the request).

### Book — request body (normalized JSON)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `tenantId` | number | **Yes** | Tenant. |
| `customerId` | number | Conditional | With **`locationId`**, or omit and use **`customerName` + `phone` + `address`**. |
| `locationId` | number | Conditional | With **`customerId`**, or omit and use customer context. |
| `customerName`, `phone`, `address` | | Conditional | Same rules as **`resolve-customer-location`**. |
| `businessUnitId` | number | **Yes** | Maps to ST **`businessUnitId`** (often from **`resolve-job-type`** **`businessId`**). |
| `jobTypeId` | number | **Yes** | From **`resolve-job-type`**. |
| `priority` | string | **Yes** | e.g. **`"Normal"`** (from **`resolve-job-type`** when available). |
| `date` | `YYYY-MM-DD` | **Yes** | Local calendar date in tenant timezone. |
| `startTime` | `HH:mm` or `HH:mm:ss` | **Yes** | |
| `endTime` or `duration` | | **Yes** | Same validation as check-availability. |
| `technicianId` | number | **Yes** | |
| `summary` | string | No | Defaults server-side to **`"Scheduled appointment"`** in the ST payload if omitted. |

**Environment:** set **`SERVICETITAN_CAMPAIGN_ID`** (string) in `.env` for the integration campaign id.

### Book — success `data` (high level)

Includes **`jobId`**, **`appointmentId`**, **`customerId`**, **`locationId`**, **`status`** (same values as **`resolve-customer-location`**: whether ids were supplied vs customer/location created), **`customerCreated`**, **`locationCreated`**, **`technicianId`**, localized **`start`/`end`** and **`startUtc`/`endUtc`**.

Typical flow:

1. **`resolve-job-type`** — Input: customer **`reason`**. Output: **`skills`**, **`duration`**, **`jobTypeId`**, **`priority`**, **`businessId`** for the top match. Pass **`skills`** to match-technicians; use **`duration`** for check-availability; pass **`jobTypeId`** (and optional **`businessId`**) to **`book`**.
2. **`match-technicians`** — Input: **`skills`** from step 1 (or a manual list). Output: **`technicianId`** strings for check-availability.
3. **`check-availability`** — Input: **`technicianIds`**, **`durationMinutes`**, and either a full **`date`** (with optional **`startTime`**) or no **`date`** for next-earliest behavior. Output: who fits, alternatives, or open slots. The user picks **`date`**, **`startTime`**, and a **technician**. **Alternatively**, use **`check-availability-by-reason`** with **`reason`** (and the same optional **`date`** / **`startTime`** / **`time`**) to perform steps 1–3 in one HTTP call.
4. **`resolve-customer-location`** (optional) — If you want IDs before booking, call with **`customerName` + `phone` + `address`** (or known IDs). Use returned **`customerId`** and **`locationId`** in **`book`**.
5. **`book`** — Requires **`tenantId`**, **`businessUnitId`**, **`jobTypeId`**, **`priority`**, **`date`**, **`startTime`**, **`technicianId`** (number), **`endTime` or `duration`**, and either **`customerId` + `locationId`** or **`customerName` + `phone` + `address`**. Optional **`summary`**. **`campaignId`** is taken from **`SERVICETITAN_CAMPAIGN_ID`** in `.env`.

**Prerequisites**

- Tenant must be connected and **`/api/servicetitan/sync?tenantId=<id>&includeCrm=true`** (or equivalent) should be run to populate technicians, job types, customers, and locations caches.
- Resolve-job-type depends on the job-types knowledge base populated during job-type sync.

**ID types**

- Match-technicians returns **`technicianId` as a string**. **`book`** expects **`technicianId` as a number** — convert when calling book.

---

## Quick reference: required vs optional

| API | Always required | Optional / conditional |
|-----|-----------------|-------------------------|
| **resolve-job-type** | `tenantId`, `reason` | `topN` (default 3) |
| **match-technicians** | `tenantId`, `skills` (≥1 string) | — |
| **resolve-customer-location** | `tenantId` | **`customerId` + `locationId`** *or* **`customerName` + `phone` + `address`** |
| **check-availability** | `tenantId`, `technicianIds` (≥1) | `date`, `startTime`, `endTime`, `durationMinutes`, `slotPreviewLimit` — see validation rules above |
| **check-availability-by-reason** | `tenantId`, `reason` | `topN`, `date`, `startTime` or `time`, `endTime`, `duration`, `slotPreviewLimit` |
| **book** | `tenantId`, `businessUnitId`, `jobTypeId`, `priority`, `date`, `startTime`, `technicianId`, `endTime` or `duration` | **`customerId` + `locationId`** *or* **`customerName` + `phone` + `address`**; optional `summary`; **`SERVICETITAN_CAMPAIGN_ID`** in env |
