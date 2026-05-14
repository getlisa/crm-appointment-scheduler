# Check availability by reason → Book

This document describes how **`POST /api/servicetitan/agent/check-availability-by-reason`** and **`POST /api/servicetitan/agent/book`** work together: request/response shapes and how fields map from the first call to the second.

**Base path:** all routes below are under **`/api/servicetitan`**.

**Prerequisites**

- Tenant connected (credentials stored).
- Sync has run so technicians and job types (knowledge base) exist.
- **`SERVICETITAN_CAMPAIGN_ID`** is set in the environment for **`book`** (not sent in the JSON body).

---

## How the two APIs connect

1. **Check** takes a natural-language **`reason`** (and optional calendar hints). The server picks a **job type**, derives **skills**, matches **technicians**, then runs the same scheduling logic as **`check-availability`**. The response **`data`** always includes **`jobTypeId`**, **`priority`**, and **`businessId`** (from the top job-type match) plus a **`mode`**-specific scheduling payload.

2. **Book** creates the ServiceTitan job. It does **not** accept **`reason`**. You supply **`jobTypeId`**, **`priority`**, **`businessUnitId`**, **`date`**, **`startTime`**, window end (**`endTime`** or **`duration`**), **`technicianId`**, and either **`customerId` + `locationId`** or **`customerName` + `phone` + `address`**.

### Field mapping (check → book)

| From `check-availability-by-reason` `data` | Use in `book` | Notes |
|---------------------------------------------|---------------|--------|
| `jobTypeId` | `jobTypeId` | Same value. |
| `priority` | `priority` | String; may be **`null`** from check — **`book`** requires a non-empty string (use a default like **`"Normal"`** if needed). |
| `businessId` | `businessUnitId` | Same numeric id; **different property name** on book. |
| `durationMinutes` | `duration` (optional if you send `endTime`) | Slot length in minutes. Book defaults **`duration`** to **60** if omitted; align with the slot you offer. |
| Chosen slot / window | `date`, `startTime`, `endTime` or `duration` | Interpret **`date`** and wall times in the tenant **timezone** (see `timeZone` on the check response). **`date`** is **`YYYY-MM-DD`**; times are **`HH:mm`** or **`HH:mm:ss`**. |
| Chosen technician | `technicianId` | Check returns **`technicianId` as a string**; **`book` requires a number** — coerce (e.g. `Number(technicianId)`). |
| — | `tenantId` | Same tenant on both requests. |
| — | `customerId`, `locationId` *or* `customerName`, `phone`, `address` | Not returned by check. Resolve via **`POST .../agent/resolve-customer-location`** or send customer context on **`book`** directly. |
| — | `summary` | Optional on book. |
| — | `campaignId` | Never in the body; from **`SERVICETITAN_CAMPAIGN_ID`**. |

### Typical flow

1. **`check-availability-by-reason`** with **`tenantId`** + **`reason`** (optional: **`date`**, **`startTime`** / **`time`**, **`endTime`**, **`duration`**, **`slotPreviewLimit`**, **`topN`**).
2. From **`data`**, read **`jobTypeId`**, **`priority`**, **`businessId`** → **`businessUnitId`**, and pick a technician + slot from **`technicians`** / **`globalEarliestSlot`** (or validate a specific window in **`specific_window`** mode).
3. **`book`** with the same **`tenantId`**, mapped ids, chosen **`date`** / **`startTime`** / **`endTime`** or **`duration`**, **`technicianId`** as number, plus customer/location ids or address fields.

---

## 1. `POST /api/servicetitan/agent/check-availability-by-reason`

**Content-Type:** `application/json`

### Request body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `tenantId` | number | **Yes** | Positive integer tenant id. |
| `reason` | string | **Yes** | Non-empty text used to score job types (same idea as resolve-job-type). |
| `topN` | number | No | Integer **1–10**, default **3**. Controls how many skills are aligned from ranked matches. |
| `date` | string | No | **`YYYY-MM-DD`**. Required if **`startTime`** or **`time`** is set. |
| `startTime` | string | No | **`HH:mm`** or **`HH:mm:ss`**. Do not send both **`startTime`** and **`time`**. |
| `time` | string | No | Alias for **`startTime`**. |
| `endTime` | string | No | **`HH:mm`** or **`HH:mm:ss`**. Used with **`date`** + wall start for **specific_window** mode. |
| `duration` | number | No | Positive integer minutes. Overrides duration from the matched job type; if still missing after match, internal default **60** is used for the availability run. |
| `slotPreviewLimit` | number | No | **0–2000**, default **0** (**0** = no cap, bounded by implementation). |

**Internal duration:** `resolvedDuration = request.duration ?? topMatch.durationMinutes ?? 60`.

**Errors (examples, HTTP 400)**

