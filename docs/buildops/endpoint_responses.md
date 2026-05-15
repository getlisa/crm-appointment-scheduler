# BuildOps Endpoint Testing — Curl Reference

Base URL: `http://localhost:8080`  
All commands are single-line Windows CMD compatible.

---

## Step 1 — List tenants (verify setup)

```
curl http://localhost:8080/api/buildops/admin/tenants
```

**Expected response**
```json
{"tenants":[{"no":"+19842056510","buildops_tenant_id":"470f824e-94a8-41c1-9ef6-c87bbe099dd2","company_name":null,"is_active":true}]}
```

---

## Step 2 — Create inbound call session

Use `to_number` = tenant's registered E.164 number. Use `from_number` = a phone number belonging to a test customer in `buildops_customers.all_numbers`.  
**Every test run needs a unique `call_id`.** Reusing one silently fails (see Mistakes section).

```
curl -X POST http://localhost:8080/api/buildops/retell/webhook -H "Content-Type: application/json" -d "{\"event\": \"call_inbound\", \"call\": {\"call_id\": \"test-call-001\", \"to_number\": \"+19842056510\", \"from_number\": \"9330243839\"}}"
```

### Case A — Customer not found (phone not in DB)
```json
{"call_inbound":{"dynamic_variables":{"status":"not_found","identified":"false","confidence":"0","customer_id":"","customer_name":"","from_number":"933-024-3839","new_number_detected":"false","address_count":"0","addresses":"[]","multiple_matches":"false"}}}
```

### Case B — Customer found (phone matches a record)
```json
{"call_inbound":{"dynamic_variables":{"status":"found","identified":"true","confidence":"1.0","customer_id":"08af512c-930d-408e-8cc2-673871b44c14","customer_name":"clara","from_number":"933-024-3839","new_number_detected":"false","address":"2 Church St, Toronto, ON, M5E 1Z3","address_source":"propertyAddress","multiple_matches":"false","property_count":"1","property_id":"039de7b5-1549-4077-9965-7c82308ff9bc"}}}
```

---

## Step 3b — Confirm customer

Only needed when `status` is `multiple_matches`. Pass the `id` of the candidate the caller confirmed.

```
curl -X POST http://localhost:8080/api/buildops/fn/confirm_customer -H "Content-Type: application/json" -d "{\"call\": {\"call_id\": \"test-call-001\"}, \"args\": {\"candidate_id\": \"08af512c-930d-408e-8cc2-673871b44c14\"}}"
```

**Expected response**
```json
{"result":"{\"status\":\"confirmed\",\"customer\":{\"id\":\"08af512c-930d-408e-8cc2-673871b44c14\",\"name\":\"clara\",\"address\":\"2 Church St, Toronto, ON, M5E 1Z3\",\"addressSource\":\"propertyAddress\"},\"property_count\":1,\"property_id\":\"039de7b5-1549-4077-9965-7c82308ff9bc\"}"}
```

---

## Step 3c — Match property

Only needed when `property_count` > 1. Pass whatever the caller says as `spoken_address`.

```
curl -X POST http://localhost:8080/api/buildops/fn/match_property -H "Content-Type: application/json" -d "{\"call\": {\"call_id\": \"test-call-001\"}, \"args\": {\"spoken_address\": \"2 Church Street\"}}"
```

**Expected response**
```json
{"result":"{\"status\":\"matched\",\"property_id\":\"039de7b5-1549-4077-9965-7c82308ff9bc\",\"address\":{\"zip\":\"M5E 1Z3\",\"city\":\"Toronto\",\"line1\":\"2 Church St\",\"line2\":null,\"state\":\"ON\"}}"}
```

---

## Step 3d — Prepare job

Pass the `property_id` resolved in step 3c (or pre-populated `property_id` from step 2 when `property_count` is 1).

```
curl -X POST http://localhost:8080/api/buildops/fn/prepare_job -H "Content-Type: application/json" -d "{\"call\": {\"call_id\": \"test-call-001\"}, \"args\": {\"customer_property_id\": \"039de7b5-1549-4077-9965-7c82308ff9bc\"}}"
```

