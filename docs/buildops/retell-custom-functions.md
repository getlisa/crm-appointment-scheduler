# Retell Custom Functions — Crockett Facilities (Clara)

All webhook functions share a single endpoint. Retell dispatches by the `name` field in the tool call payload.

**Shared endpoint:** `POST /api/buildops/retell/webhook`  
**Auth header:** `x-retell-signature: <Retell-generated HMAC>`  
**Content-Type:** `application/json`

---

## 1. `lookup_customer_fuzzy`

**Description:** Search for an existing customer when the caller's phone number was not recognized (`lookup_status = not_found`). Call with any combination of name, address, or zip. At least one parameter must be provided.

| Field | Value |
|---|---|
| **Type** | `custom` |
| **Method** | POST |
| **URL** | `/api/buildops/retell/webhook` |
| **Timeout** | 8000 ms |
| **speak_during_execution** | `true` |
| **execution_message_description** | `Let me look that up for you.` |
| **execution_message_type** | `static_text` |
| **speak_after_execution** | `false` |
| **enable_typing_sound** | `false` |

### Headers

| Key | Value |
|---|---|
| `Content-Type` | `application/json` |

### Parameters

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | No | Company or customer name as spoken by caller |
| `address` | string | No | Billing or mailing address as spoken by caller |
| `property_address` | string | No | Service location address as spoken by caller |
| `zip` | string | No | ZIP code as spoken by caller |
| `old_phone` | string | No | A previously used phone number the caller provides |

### Response Variables (`store_fields_as_variables`)

| Variable Name | JSON Path | Description |
|---|---|---|
| `status` | `$.status` | `found`, `multiple_matches`, or `not_found` |
| `customer_id` | `$.customer_id` | BuildOps customer UUID (present when `found`) |
| `customer_name` | `$.customer_name` | Display name of the matched customer |
| `candidates` | `$.candidates` | Array of `{id, name, address}` objects (present when `multiple_matches`) |
| `candidates_count` | `$.candidates_count` | Count of matched accounts |
| `addresses` | `$.addresses` | Billing address array for the confirmed customer |
| `property_count` | `$.property_count` | Number of service properties on the account |
| `property_id` | `$.property_id` | Property UUID (only set when `property_count = 1`) |
| `new_number_detected` | `$.new_number_detected` | `"true"` if the calling number is new to the account |

---

## 2. `confirm_customer`

**Description:** Confirm which customer the caller belongs to after a `multiple_matches` result. Read candidate names back to the caller, then invoke with the `id` of the one they confirm.

| Field | Value |
|---|---|
| **Type** | `custom` |
| **Method** | POST |
| **URL** | `/api/buildops/retell/webhook` |
| **Timeout** | 5000 ms |
| **speak_during_execution** | `false` |
| **execution_message_description** | _(empty)_ |
| **execution_message_type** | `prompt` |
| **speak_after_execution** | `false` |
| **enable_typing_sound** | `false` |

### Headers

| Key | Value |
|---|---|
| `Content-Type` | `application/json` |

### Parameters

| Field | Type | Required | Description |
|---|---|---|---|
| `candidate_id` | string | **Yes** | The `id` field from the chosen candidate in the `candidates` array |

### Response Variables (`store_fields_as_variables`)

| Variable Name | JSON Path | Description |
|---|---|---|
| `customer_id` | `$.customer.id` | Confirmed BuildOps customer UUID |
| `customer_name` | `$.customer.name` | Confirmed customer display name |
| `addresses` | `$.addresses` | Billing address array for the confirmed customer |
| `property_count` | `$.property_count` | Number of service properties on the account |
| `property_id` | `$.property_id` | Property UUID (only set when `property_count = 1`) |
| `new_number_detected` | `$.new_number_detected` | `"true"` if the calling number is new to the account |

---

## 3. `match_property`

**Description:** Fuzzy-match a spoken service address against the confirmed customer's properties to resolve the BuildOps property UUID. Invoke when `property_count > 1` and the caller states which address the job is for. Use the returned `property_id` as `customer_property_id` in `prepare_job`.

| Field | Value |
|---|---|
| **Type** | `custom` |
| **Method** | POST |
| **URL** | `/api/buildops/retell/webhook` |
| **Timeout** | 6000 ms |
| **speak_during_execution** | `true` |
| **execution_message_description** | `Let me find that address.` |
| **execution_message_type** | `static_text` |
| **speak_after_execution** | `false` |
| **enable_typing_sound** | `false` |

### Headers

| Key | Value |
|---|---|
| `Content-Type` | `application/json` |

### Parameters

| Field | Type | Required | Description |
|---|---|---|---|
| `spoken_address` | string | **Yes** | The service location address as spoken by the caller |

### Response Variables (`store_fields_as_variables`)

| Variable Name | JSON Path | Description |
|---|---|---|
| `status` | `$.status` | `matched`, `ambiguous`, or `not_found` |
| `property_id` | `$.property_id` | BuildOps property UUID (present when `matched`) |
| `matched_address` | `$.address` | Resolved full address string |
| `candidates` | `$.candidates` | Array of candidate addresses (present when `ambiguous`) |

---

## 4. `prepare_job`