- `{ "success": false, "error": "No job type match for the given reason" }`
- `{ "success": false, "error": "No skills available for the matched job type" }`
- `{ "success": false, "error": "No technicians matched the required skills; set SERVICETITAN_FALLBACK_TECHNICIAN_ID for a last-resort tech" }`
- Validation / scheduling errors from the inner check (e.g. invalid time, end before start).

**Success**

```json
{
  "success": true,
  "data": { }
}
```

The shape of **`data`** depends on **`data.mode`**. Every success payload includes **`jobTypeId`**, **`priority`** (string or `null`), and **`businessId`** (number or `null`) at the top level of **`data`**, plus the fields below.

---

### Response `data` — `mode: "earliest_in_range"`

Returned when **`date`** is omitted (and no **`startTime`** / **`time`**). The server picks a single anchor day (`searchDate`) from aggregate technician shift logic.

| Field | Type | Description |
|-------|------|-------------|
| `mode` | `"earliest_in_range"` | |
| `timeZone` | string | Tenant timezone (e.g. `America/Los_Angeles`). |
| `durationMinutes` | number | Slot length used for the search. |
| `jobTypeId` | number | Top job-type match. |
| `priority` | string \| null | From job type row. |
| `businessId` | number \| null | First business unit id for booking → maps to **`businessUnitId`**. |
| `searchAnchorStrategy` | string | One of: **`today_within_shift_hours`**, **`next_day_outside_shift_hours`**, **`today_no_shift_aggregate_for_requested_technicians`**. |
| `searchDate` | string | `YYYY-MM-DD` anchor day evaluated. |
| `requestedWindow` | null | Always null in this mode. |
| `technicians` | array | See **Technician row (earliest_in_range)** below. |
| `globalEarliestSlot` | object \| null | Best slot across techs; see **Global slot** below. |

---

### Response `data` — `mode: "day_slots"`

Returned when **`date`** is set and **`startTime`** / **`time`** are omitted.

| Field | Type | Description |
|-------|------|-------------|
| `mode` | `"day_slots"` | |
| `date` | string | Requested `YYYY-MM-DD`. |
| `timeZone` | string | |
| `durationMinutes` | number | |
| `jobTypeId` | number | |
| `priority` | string \| null | |
| `businessId` | number \| null | |
| `requestedWindow` | null | |
| `technicians` | array | See **Technician row (day_slots)** below. |
| `globalEarliestSlot` | object \| null | |

---

### Response `data` — `mode: "specific_window"`

Returned when **`date`** and **`startTime`** (or **`time`**) are set. Validates whether the window fits; may suggest alternatives.

| Field | Type | Description |
|-------|------|-------------|
| `mode` | `"specific_window"` | |
| `date` | string | `YYYY-MM-DD`. |
| `timeZone` | string | |
| `durationMinutes` | number | Resolved length of the requested window. |
| `jobTypeId` | number | |
| `priority` | string \| null | |
| `businessId` | number \| null | |
| `requestedWindow` | object | `{ "start": "<local>", "end": "<local>" }` — tenant-local timestamps as `YYYY-MM-DDTHH:mm:ss`. |
| `technicians` | array | See **Technician row (specific_window)** below. |
| `globalEarliestAlternative` | object \| null | `{ "technicianId": "<string>", "start": "<local>", "end": "<local>" }` or `null`. |

---

### Technician objects

**`specific_window`** — each element:

| Field | Type | Description |
|-------|------|-------------|
| `technicianId` | string | Use for booking after converting to number. |
| `technicianName` | string | |
| `fitsRequest` | boolean | |
| `doesNotFitReason` | string | Present only when `fitsRequest` is false. |
| `earliestAlternative` | object \| null | `{ "start", "end" }` localized strings, or `null`. |

**`day_slots`** — each element:

| Field | Type | Description |
|-------|------|-------------|
| `technicianId` | string | |
| `technicianName` | string | |
| `hasAvailability` | boolean | |
| `earliestSlot` | object \| null | `{ "start", "end" }` in local time (no `date` property on this object), or `null`. |
| `slotsPreview` | array | `[{ "start", "end" }, ...]` localized. |

**`earliest_in_range`** — each element:

| Field | Type | Description |
|-------|------|-------------|
| `technicianId` | string | |
| `technicianName` | string | |
| `hasAvailability` | boolean | |
| `earliestSlot` | object \| null | `{ "date": "YYYY-MM-DD", "start", "end" }` (local), or `null`. |
| `slotsPreview` | array | `[{ "start", "end" }, ...]` localized. |

**`globalEarliestSlot`** (day_slots / earliest_in_range): `{ "technicianId", "start", "end" }`; **`earliest_in_range`** also includes **`date`** on this object when present.

---

### Example request (earliest-in-range style)

```json
{
  "tenantId": 123,
  "reason": "AC not cooling"
}
```

### Example success fragment (`earliest_in_range`)

