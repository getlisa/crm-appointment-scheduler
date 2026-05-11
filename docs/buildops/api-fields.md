# BuildOps API Fields — Integration Reference

This document lists every BuildOps REST API field the integration reads or writes, organized by resource, with an explanation of why each field is used.

Base URL: `https://public-api.live.buildops.com`  
Auth: `Authorization: Bearer {access_token}` + `tenantId: {buildops_tenant_id}` header on every request.

---

## Authentication

### `POST /v1/auth/token`

**Request body:**

| Field | Why |
|---|---|
| `clientId` | OAuth client credential identifying the app-to-tenant integration. |
| `clientSecret` | Paired secret for `clientId`. Never logged or transmitted to Retell. |
| `tenantId` | Scopes the token to a single BuildOps tenant (one HVAC company). |

**Response:**

| Field | Why |
|---|---|
| `access_token` | Stored in `buildops_tenants.access_token` and sent as the `Bearer` header on every subsequent API call. Refreshed on a schedule before it expires. |

---

## Customers

### `GET /v1/customers?tenantId&limit&page&include_inactive=true`

Used by the full and incremental sync jobs to build the local `customers` table.

**Response item fields:**

| Field | Why |
|---|---|
| `id` | BuildOps customer UUID. Stored as `buildops_customer_id`. Referenced in every other API call that targets this customer (job creation, representative fetch, etc.). |
| `name` | Company / customer display name. Stored in `customers.name`. Primary text signal in fuzzy name matching during call identification. |
| `phonePrimary` | Main billing phone. Normalized to last-10 digits and added to `all_numbers` with source tag `customer:phonePrimary`. |
| `phoneAlternate` | Alternate contact phone. Same treatment as `phonePrimary`; source tag `customer:phoneAlternate`. |
| `addresses.items[]` | Array of address objects. Each item is stored in `customers.addresses` (JSONB) and in `addresses_all` (CSV). Used in fuzzy address matching when a caller provides an address instead of a phone number. |
| `addresses.items[].id` | BuildOps address UUID. Stored in `addresses_all` for traceability. |
| `addresses.items[].addressLine1` | Street address. Normalized and compared against the caller's stated address. |
| `addresses.items[].addressLine2` | Suite / unit. Included in address normalization. |
| `addresses.items[].city` | City. Part of the normalized address string used in similarity scoring. |
| `addresses.items[].state` | State abbreviation. Same as city. |
| `addresses.items[].zipcode` | ZIP code. Used as a standalone fuzzy query field when the caller provides only a zip. |
| `addresses.items[].addressType` | Classifies the address (billing, service, etc.). Stored in `addresses_all` for reference. |
| `priceBookId` | Default price book for this customer. Stored in `customers.price_book_id` and copied onto every job created for this customer so jobs use the correct pricing. |
| `status` | Account status string (e.g. `creditHold`, `inactive`, `suspended`, `collections`). **Read live** via `GET /v1/customers/{id}` immediately before job creation — if the status is in the blocked set, the agent is told to explain why no job can be created and is instructed to transfer the call. |
| `version` | Integer version counter for optimistic locking. Stored in `sync_state.json`. The incremental sync uses it to skip records that have not changed since the last run, avoiding unnecessary upserts. |
| `audit.lastUpdatedDateTime` | ISO timestamp of the last modification in BuildOps. Used as the filter boundary for incremental syncs: only customers updated after `lastSyncedMs` are re-fetched. |
| `isActive` | Stored in `customers.is_active`. Inactive customers are excluded from identification queries. |
| `accountNumber` | Stored in CSV for operator reference. Not used in call logic. |
| `isTaxable`, `taxRateValue` | Stored in CSV. Not currently used in call logic; may inform future tax handling. |
| `receiveSMS` | Stored in CSV. Not used in current call flow; available for future SMS confirmation feature. |

---

### `GET /v1/customers/{customerId}?addressType=...`

Called **mid-call** (in `handlePrepareJob`) to fetch the live account status before creating a job.

| Field | Why |
|---|---|
| `status` | The only field read from this response. Checked against the blocked-status set (`creditHold`, `inactive`, `suspended`, `collections`). If blocked, job creation is halted and a human-readable reason is returned to the agent. |

