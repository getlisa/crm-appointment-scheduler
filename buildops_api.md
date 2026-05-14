# BuildOps API Document
---

**Base URL:** `https://public-api.live.buildops.com`

**Auth headers (all requests):**
| Header | Value |
|---|---|
| `Authorization` | `Bearer {access_token}` |
| `tenantId` | `{buildops_tenant_id}` |
| `Content-Type` | `application/json` |

---

## POST https://public-api.live.buildops.com/v1/auth/token

Exchange OAuth client credentials for a Bearer access token.

### Request Body

```json
{
  "grant_type": "client_credentials",
  "client_id": "string",
  "client_secret": "string"
}
```

### Response

```json
{
  "access_token": "string",
  "token_type": "Bearer",
  "expires_in": 3600
}
```

---

## GET https://public-api.live.buildops.com/v1/customers

List customers for a tenant, paginated.

### Request Parameters

| Parameter Name | In | Required | Type | Description |
|---|---|---|---|---|
| `tenantId` | query | Yes | string (UUID) | BuildOps tenant UUID |
| `page` | query | No | integer | Page number, starting from 1 |
| `limit` | query | No | integer | Items per page (default 200) |
| `isActive` | query | No | boolean | Filter by active status |

### Response

```json
{
  "data": [
    {
      "id": "uuid",
      "name": "string",
      "isActive": true,
      "phonePrimary": "+15551234567",
      "phoneSecondary": null,
      "addresses": [
        {
          "line1": "123 Main St",
          "line2": null,
          "city": "Houston",
          "state": "TX",
          "zip": "77001"
        }
      ],
      "priceBookId": "uuid",
      "version": 5,
      "audit": {
        "createdDate": "2024-01-15",
        "lastUpdatedDate": "2025-03-10",
        "lastUpdatedDateTime": 1741564800000
      }
    }
  ],
  "hasMore": true,
  "totalCount": 4200
}
```

---

## GET https://public-api.live.buildops.com/v1/customers/{customerId}

Fetch a single customer by UUID, including live account status used for blocked-account checks before job creation.

### Request Parameters

| Parameter Name | In | Required | Type | Description |
|---|---|---|---|---|
| `customerId` | path | Yes | string (UUID) | BuildOps customer UUID |
| `addressType` | query | No | string | Filter returned addresses (e.g. `billingAddress`) |

### Response

```json
{
  "id": "uuid",
  "name": "string",
  "isActive": true,
  "status": "active",
  "phonePrimary": "+15551234567",
  "phoneSecondary": null,
  "addresses": [
    {
      "line1": "123 Main St",
      "city": "Houston",
      "state": "TX",
      "zip": "77001"
    }
  ],
  "priceBookId": "uuid",
  "version": 5,
  "audit": {
    "lastUpdatedDate": "2025-03-10",
    "lastUpdatedDateTime": 1741564800000
  }
}
```

**Blocked status values** (job creation refused when `status` is any of these):

| Status | Meaning |
|---|---|
| `creditHold` | Account on credit hold |
| `inactive` | Account deactivated |
| `suspended` | Account suspended |
| `collections` | Account in collections |

---

## PUT https://public-api.live.buildops.com/v1/customers/{customerId}

Update a customer record.

### Request Parameters

| Parameter Name | In | Required | Type | Description |
|---|---|---|---|---|
| `customerId` | path | Yes | string (UUID) | BuildOps customer UUID |

### Request Body

```json
{
  "name": "string",
  "phonePrimary": "+15551234567",
  "phoneSecondary": null,
  "addresses": [
    {
      "line1": "123 Main St",
      "city": "Houston",
      "state": "TX",
      "zip": "77001"
    }
  ]
}
```

### Response

`204 No Content`

---

## GET https://public-api.live.buildops.com/v1/customers/{customerId}/our-representatives

List representatives (contacts) for a customer, paginated. Used during sync to aggregate `all_numbers`.

### Request Parameters

| Parameter Name | In | Required | Type | Description |
|---|---|---|---|---|
| `customerId` | path | Yes | string (UUID) | BuildOps customer UUID |
| `page` | query | No | integer | Page index, starting from 0 |
| `page_size` | query | No | integer | Items per page (default 100) |