```json
{
  "success": true,
  "data": {
    "mode": "earliest_in_range",
    "timeZone": "America/Los_Angeles",
    "durationMinutes": 120,
    "jobTypeId": 101164492,
    "priority": "Normal",
    "businessId": 69205683,
    "searchAnchorStrategy": "today_within_shift_hours",
    "searchDate": "2026-04-02",
    "requestedWindow": null,
    "technicians": [
      {
        "technicianId": "179246771",
        "technicianName": "Example Tech",
        "hasAvailability": true,
        "earliestSlot": {
          "date": "2026-04-02",
          "start": "2026-04-02T08:00:00",
          "end": "2026-04-02T10:00:00"
        },
        "slotsPreview": [
          { "start": "2026-04-02T08:00:00", "end": "2026-04-02T10:00:00" }
        ]
      }
    ],
    "globalEarliestSlot": {
      "technicianId": "179246771",
      "date": "2026-04-02",
      "start": "2026-04-02T08:00:00",
      "end": "2026-04-02T10:00:00"
    }
  }
}
```

---

## 2. `POST /api/servicetitan/agent/book`

**Content-Type:** `application/json`

Creates a job via ServiceTitan using **`buildServiceTitanJobsPayload`** (string ids where required, arrival window = start/end, **`campaignId`** from env).

### Request body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `tenantId` | number | **Yes** | |
| `businessUnitId` | number | **Yes** | Maps from check’s **`businessId`**. |
| `jobTypeId` | number | **Yes** | From check’s **`jobTypeId`**. |
| `priority` | string | **Yes** | Non-empty. If check returned **`null`**, supply a default. |
| `date` | string | **Yes** | `YYYY-MM-DD` in tenant timezone. |
| `startTime` | string | **Yes** | `HH:mm` or `HH:mm:ss`. |
| `endTime` | string | Conditional | `HH:mm` or `HH:mm:ss` on **`date`**. |
| `duration` | number | Conditional | Positive integer minutes; defaults to **60** if omitted in parsing. |
| `technicianId` | number | **Yes** | **Number**, not string. |
| `summary` | string | No | If omitted/blank, ST payload uses **`"Scheduled appointment"`**. |
| `customerId` | number | Conditional | With **`locationId`**. |
| `locationId` | number | Conditional | With **`customerId`**. |
| `customerName` | string | Conditional | With **`phone`** and **`address`** if not using ids. |
| `phone` | string | Conditional | |
| `address` | object | Conditional | **`street`**, **`city`**, **`state`**, **`zip`**, **`country`** required; **`unit`** optional. |

**Rules**

- Either **`customerId` + `locationId`** or **`customerName` + `phone` + `address`** (all three) must be present.
- **`endTime`** or **`duration`** must be provided such that the window end can be computed (schema refine: at least one of **`endTime`** or **`duration`**; **`duration`** defaults to **60**).

### Example book body (after check)

```json
{
  "tenantId": 123,
  "customerId": 999,
  "locationId": 888,
  "businessUnitId": 69205683,
  "jobTypeId": 101164492,
  "priority": "Normal",
  "date": "2026-04-02",
  "startTime": "08:00",
  "endTime": "10:00",
  "technicianId": 179246771,
  "summary": "HVAC service"
}
```

### Success response

```json
{
  "success": true,
  "data": {
    "jobId": 12345,
    "appointmentId": 67890,
    "customerId": 999,
    "locationId": 888,
    "status": "matched_existing",
    "customerCreated": false,
    "locationCreated": false,
    "technicianId": 179246771,
    "start": "2026-04-02T08:00:00",
    "end": "2026-04-02T10:00:00",
    "startUtc": "2026-04-02T15:00:00.000Z",
    "endUtc": "2026-04-02T17:00:00.000Z"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `jobId` | number \| null | ServiceTitan job id if returned. |
| `appointmentId` | number \| null | First appointment id if returned. |
| `customerId` | number | Resolved customer. |
| `locationId` | number | Resolved location. |
| `status` | string | Same semantics as **`resolve-customer-location`**: **`ids_provided`**, **`matched_existing`**, **`customer_matched_location_created`**, **`customer_created_location_matched`**, **`customer_and_location_created`**. |
| `customerCreated` | boolean | |
| `locationCreated` | boolean | |
| `technicianId` | number | From request. |
| `start`, `end` | string | Localized to tenant timezone when derived. |
| `startUtc`, `endUtc` | string | ISO UTC from API or computed. |

### Error response

```json
{
  "success": false,
  "error": "<message>"
}
```

Typically HTTP **400** for validation, resolution, or ServiceTitan errors (message in **`error`**).

---

## Related endpoints

- **`POST .../agent/resolve-customer-location`** — obtain **`customerId`** / **`locationId`** before **`book`** if the caller only has name, phone, and address.
- **`POST .../agent/check-availability`** — same scheduling modes as check-by-reason, but you pass **`technicianIds`** explicitly.

Implementation reference: `src/routes/servicetitan.ts` (schemas and handlers), `src/services/servicetitan/job-book-payload.ts` (ST job JSON).