---

### `PUT /v1/customers/{customerId}`

Available for future use (e.g. adding a newly detected phone number back to the BuildOps customer record). Not currently called in the live call path.

---

## Representatives

### `GET /v1/customers/{customerId}/our-representatives?page&page_size=100`

Called during sync for every customer to collect all representative phone numbers.

| Field | Why |
|---|---|
| `items[].id` | Representative UUID. Stored in `representatives.id`. |
| `items[].firstName` | Used with `lastName` to generate a unique source tag for each phone number (e.g. `rep:cellPhone:JohnSmith1`). Ensures that if two reps share a name, their numbers remain distinguishable in `all_numbers_sources`. |
| `items[].lastName` | Same as `firstName`. |
| `items[].cellPhone` | Normalized and added to `customers.all_numbers` with source `rep:cellPhone:{name}`. A caller may be a representative calling from their own mobile — this is the primary way that number gets into the lookup index. |
| `items[].landlinePhone` | Same treatment as `cellPhone` with source tag `rep:landlinePhone:{name}`. |
| `totalCount` | Used only to inform pagination termination. Not stored. |

---

### `POST /v1/customers/{customerId}/representatives`

Called (via `createCustomerRepresentative`) when a new phone number is detected on an identified customer — i.e. the caller's number is not in `all_numbers` but the customer was matched via fuzzy name/address. Creates a new representative in BuildOps so the number is associated with the account.

| Field | Why (sent) |
|---|---|
| `firstName` | Required by BuildOps. Set to a placeholder or the caller's stated name. |
| `lastName` | Required. Same as `firstName`. |
| `cellPhone` | The newly detected caller number. Creating this representative causes it to appear in the next sync's representative fetch, after which it is added to `all_numbers`. |
| `landlinePhone` | Included if the detected number is identified as a landline. |

---

## Properties

### `GET /v1/properties?tenantId&include_addresses=false&page&page_size=100`

Called by the property sync job. Builds the local `property` table and the `properties.csv` snapshot.

| Field | Why |
|---|---|
| `items[].id` | BuildOps property UUID. Stored as `property.id`. Used in `customerPropertyId` when creating a job. |
| `items[].customerId` | Links the property to a BuildOps customer. Used to build the `properties_all` array on the customer row (which property IDs belong to this customer). |
| `items[].phonePrimary` | Property-level contact phone. Normalized and added to the parent customer's `all_numbers` with source `property:phonePrimary:{propertyId}`. A caller at a service location may call from the location's main line rather than the account holder's number. |
| `items[].phoneAlternate` | Same treatment as `phonePrimary` with source `property:phoneAlternate:{propertyId}`. |
| `items[].version` | Change detection. Stored in `sync_state.propertyVersions`. Properties whose version has not changed since the last sync are skipped. |
| `items[].priceBookId` | Property-specific price book override (if different from the customer-level price book). Stored in CSV. Future enhancement: use this instead of `customer.priceBookId` when the property has its own price book. |
| `items[].status` | Active/inactive flag for the service location. Stored in CSV. |
| `items[].sameAddress`, `items[].isTaxable`, etc. | Stored in CSV for operator reference. Not currently consumed by the call path. |

---

### `GET /v1/properties/{propertyId}?tenantId`

Called during call handling to verify that a given property ID belongs to the confirmed customer before a job is created.

| Field | Why |
|---|---|
| `id` | Confirms the property exists in BuildOps for this tenant. |
| `customerId` | Cross-checked against `session.matchedCustomerId` to prevent a caller from requesting job creation at a property they do not own. |
| `address` | Shown to the agent in the `prepare_job` success response as `property_address` so it can read the service address back to the caller for confirmation. |

---

### `POST /v1/properties`

Creates a new service location in BuildOps. Available for future use when a caller reports a new address not already on file.

| Field | Why (sent) |
|---|---|
| `customerId` | Associates the new property with the customer. |
| `latitude` | BuildOps requires coordinates on creation. |
| `longitude` | Same as latitude. |

---

## Jobs

### `POST /v1/jobs`

The central action of the integration — called after `call_ended` to create the job that was requested during the call.

**Request body:**