**Expected response**
```json
{"result":"{\"status\":\"created\",\"job_id\":\"8d7033db-1231-46fd-98e3-beb55573fd6c\",\"job_number\":\"5143\",\"needs_review\":false,\"summary\":{\"property_address\":{\"zip\":\"M5E 1Z3\",\"city\":\"Toronto\",\"line1\":\"2 Church St\",\"line2\":null,\"state\":\"ON\"},\"job_status\":\"Open\",\"task_count\":0}}"}
```

---

## Step 3e — Add representative (optional)

Only needed when `new_number_detected` is `true` or the caller volunteers a new contact.

```
curl -X POST http://localhost:8080/api/buildops/fn/add_representative -H "Content-Type: application/json" -d "{\"call\": {\"call_id\": \"test-call-001\"}, \"args\": {\"first_name\": \"John\", \"last_name\": \"Doe\", \"phone\": \"+15551234567\", \"property_id\": \"039de7b5-1549-4077-9965-7c82308ff9bc\"}}"
```

**Expected response**
```json
{"result":"{\"status\":\"added\",\"representative_id\":\"1238e2a0-ca3a-4a77-a856-ce4b92d3ab64\",\"name\":\"John Doe\"}"}
```

---

## Step 4 — End call

```
curl -X POST http://localhost:8080/api/buildops/retell/webhook -H "Content-Type: application/json" -d "{\"event\": \"call_ended\", \"call\": {\"call_id\": \"test-call-001\"}}"
```

**Expected response**
```json
{"ok":true}
```

---

## Mistakes & Gotchas

### 1. Reusing a `call_id` → silent `{"ok":true}`

`createInboundCall` is a plain `INSERT` with a `UNIQUE` constraint on `retell_call_id`. If you fire `call_inbound` with a `call_id` that already exists in `buildops_inbound_calls`, the insert throws a unique constraint violation. The outer `try/catch` in the webhook handler catches it silently and returns `{"ok":true}` — no error, no inbound response, no session created.

**Fix:** Increment the call_id for every new test run (`test-call-002`, `test-call-003`, etc.).

---

### 2. `from_number` not matching → `status: not_found`

Phone lookup uses `all_numbers` GIN index (last 10 digits). If the number you pass is not in `buildops_customers.all_numbers` for the tenant, the session is created but returns `not_found`. You then need `lookup_customer_fuzzy` to continue.

**Fix:** Use a number that exists in `all_numbers` for the test tenant, or run `lookup_customer_fuzzy` afterwards.

---

### 3. `address`, `address_source` empty on `found` response

If the customer record has no `business_address`, no `billing_address`, and no entries in `property_ids`, `pickPrimaryAddress` returns `null` for both fields. The dynamic variable shows `address: ""`.

**Why it happens:** Customer was synced before addresses were populated, or the cron has not run yet for that tenant.

**Fix:** Run the cron sync, or manually update the customer row with a `business_address` value.

---

### 4. `prepare_job` → `"error: property not found or does not belong to this customer"`

This was a FK mismatch bug: the validation compared `buildops_properties.customer_id` (a BuildOps ID string) against `session.matchedCustomerId` (our internal UUID). They are different ID spaces and will never match.

**Status:** Fixed — now compares against `customer.buildopsCustomerId`.

---

### 5. `prepare_job` → BuildOps 400 `departments must NOT have additional properties`

The initial implementation sent `departments: [{ id: "..." }]` in the job creation body. The BuildOps API schema uses `additionalProperties: false` and the correct field is `departmentIds: ["..."]` (flat array of UUID strings, not an array of objects).

**Status:** Fixed — `CreateJobInput` now uses `departmentIds?: string[] | null`.

---

### 6. `match_property` or `get_properties` returning empty when properties exist

`getPropertiesForCustomer` was querying `buildops_properties WHERE customer_id = <our UUID>` but `buildops_properties.customer_id` stores the BuildOps ID (`buildops_customer_id`), not our internal UUID. This meant property queries always returned empty.

**Status:** Fixed — all property lookups now use `getPropertiesByIds(customer.propertyIds)` which queries `buildops_properties.id IN (property_ids)`, the correct primary key.
