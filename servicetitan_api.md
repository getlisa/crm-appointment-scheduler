# ServiceTitan API Document
----------------------------
## GET https://api.servicetitan.io/crm/v2/tenant/{tenant}/customers (production environment)
## GET https://api-integration.servicetitan.io/crm/v2/tenant/{tenant}/customers (integration Environemnt)

### Request Parameters

| Parameter Name | In | Required | Type | Description |
|---|---|---|---|---|
| `tenant` | path | Yes | integer (int64) | Tenant ID |
| `page` | query | No | integer (int32) | The logical number of page to return, starting from 1 |
| `pageSize` | query | No | integer (int32) | How many records to return (50 by default) |
| `includeTotal` | query | No | boolean | Whether total count should be returned |
| `ids` | query | No | string | Returns specific customer records by customer ID |
| `name` | query | No | string | Returns customer records by name |
| `street` | query | No | string | Returns customer records by street |
| `unit` | query | No | string | Returns customer records by unit |
| `city` | query | No | string | Returns customer records by city |
| `state` | query | No | string | Returns customer records by state |
| `zip` | query | No | string | Returns customer records by zip |
| `country` | query | No | string | Returns customer records by country |
| `latitude` | query | No | number (double) | Returns customer records by latitude |
| `longitude` | query | No | number (double) | Returns customer records by longitude |
| `phone` | query | No | string | Returns customer records by phone number of contacts |
| `active` | query | No | ActiveRequestArg | Returns customer records by active status (only active items are returned by default). Values: `[True, Any, False]` |

### Response

{
  "page": 0,
  "pageSize": 0,
  "hasMore": true,
  "totalCount": 0,
  "data": [
    {
      "id": 0,
      "active": true,
      "name": "string",
      "type": {},
      "address": {
        "street": "string",
        "unit": "string",
        "city": "string",
        "state": "string",
        "zip": "string",
        "country": "string",
        "latitude": 0,
        "longitude": 0
      },
      "customFields": [
        {
          "typeId": 0,
          "name": "string",
          "value": "string"
        }
      ],
      "balance": 0,
      "taxExempt": true,
      "tagTypeIds": [
        0
      ],
      "doNotMail": true,
      "doNotService": true,
      "nationalAccount": true,
      "createdOn": "string",
      "createdById": 0,
      "modifiedOn": "string",
      "mergedToId": 0,
      "paymentTermId": 0,
      "creditLimit": 0,
      "creditLimitBalance": 0,
      "externalData": [
        {
          "key": "string",
          "value": "string"
        }
      ]
    }
  ]
}

## POST https://api.servicetitan.io/crm/v2/tenant/{tenant}/customers (production environment)
## POST https://api-integration.servicetitan.io/crm/v2/tenant/{tenant}/customers (integration environment)

### Request parameters

| Parameter Name | In | Required | Type | Description |
|---|---|---|---|---|
| `tenant` | path | Yes | integer (int64) | Tenant ID |