**Description:** Queue a service job for creation in BuildOps after the call ends. Invoke once the customer is confirmed, the service address is resolved, and the service request is understood. Always set `needs_review = true` when the customer was matched at `confidence_tier 2`.

| Field | Value |
|---|---|
| **Type** | `custom` |
| **Method** | POST |
| **URL** | `/api/buildops/retell/webhook` |
| **Timeout** | 5000 ms |
| **speak_during_execution** | `false` |
| **execution_message_description** | _(empty)_ |
| **execution_message_type** | `prompt` |
| **speak_after_execution** | `false` |
| **enable_typing_sound** | `false` |

### Headers

| Key | Value |
|---|---|
| `Content-Type` | `application/json` |

### Parameters

| Field | Type | Required | Description |
|---|---|---|---|
| `customer_property_id` | string | **Yes** | BuildOps property UUID for the service address. Use `property_id` returned by `match_property` |
| `status` | string | No | Initial job status: `Open`, `In Progress`, `On Hold`, or `Cancelled`. Defaults to `Open` |
| `needs_review` | boolean | No | Set `true` if the customer was matched at `confidence_tier 2`. Flags the job for manual verification |
| `tasks` | array | No | Optional task line items (see sub-fields below) |

#### `tasks[]` sub-fields

| Field | Type | Required | Description |
|---|---|---|---|
| `tasks[].name` | string | Yes | Task display name shown on the work order |
| `tasks[].entries[]` | array | Yes | Line items for the task |
| `tasks[].entries[].product_id` | string | Yes | BuildOps product UUID |
| `tasks[].entries[].description` | string | No | Optional line item description override |
| `tasks[].entries[].quantity` | number | No | Number of units. Defaults to `1` |

### Response Variables (`store_fields_as_variables`)

| Variable Name | JSON Path | Description |
|---|---|---|
| `job_queue_status` | `$.status` | Confirmation that the job was queued (`queued`) |

---

## 5. `add_representative`

**Description:** Save a newly detected caller number to the customer's BuildOps account by creating a representative entry. Invoke when `new_number_detected = "true"` after customer identification. Collect the caller's first and last name before invoking.

| Field | Value |
|---|---|
| **Type** | `custom` |
| **Method** | POST |
| **URL** | `/api/buildops/retell/webhook` |
| **Timeout** | 5000 ms |
| **speak_during_execution** | `false` |
| **execution_message_description** | _(empty)_ |
| **execution_message_type** | `prompt` |
| **speak_after_execution** | `false` |
| **enable_typing_sound** | `false` |

### Headers

| Key | Value |
|---|---|
| `Content-Type` | `application/json` |

### Parameters

| Field | Type | Required | Description |
|---|---|---|---|
| `first_name` | string | **Yes** | Caller's first name |
| `last_name` | string | **Yes** | Caller's last name |
| `phone` | string | No | Phone number to save. Omit to default to the caller's `from_number` |
| `email` | string | No | Contact email (optional) |
| `property_id` | string | No | BuildOps property UUID to associate this representative with |

### Response Variables (`store_fields_as_variables`)

| Variable Name | JSON Path | Description |
|---|---|---|
| `representative_status` | `$.status` | Confirmation that the representative was saved (`saved`) |

---

## Reference — Non-Webhook Tools

These tools are configured directly in Retell and do not go through the webhook endpoint.

### `get_oncall_tech`

| Field | Value |
|---|---|
| **Type** | `code` |
| **Timeout** | 15000 ms |
| **speak_during_execution** | `true` |
| **execution_message_description** | `Let me check who is on call right now and connect you to the right personnel` |

Executes an inline JavaScript schedule lookup. Returns:

| Field | Description |
|---|---|
| `primary_tool` | Transfer tool name for the primary on-call technician |
| `primary_name` | Display name of the primary technician |
| `backup_tool` | Transfer tool name for the backup technician (`null` if none) |
| `backup_name` | Display name of the backup technician |
| `manager_tool` | Transfer tool name for the on-call manager |
| `manager_name` | Display name of the on-call manager |

---

### `end_call`

| Field | Value |
|---|---|
| **Type** | `end_call` |
| **speak_after_execution** | `true` |
| **Description** | End the call. Only invoke after asking "Is there anything else I can help you with?" and the caller confirms there is nothing else |

---

### `transfer_call_<Name>` (one per on-call person)

| Field | Value |
|---|---|
| **Type** | `transfer_call` |
| **Transfer type** | `agentic_warm_transfer` |
| **speak_during_execution** | `true` |
| **speak_after_execution** | `true` |
| **Ring duration** | 28000–33000 ms (varies per person) |
| **Transfer timeout** | 29000–60000 ms (varies per person) |
| **On timeout** | `cancel_transfer` |

Invoke using the tool name returned by `get_oncall_tech` (`primary_tool`, `backup_tool`, or `manager_tool`). Current roster: Omar Garcia Jr, Elder Rodriguez, Kyle Thomas, Eric Beer, Joseph Boecker, Zachary Marshall, Kamahl Scott, Ryan Gordan, Thomas Beder, Timothy Wylie, Brett Weaver, Austin Ramsy, Brian Cruz, Justin Hope, Nick Sansbury, Akil Raphael, Megan Jones, Tiffany Gibson, Damonz Vann, Tony Merlo, Scott Dashiell, Brittney Moyer, Mike Plotts.