### Response

```json
{
  "totalCount": 3,
  "items": [
    {
      "id": "uuid",
      "firstName": "Jane",
      "lastName": "Doe",
      "cellPhone": "+15551234567",
      "landlinePhone": null,
      "email": "jane@example.com",
      "isActive": true,
      "isDoNotCall": false,
      "isEmailOptOut": false,
      "isSmsOptOut": false,
      "version": 2,
      "audit": {
        "lastUpdatedDate": "2025-03-01",
        "lastUpdatedDateTime": 1740787200000
      }
    }
  ]
}
```

---

## POST https://public-api.live.buildops.com/v1/customers/{customerId}/representatives

Create a new representative (contact) on a customer account. Called mid-call when the agent fires `add_representative`.

### Request Parameters

| Parameter Name | In | Required | Type | Description |
|---|---|---|---|---|
| `customerId` | path | Yes | string (UUID) | BuildOps customer UUID |

### Request Body

```json
{
  "firstName": "string",
  "lastName": "string",
  "cellPhone": "+15551234567",
  "landlinePhone": null
}
```

### Response

```json
{
  "id": "uuid"
}
```

---

## GET https://public-api.live.buildops.com/v1/properties

List properties (service locations) for a tenant, paginated.

### Request Parameters

| Parameter Name | In | Required | Type | Description |
|---|---|---|---|---|
| `tenantId` | query | Yes | string (UUID) | BuildOps tenant UUID |
| `page` | query | No | integer | Page index |
| `page_size` | query | No | integer | Items per page (default 200) |
| `lastUpdatedDateStart` | query | No | string (ISO 8601) | Filter for incremental sync; returns properties updated after this timestamp |

### Response

```json
{
  "totalCount": 1200,
  "items": [
    {
      "id": "uuid",
      "name": "Main Office",
      "customerId": "uuid",
      "phonePrimary": "+15551234567",
      "address": {
        "line1": "456 Industrial Blvd",
        "city": "Houston",
        "state": "TX",
        "zip": "77002"
      },
      "audit": {
        "lastUpdatedDate": "2025-02-20",
        "lastUpdatedDateTime": 1740009600000
      }
    }
  ]
}
```

---

## GET https://public-api.live.buildops.com/v1/properties/{propertyId}

Fetch a single property by UUID.

### Request Parameters

| Parameter Name | In | Required | Type | Description |
|---|---|---|---|---|
| `propertyId` | path | Yes | string (UUID) | BuildOps property UUID |
| `tenantId` | query | Yes | string (UUID) | BuildOps tenant UUID |

### Response

```json
{
  "id": "uuid",
  "name": "Main Office",
  "customerId": "uuid",
  "phonePrimary": "+15551234567",
  "address": {
    "line1": "456 Industrial Blvd",
    "city": "Houston",
    "state": "TX",
    "zip": "77002"
  }
}
```

---

## POST https://public-api.live.buildops.com/v1/properties

Create a new service location property. BuildOps requires coordinates on creation.

### Request Body

```json
{
  "customerId": "uuid",
  "latitude": 29.7604,
  "longitude": -95.3698
}
```

### Response

```json
{
  "id": "uuid"
}
```

---

## GET https://public-api.live.buildops.com/v1/jobs

List jobs for a tenant, paginated. Used by the incremental sync cron with `lastUpdatedDateStart` to fetch only changed jobs.

### Request Parameters

| Parameter Name | In | Required | Type | Description |
|---|---|---|---|---|
| `page` | query | No | integer | Page index, starting from 0 |
| `page_size` | query | No | integer | Items per page (default 200) |
| `lastUpdatedDateStart` | query | No | string (ISO 8601) | Watermark for incremental sync — returns jobs updated after this timestamp |

### Response

```json
{
  "totalCount": 800,
  "items": [
    {
      "id": "uuid",
      "jobNumber": "J-10042",
      "status": "Open",
      "customerId": "uuid",
      "customerPropertyId": "uuid",
      "customerName": "ACME HVAC Corp",
      "jobTypeId": "uuid",
      "jobTypeName": "Time & Material",
      "priceBookId": "uuid",
      "version": 1,
      "isUseTaxable": false,
      "departments": [{ "id": "uuid", "name": "Service" }],
      "isFlagged": false,
      "issueDescription": null,
      "audit": {
        "createdDate": "2025-05-14",
        "createdDateTime": 1747180800000,
        "lastUpdatedDate": "2025-05-14",
        "lastUpdatedDateTime": 1747180800000
      }
    }
  ]
}
```