| Field | Why |
|---|---|
| `customerPropertyId` | BuildOps property UUID for the service location. Selected by the agent during the call. |
| `jobTypeId` | BuildOps job type UUID (e.g. "Time & Material"). Resolved from the `BUILDOPS_DEFAULT_JOB_TYPE_ID` environment variable. Determines billing and dispatch workflow. |
| `priceBookId` | Price book UUID from the customer record. Controls which products and prices appear on the job. |
| `customerId` | BuildOps customer UUID. Associates the job with the correct account. |
| `isUseTaxable` | Boolean tax flag. Currently always `false`; reserved for future tax logic. |
| `status` | Initial job status. Defaults to `Open`. The agent may set `In Progress` or `On Hold` based on the call context. |

**Response fields:**

| Field | Why |
|---|---|
| `id` | BuildOps job UUID. Stored in `jobs.job_id` and in `inbound_calls.buildops_job_id`. Used for subsequent task creation calls. |
| `jobNumber` | Human-readable identifier (e.g. `JOB-00123`). Stored in `jobs.job_number`. Included in confirmation messages and internal logs. |
| `status` | Echoed back; stored in `jobs.status`. |
| `version` | Initial version. Stored for future `PUT /v1/jobs/{id}` optimistic-lock updates. |
| `customerId`, `customerPropertyId`, `jobTypeId`, `priceBookId` | Echoed back; stored in `jobs` table for audit. |
| `isUseTaxable`, `tenantId` | Stored in `jobs` table. |
| `departments` | Array of `{id, name}`. Stored as JSONB in `jobs.departments`. |
| `audit.createdDate`, `audit.lastUpdatedDate` | Stored as JSONB in `jobs.audit`. |

---

### `GET /v1/jobs/{jobId}`

Fetches a job by ID. Available for status polling and reconciliation. Not currently in the live call path.

| Field | Why |
|---|---|
| All `BuildOpsJobResponse` fields | Same as the `POST /v1/jobs` response fields above. Used to refresh local `jobs` row. |

---

### `PUT /v1/jobs/{jobId}`

Updates a job. Requires `version` for optimistic locking. Available for future use (e.g. flagging a job for review after a Tier 2 fuzzy match, or updating status).

| Field | Why (sent) |
|---|---|
| `version` | Required by BuildOps to prevent lost-update conflicts. |
| Any `CreateJobInput` fields | The fields to change. |

---

### `POST /v1/jobs/{jobId}/tasks`

Creates a task (line item group) on an existing job. Called once per task in `PendingJobData.tasks` after the job is created.

**Request body:**

| Field | Why |
|---|---|
| `name` | Task display name (e.g. "AC Tune-Up"). Shown on the work order. |
| `entries[].productId` | BuildOps product UUID from `pricebook_items`. Links the task line item to the correct product for billing. |
| `entries[].description` | Optional override description for the line item. |
| `entries[].quantity` | Number of units. Defaults to 1. |

---

### `POST /v1/jobs/{jobId}/tags`

Adds a tag to a job. Available for future use — intended for department assignment and flagging Tier 2 jobs for manual review.

---

## Job Types

### `GET /v1/job-types?tenantId`

Fetched during admin/config steps to resolve the job type UUID for `Time & Material`.

| Field | Why |
|---|---|
| `id` | Job type UUID. The matching entry's `id` is what gets stored in `BUILDOPS_DEFAULT_JOB_TYPE_ID` (env var) and is sent as `jobTypeId` in every `POST /v1/jobs` request. |
| `name` | Used to find the correct entry (matched against `"Time & Material"` or the configured name). |
| `isActive` | Only active job types are candidates. |

---

## Pagination Pattern

All list endpoints use the same pagination convention:

| Parameter | Meaning |
|---|---|
| `page` | Zero-based (properties, representatives) or one-based (customers) page index. |
| `page_size` / `limit` | Number of items per page. Representatives and properties use 100; customers use 200. |
| `hasMore` (response) | Boolean. When `false`, pagination stops. |
| `items[]` / `data[]` | The response shape varies by endpoint — some return `{data: [...], hasMore}`, some return `{items: [...], totalCount}`, some return a raw array. The client normalizes all three shapes. |