### Request Body
{
  "required": [
    "name",
    "locations",
    "address"
  ],
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "description": "Name of the customer"
    },
    "type": {
      "oneOf": [
        {
          "$ref": "#/components/schemas/Crm.V2.CustomerType"
        },
        {
          "type": "null"
        }
      ],
      "description": "Residential or commercial"
    },
    "doNotMail": {
      "type": [
        "boolean",
        "null"
      ],
      "description": "Customer has been flagged as “do not mail”"
    },
    "doNotService": {
      "type": [
        "boolean",
        "null"
      ],
      "description": "Customer has been flagged as “do not service”"
    },
    "nationalAccount": {
      "type": [
        "boolean",
        "null"
      ],
      "description": "Customer has been flagged as National Account"
    },
    "locations": {
      "type": "array",
      "items": {
        "$ref": "#/components/schemas/Crm.V2.Customers.NewLocation"
      },
      "description": "Locations for the customer"
    },
    "address": {
      "oneOf": [
        {
          "$ref": "#/components/schemas/Crm.V2.Customers.CustomerAddress"
        }
      ],
      "description": "Bill-To address of the customer record"
    },
    "contacts": {
      "type": [
        "array",
        "null"
      ],
      "items": {
        "$ref": "#/components/schemas/Crm.V2.Customers.NewCustomerContact"
      },
      "description": "Contacts for the customer"
    },
    "customFields": {
      "type": [
        "array",
        "null"
      ],
      "items": {
        "$ref": "#/components/schemas/Crm.V2.Customers.CustomFieldUpdateModel"
      },
      "description": "Customer record’s custom fields"
    },
    "tagTypeIds": {
      "type": [
        "array",
        "null"
      ],
      "items": {
        "type": "integer",
        "format": "int64"
      },
      "description": "Tag Type IDs to be associated with the customer"
    },
    "externalData": {
      "oneOf": [
        {
          "$ref": "#/components/schemas/Crm.V2.ExternalDataCreateRequest"
        },
        {
          "type": "null"
        }
      ],
      "description": "Optional model that contains a list of external data items\nthat should be attached to this Customer."
    },
    "taxExempt": {
      "type": [
        "boolean",
        "null"
      ],
      "description": "Optional Tax Exempt."
    },
    "paymentTermId": {
      "type": [
        "integer",
        "null"
      ],
      "description": "Optional Payment Term ID.",
      "format": "int64"
    },
    "creditLimit": {
      "type": [
        "number",
        "null"
      ],
      "description": "Credit Limit for the customer.",
      "format": "decimal"
    },
    "creditLimitBalance": {
      "type": [
        "number",
        "null"
      ],
      "description": "Credit Limit for the customer.",
      "format": "decimal"
    }
  },
  "additionalProperties": false
}

### Response
{
  "id": 0,
  "active": true,
  "name": "string",
  "type": {},
  "address": {
    "street": "string",
    "unit": "string",
    "city": "string",
    "state": "string",
    "zip": "string",
    "country": "string",
    "latitude": 0,
    "longitude": 0
  },
  "customFields": [
    {
      "typeId": 0,
      "name": "string",
      "value": "string"
    }
  ],
  "balance": 0,
  "taxExempt": true,
  "tagTypeIds": [
    0
  ],
  "doNotMail": true,
  "doNotService": true,
  "nationalAccount": true,
  "createdOn": "string",
  "createdById": 0,
  "modifiedOn": "string",
  "mergedToId": 0,
  "paymentTermId": 0,
  "creditLimit": 0,
  "creditLimitBalance": 0,
  "externalData": [
    {
      "key": "string",
      "value": "string"
    }
  ],
  "locations": [
    {
      "taxZoneId": 0,
      "id": 0,
      "customerId": 0,
      "active": true,
      "name": "string",
      "address": {
        "street": "string",
        "unit": "string",
        "city": "string",
        "state": "string",
        "zip": "string",
        "country": "string",
        "latitude": 0,
        "longitude": 0
      },
      "customFields": [
        {
          "typeId": 0,
          "name": "string",
          "value": "string"
        }
      ],
      "createdOn": "string",
      "createdById": 0,
      "modifiedOn": "string",
      "mergedToId": 0,
      "zoneId": 0,
      "taxExempt": true,
      "tagTypeIds": [
        0
      ],
      "externalData": [
        {
          "key": "string",
          "value": "string"
        }
      ],
      "contacts": [
        {
          "id": 0,
          "type": {},
          "value": "string",
          "memo": "string"
        }
      ]
    }
  ],
  "contacts": [
    {
      "id": 0,
      "type": {},
      "value": "string",
      "memo": "string"
    }
  ]
}

## GET https://api.servicetitan.io/crm/v2/tenant/{tenant}/locations (production environment)
## GET https://api-integration.servicetitan.io/crm/v2/tenant/{tenant}/locations (integration environment)

