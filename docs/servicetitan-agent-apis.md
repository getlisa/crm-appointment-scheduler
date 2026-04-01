# ServiceTitan agent APIs: resolve job type, match technicians, check availability

This document describes three HTTP endpoints used to classify a visit, find qualified technicians, and verify or discover time slots before booking. All routes are mounted under **`/api/servicetitan`**.

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
    "duration": 60
  }
}
```

- **`skills`:** Up to **`topN`** entries (default **3**), aligned with the ranked job-type matches. First pass: one skill per match in score order (first skill on each row). If fewer than **`topN`** skills were collected (e.g. only one job type matched), remaining slots are filled with the next distinct skills from those same ranked rows, in rank order. Uses **`skillNames`** when present, else raw **`skills`**. Empty array if nothing matched.
- **`duration`:** Appointment length in **minutes** for the **top-scoring** job type only (`durationMinutes` from the knowledge base), or **`null`** if unknown or no match.

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

## 3. Check availability

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

## How these APIs connect for booking

The endpoint that creates the appointment is:

**`POST /api/servicetitan/agent/book`**

Typical flow:

1. **`resolve-job-type`** — Input: customer **`reason`**. Output: **`skills`** (up to 3) and **`duration`** (minutes) for the top match. Pass **`skills`** to match-technicians; use **`duration`** for check-availability **`durationMinutes`**. Optional **`jobTypeId`** on book can be set from your CRM if needed (this endpoint no longer returns **`jobTypeId`**).
2. **`match-technicians`** — Input: **`skills`** from step 1 (or a manual list). Output: **`technicianId`** strings for check-availability.
3. **`check-availability`** — Input: **`technicianIds`**, **`durationMinutes`**, and either a full **`date`** (with optional **`startTime`**) or no **`date`** for next-earliest behavior. Output: who fits, alternatives, or open slots. The user picks **`date`**, **`startTime`**, and a **technician**.
4. **`book`** — Requires **`tenantId`**, **`customerId`**, **`locationId`**, **`date`**, **`startTime`**, **`technicianId`** (number), and **`endTime` or `durationMinutes`**. Optional: **`jobTypeId`**, **`businessUnitId`**, **`campaignId`**, **`priority`**, **`summary`**.

**Prerequisites**

- Tenant must be connected and **`/api/servicetitan/sync`** (or equivalent) must have populated technicians and job types.
- Resolve-job-type depends on the job-types knowledge base populated during job-type sync.

**ID types**

- Match-technicians returns **`technicianId` as a string**. **`book`** expects **`technicianId` as a number** — convert when calling book.

---

## Quick reference: required vs optional

| API | Always required | Optional / conditional |
|-----|-----------------|-------------------------|
| **resolve-job-type** | `tenantId`, `reason` | `topN` (default 3) |
| **match-technicians** | `tenantId`, `skills` (≥1 string) | — |
| **check-availability** | `tenantId`, `technicianIds` (≥1) | `date`, `startTime`, `endTime`, `durationMinutes`, `slotPreviewLimit` — see validation rules above |