---

## POST https://public-api.live.buildops.com/v1/jobs

Create a new job. Called mid-call by `handlePrepareJob` when a valid, non-blocked customer is confirmed.

### Request Body

```json
{
  "customerPropertyId": "uuid",
  "jobTypeId": "uuid",
  "priceBookId": "uuid",
  "customerId": "uuid",
  "isUseTaxable": false,
  "status": "Open",
  "departments": [
    { "id": "uuid" }
  ]
}
```

**Default values used by the integration:**

| Field | Default |
|---|---|
| `jobTypeId` | `04df1a40-16b1-43f4-aa9b-8eafcec812ad` (Time & Material) |
| `departments[0].id` | `d87c1a38-4acd-459f-9b3f-446a810fae10` (default department) |
| `status` | `Open` |
| `isUseTaxable` | `false` |

### Response

```json
{
  "id": "uuid",
  "jobNumber": "J-10043",
  "status": "Open",
  "customerId": "uuid",
  "customerPropertyId": "uuid",
  "jobTypeId": "uuid",
  "priceBookId": "uuid",
  "version": 1,
  "isUseTaxable": false,
  "departments": [{ "id": "uuid", "name": "Service" }],
  "audit": {
    "createdDate": "2025-05-14",
    "createdDateTime": 1747180800000,
    "lastUpdatedDate": "2025-05-14",
    "lastUpdatedDateTime": 1747180800000
  }
}
```

---

## GET https://public-api.live.buildops.com/v1/jobs/{jobId}

Fetch a single job by BuildOps job UUID.

### Request Parameters

| Parameter Name | In | Required | Type | Description |
|---|---|---|---|---|
| `jobId` | path | Yes | string (UUID) | BuildOps job UUID |

### Response

Same shape as individual items in the `GET /v1/jobs` response above.

---

## PUT https://public-api.live.buildops.com/v1/jobs/{jobId}

Update an existing job. Uses optimistic locking — `version` must match the current server version or the request will be rejected.

### Request Parameters

| Parameter Name | In | Required | Type | Description |
|---|---|---|---|---|
| `jobId` | path | Yes | string (UUID) | BuildOps job UUID |

### Request Body

```json
{
  "version": 1,
  "status": "Open",
  "issueDescription": "string",
  "departments": [{ "id": "uuid" }]
}
```

### Response

`204 No Content`

---

## POST https://public-api.live.buildops.com/v1/jobs/{jobId}/tasks

Create a task (line item group) on an existing job. Called by `handleAddTaskToJob` when the agent fires `add_task_to_job`.

### Request Parameters

| Parameter Name | In | Required | Type | Description |
|---|---|---|---|---|
| `jobId` | path | Yes | string (UUID) | BuildOps job UUID |

### Request Body

```json
{
  "name": "string",
  "entries": [
    {
      "productId": "uuid",
      "description": "string",
      "quantity": 1
    }
  ]
}
```

### Response

`204 No Content`

---

## POST https://public-api.live.buildops.com/v1/jobs/{jobId}/tags

Add a tag to a job (used for department assignment or flagging jobs that need review).

### Request Parameters

| Parameter Name | In | Required | Type | Description |
|---|---|---|---|---|
| `jobId` | path | Yes | string (UUID) | BuildOps job UUID |

### Request Body

```json
{
  "tagId": "uuid"
}
```

### Response

`204 No Content`

---

## GET https://public-api.live.buildops.com/v1/job-types

List all job types for the tenant. Used during admin/config to discover the UUID for the default "Time & Material" job type.

### Request Parameters

| Parameter Name | In | Required | Type | Description |
|---|---|---|---|---|
| `tenantId` | query | Yes | string (UUID) | BuildOps tenant UUID |

### Response

```json
{
  "data": [
    {
      "id": "uuid",
      "name": "Time & Material",
      "tagName": "T&M",
      "isActive": true
    }
  ]
}
```