### Request Parameters
| Parameter Name | In | Required | Type | Description |
|---|---|---|---|---|
| `tenant` | path | Yes | integer (int64) | Tenant ID |
| `ids` | query | No | string | Perform lookup by multiple IDs (maximum 50) |
| `name` | query | No | string | Filters by customer's name |
| `customerId` | query | No | integer (int64) | Filters by customer ID |
| `street` | query | No | string | Filters by customer's street |
| `unit` | query | No | string | Filters by customer's unit |
| `city` | query | No | string | Filters by customer's city |
| `state` | query | No | string | Filters by customer's state |
| `zip` | query | No | string | Filters by customer's zip |
| `country` | query | No | string | Filters by customer's country |
| `latitude` | query | No | number (double) | Filters by customer's latitude |
| `longitude` | query | No | number (double) | Filters by customer's longitude |
| `active` | query | No | ActiveRequestArg | What kind of items should be returned (only active items are returned by default). Values: `[True, Any, False]` |
| `page` | query | No | integer (int32) | The logical number of page to return, starting from 1 |
| `pageSize` | query | No | integer (int32) | How many records to return (50 by default) |
| `includeTotal` | query | No | boolean | Whether total count should be returned |


### Response
{
  "page": 0,
  "pageSize": 0,
  "hasMore": true,
  "totalCount": 0,
  "data": [
    {
      "id": 0,
      "customerId": 0,
      "active": true,
      "name": "string",
      "address": {
        "street": "string",
        "unit": "string",
        "city": "string",
        "state": "string",
        "zip": "string",
        "country": "string",
        "latitude": 0,
        "longitude": 0
      },
      "customFields": [
        {
          "typeId": 0,
          "name": "string",
          "value": "string"
        }
      ],
      "createdOn": "string",
      "createdById": 0,
      "modifiedOn": "string",
      "mergedToId": 0,
      "zoneId": 0,
      "taxExempt": true,
      "tagTypeIds": [
        0
      ],
      "externalData": [
        {
          "key": "string",
          "value": "string"
        }
      ],
      "taxZoneId": 0
    }
  ]
}


## POST https://api.servicetitan.io/crm/v2/tenant/{tenant}/locations (production environment)
## POST https://api-integration.servicetitan.io/crm/v2/tenant/{tenant}/locations (integration Environment)

### Request Parameters
| Parameter Name | In | Required | Type | Description |
|---|---|---|---|---|
| `tenant` | path | Yes | integer (int64) | Tenant ID |

### Request Body
{
  "name": "string",
  "address": {
    "street": "string",
    "unit": "string",
    "city": "string",
    "state": "string",
    "zip": "string",
    "country": "string",
    "latitude": 0,
    "longitude": 0
  },
  "contacts": [
    {
      "type": {},
      "value": "string",
      "memo": "string"
    }
  ],
  "customFields": [
    {
      "typeId": 0,
      "value": "string"
    }
  ],
  "tagTypeIds": [
    0
  ],
  "externalData": {
    "applicationGuid": "string",
    "externalData": [
      {
        "key": "string",
        "value": "string"
      }
    ]
  },
  "coordinatesSource": {},
  "coordinatesVerificationStatus": {},
  "customerId": 0
}


### Response
{
  "taxZoneId": 0,
  "id": 0,
  "customerId": 0,
  "active": true,
  "name": "string",
  "address": {
    "street": "string",
    "unit": "string",
    "city": "string",
    "state": "string",
    "zip": "string",
    "country": "string",
    "latitude": 0,
    "longitude": 0
  },
  "customFields": [
    {
      "typeId": 0,
      "name": "string",
      "value": "string"
    }
  ],
  "createdOn": "string",
  "createdById": 0,
  "modifiedOn": "string",
  "mergedToId": 0,
  "zoneId": 0,
  "taxExempt": true,
  "tagTypeIds": [
    0
  ],
  "externalData": [
    {
      "key": "string",
      "value": "string"
    }
  ],
  "contacts": [
    {
      "id": 0,
      "type": {},
      "value": "string",
      "memo": "string"
    }
  ]
}


