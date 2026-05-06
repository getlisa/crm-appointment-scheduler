# Retell ↔ BuildOps Integration Plan (v4)

## Context

A cron job populates Supabase tables with BuildOps data (customers, properties, departments, pricebook items) and rotates the access token in the `inbound_no_to_tenant_resolution` table. This service reads the stored access token — it does **not** run OAuth itself. All lookups (customers, properties, pricebook) go through Supabase. Property selection is conversational — the agent holds the chosen `propertyId` and passes it directly to `create_job` (not persisted mid-call).

---

## Universal Request Headers (every BuildOps API call)
- `Authorization: Bearer <access_token>` — read from `inbound_no_to_tenant_resolution.access_token`
- `tenantId: <buildops_tenant_id>` — from the resolution table, linked to the inbound number

---

## Architecture

```
Caller ──► Retell Inbound Number (TO_NUMBER) ──► Retell Agent
                  FROM_NUMBER = caller                │
                                           custom function webhooks
                                                      ▼
                                  POST /api/buildops/retell/webhook
                                                      │
               ┌──────────────────────────────────────┼────────────────────────┐
               │                                      │                        │
        Supabase tables                       inbound_calls              BuildOps API
  (tenants, customers, properties,            (session state)     (reads: access_token
   departments, resolution)                                        from resolution table)
               │
               └── pricebook_items table (cron-synced from BuildOps /allcustomers)
```

---

## 9 Supabase Tables

### 1. `jobs`
Stores BuildOps job data (cron-populated or written by this service on creation).

| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| job_id | TEXT | BuildOps `id` (UUID string) |
| job_number | TEXT | e.g. "SA1001-229" |
| status | TEXT | Complete / Open / etc. |
| customer_property_id | TEXT | |
| customer_name | TEXT | |
| customer_id | TEXT | BuildOps customerId |
| job_type_id | TEXT | |
| job_type_name | TEXT | |
| price_book_id | TEXT | |
| priority | TEXT | |
| version | INT | Required for updateJob |
| billing_status | TEXT | |
| review_status | TEXT | |
| billing_type | TEXT | |
| amount_quoted | FLOAT | |
| is_use_taxable | BOOLEAN | |
| departments | JSONB | `[{"id":"...","name":"..."}]` — a job has multiple departments |
| due_date | TIMESTAMPTZ | |
| is_flagged | BOOLEAN | |
| tenant_id | UUID FK → tenants | |
| audit | JSONB | createdDate, lastUpdatedDate, etc. |

**API functions (bearer + tenantId always required):**
- `getJobType(tenantId)` — GET job types for tenant
- `createJob(customerPropertyId, jobTypeId, priceBookId, customerId, isUseTaxable, status)` — status: Open | In Progress | On Hold | Cancelled
- `createJobTag(jobId, ...)` — tag a job
- `getJob(jobId)` — get by ID
- `updateJob(jobId, { customerPropertyId, jobTypeId, customerId, isUseTaxable, version, status })` — update by ID
- `createTask(jobId, name, entries[{ productId, description, quantity }])` — add task to job

### 2. `tenants`
One row per BuildOps workspace/account.

| Column | Type |
|---|---|
| id | UUID PK |
| buildops_tenant_id | TEXT UNIQUE (given by BuildOps) |
| company_name | TEXT |
| is_active | BOOLEAN |
| e164_no | TEXT UNIQUE (inbound number, E.164) |
| business_address | JSONB |
| billing_address | JSONB |

### 3. `customers`
Cron-populated BuildOps customer records per tenant.

| Column | Type |
|---|---|
| id | UUID PK |
| tenant_id | UUID FK → tenants |
| buildops_customer_id | TEXT |
| name | TEXT |
| phone_primary | TEXT |
| phone_secondary | TEXT |
| is_active | BOOLEAN |
| addresses | JSONB array |
| normalized_phone_primary | TEXT (last 10 digits) |
| normalized_phone_secondary | TEXT |

**API functions:**
- `getCustomer(customerId, tenantId, addressType?)` — get by ID
- `createCustomer(name, addressType)` — create new
- `updateCustomer(customerId, tenantId, body)` — update by ID

**Indexes:**
```sql
CREATE INDEX ON customers(tenant_id, normalized_phone_primary);
CREATE INDEX ON customers(tenant_id, normalized_phone_secondary);
CREATE INDEX ON customers(tenant_id, name);
```

### 4. `property`
Customer service locations.

| Column | Type |
|---|---|
| id | UUID PK |
| name | TEXT |
| phone_primary | TEXT |
| customer_id | UUID FK → customers |
| address | JSONB |

**API functions:**
- `getProperty(propertyId, tenantId)` — get by ID
- `getPropertiesByTenant(tenantId)` — all for tenant
- `createProperty(customerId, latitude, longitude)` — create new location

**Index:**
```sql
CREATE INDEX ON property(customer_id);
```

### 5. `departments`
Cron-populated. Jobs are assigned to multiple departments.

| Column | Type |
|---|---|
| id | UUID PK |
| tag_name | TEXT |
| tenant_id | UUID FK → tenants |
| phone_primary | TEXT |
| email | TEXT |
| is_active | BOOLEAN |

**API function:** `getDepartments(tenantId)` — list all

### 6. `inbound_calls`
One row per Retell inbound call. Written by this service.

| Column | Type |
|---|---|
| id | UUID PK |
| retell_call_id | TEXT UNIQUE |
| tenant_id | UUID FK → tenants |
| caller | TEXT (FROM_NUMBER, E.164) |
| receiver | TEXT (TO_NUMBER, E.164) |
| matched_customer_id | UUID FK → customers (nullable) |
| status | TEXT (active / job_created / handed_off / ended) |
| buildops_job_id | TEXT (nullable, set after create_job) |

Note: property selection is conversational state held by the Retell agent — `propertyId` is passed as an argument to `create_job`, not stored here.

### 7. `inbound_no_to_tenant_resolution`
Maps each Retell inbound number to a BuildOps tenant + stores the current access token (rotated by cron job).

| Column | Type |
|---|---|
| no | TEXT PK (E.164 inbound number) |
| client_id | TEXT |
| client_secret | TEXT |
| access_token | TEXT (cron-generated, rotated) |
| buildops_tenant_id | TEXT |

This is the only table the service reads to obtain `access_token` + `buildops_tenant_id` for API calls.

### 8. `pricebook_items`
Cron-populated from GET /allcustomers (all pricebook fields collected across customers, deduped by productId per tenant). Refreshed on a scheduled interval.

| Column | Type |
|---|---|
| id | UUID PK |
| tenant_id | UUID FK → tenants |
| product_id | TEXT |
| name | TEXT |
| description | TEXT |
| unit_price | FLOAT |
| taxable | BOOLEAN |
| is_active | BOOLEAN |
| synced_at | TIMESTAMPTZ |

```sql
UNIQUE (tenant_id, product_id);
CREATE INDEX ON pricebook_items(tenant_id, is_active);
```

This service only reads from this table (no writes). The `get_pricebook_items` function does `ilike` on `name` + `description`, active only, limit 10.

---

---

## Retell Custom Functions

| Function | Inputs from agent | Action |
|---|---|---|
| `lookup_customer_by_phone` | — (caller from session) | Supabase phone exact match |
| `lookup_customer_fuzzy` | `name?`, `address?`, `zip?`, `old_phone?` | Pull ≤200 candidates → in-memory fuzzy score |
| `confirm_customer` | `candidate_id` | Write `matched_customer_id` to `inbound_calls` |
| `get_properties_for_customer` | — | Query `property` by `customer_id` |
| `get_pricebook_items` | `search_term?` | ilike search on `pricebook_items` table |
| `get_job_types` | — | BuildOps API → tenant job types |
| `get_departments` | — | Query `departments` table |
| `create_job` | `customerPropertyId`, `jobTypeId`, `priceBookId`, `customerId`, `isUseTaxable`, `status` | POST to BuildOps + write `buildops_job_id` to `inbound_calls` |
| `add_task_to_job` | `jobId`, `name`, `entries[{productId, description, quantity}]` | POST task to BuildOps |

---

## New Files

```
src/services/buildops/
├── types.ts                    # All TypeScript interfaces
├── client.ts                   # BuildOps API calls (reads token from resolution table)
├── fuzzy-search.ts             # Jaro-Winkler + Double Metaphone + weighted scoring
├── db/
│   ├── tenants.ts              # resolveByInboundNumber, getTenant
│   ├── customers.ts            # findCustomersByPhone, getFuzzyCandidates
│   ├── properties.ts           # getPropertiesForCustomer
│   ├── departments.ts          # getDepartments
│   ├── pricebook.ts            # searchPricebook (reads pricebook_items table)
│   ├── jobs.ts                 # upsertJob
│   └── inbound-calls.ts        # createCall, setMatchedCustomer, setJobCreated, setStatus
└── handlers/
    ├── phone-lookup.ts          # lookup_customer_by_phone
    ├── fuzzy-lookup.ts          # lookup_customer_fuzzy
    ├── customer.ts              # confirm_customer, get_properties, confirm_property
    ├── pricebook.ts             # get_pricebook_items
    ├── job-types.ts             # get_job_types, get_departments
    └── job.ts                   # create_job, add_task_to_job

src/routes/buildops.ts           # Express router (webhook + admin endpoints)
src/lib/retell.ts                # Dispatcher: call_started + function routing

tests/buildops/
├── fuzzy-search.test.ts         # Unit: Jaro-Winkler scoring + threshold bands
├── client.test.ts               # Integration: BuildOps API calls reach correct endpoints
├── retell-webhook.test.ts       # Integration: call_started + each tool_call function
└── db.test.ts                   # Integration: Supabase read/write on test data
```

**Modified:**
- `src/config/env.ts` — add `BUILDOPS_API_URL`
- `src/server.ts` — mount `/api/buildops`

---

## Implementation Details

### `src/services/buildops/types.ts`

```typescript
// Resolution table row
interface ResolutionRow { no: string; access_token: string; buildops_tenant_id: string; }

// BuildOps API request context (derived from resolution table on call start)
interface BuildOpsContext { accessToken: string; buildopsTenantId: string; apiUrl: string; }

// Supabase rows (camelCase)
interface TenantRow { id: string; buildopsTenantId: string; e164No: string; companyName: string; isActive: boolean; }
interface CustomerRow { id: string; tenantId: string; buildopsCustomerId: string; name: string; phonePrimary?: string; phoneSecondary?: string; isActive: boolean; addresses: AddressObj[]; normalizedPhonePrimary?: string; normalizedPhoneSecondary?: string; }
interface PropertyRow { id: string; name?: string; phonePrimary?: string; customerId: string; address: AddressObj; }
interface DepartmentRow { id: string; tagName: string; tenantId: string; email?: string; isActive: boolean; }
interface InboundCallRow { id: string; retellCallId: string; tenantId: string; caller?: string; receiver: string; matchedCustomerId?: string; status: string; buildopsJobId?: string; }
interface AddressObj { line1?: string; line2?: string; city?: string; state?: string; zip?: string; }

// Pricebook
interface PricebookItem { productId: string; name: string; description?: string; unitPrice?: number; taxable: boolean; }

// Fuzzy
interface FuzzyQuery { name?: string; address?: string; zip?: string; oldPhone?: string; }
interface ScoredCandidate { customer: CustomerRow; score: number; }
type LookupDecision =
  | { band: 'accept'; candidate: CustomerRow }
  | { band: 'disambiguate'; candidates: CustomerRow[] }
  | { band: 'handoff' };

// Job
interface CreateJobInput { customerPropertyId: string; jobTypeId: string; priceBookId: string; customerId: string; isUseTaxable: boolean; status: JobStatus; }
interface TaskEntry { productId: string; description?: string; quantity: number; }
type JobStatus = 'Open' | 'In Progress' | 'On Hold' | 'Cancelled';

// BuildOps Job response shape (key fields used by this service)
interface BuildOpsJob {
  id: string; jobNumber: string; status: string; customerId: string;
  customerPropertyId: string; jobTypeId: string; priceBookId: string;
  version: number; isUseTaxable: boolean; tenantId: string;
  departments: { id: string; name: string }[];  // multi-department array
  audit: { createdDate: string; lastUpdatedDate: string; };
}
```

### `src/services/buildops/client.ts`

No OAuth — just reads stored `access_token`. All methods accept `BuildOpsContext`:

```typescript
function buildHeaders(ctx: BuildOpsContext) {
  return { Authorization: `Bearer ${ctx.accessToken}`, tenantId: ctx.buildopsTenantId };
}

async function getJobTypes(ctx: BuildOpsContext): Promise<JobTypeItem[]>
async function createJob(ctx: BuildOpsContext, input: CreateJobInput): Promise<{ jobId: string; jobNumber: string }>
async function createJobTag(ctx: BuildOpsContext, jobId: string, tagData: unknown): Promise<void>
async function getJob(ctx: BuildOpsContext, jobId: string): Promise<unknown>
async function updateJob(ctx: BuildOpsContext, jobId: string, body: Partial<CreateJobInput> & { version: number }): Promise<void>
async function createTask(ctx: BuildOpsContext, jobId: string, name: string, entries: TaskEntry[]): Promise<void>
async function getCustomer(ctx: BuildOpsContext, customerId: string, addressType?: string): Promise<unknown>
async function createCustomer(ctx: BuildOpsContext, name: string, addressType: string): Promise<{ customerId: string }>
async function updateCustomer(ctx: BuildOpsContext, customerId: string, body: unknown): Promise<void>
async function getProperty(ctx: BuildOpsContext, propertyId: string): Promise<unknown>
async function getPropertiesByTenant(ctx: BuildOpsContext): Promise<PropertyRow[]>
async function createProperty(ctx: BuildOpsContext, customerId: string, latitude: number, longitude: number): Promise<{ propertyId: string }>
async function getAllCustomers(ctx: BuildOpsContext): Promise<unknown[]>  // used by cron; not called mid-call
```

### `src/services/buildops/db/` (one file per entity)

**`tenants.ts`**
```typescript
async function resolveByInboundNumber(e164: string): Promise<ResolutionRow | null>
```

**`inbound-calls.ts`**
```typescript
async function createInboundCall(p: { retellCallId, tenantId, caller?, receiver }): Promise<InboundCallRow>
async function getInboundCall(retellCallId: string): Promise<InboundCallRow>
async function setMatchedCustomer(retellCallId: string, customerId: string): Promise<void>
async function setJobCreated(retellCallId: string, jobId: string): Promise<void>
async function setCallStatus(retellCallId: string, status: string): Promise<void>
```

**`customers.ts`**
```typescript
async function findCustomersByPhone(tenantId: string, phoneLast10: string): Promise<CustomerRow[]>
async function getFuzzyCandidates(tenantId: string, query: FuzzyQuery): Promise<CustomerRow[]>  // LIMIT 200
```

**`properties.ts`**
```typescript
async function getPropertiesForCustomer(customerId: string): Promise<PropertyRow[]>
```

**`departments.ts`**
```typescript
async function getDepartments(tenantId: string): Promise<DepartmentRow[]>
```

**`pricebook.ts`**
```typescript
async function searchPricebook(tenantId: string, searchTerm: string, limit?: number): Promise<PricebookRow[]>
// ilike on name + description, active only, LIMIT 10
```

`getFuzzyCandidates` query logic:
- `query.zip` → filter `addresses` JSONB for zip match
- `query.name` → `name ILIKE '%<name>%'`
- Both → AND; one → that filter; neither → return empty + agent must ask
- Always `LIMIT 200`

### `src/services/buildops/pricebook.ts`

```typescript
// Pricebook is now read from the pricebook_items Supabase table (cron-populated).
// See src/services/buildops/db/pricebook.ts for searchPricebook().
```

### `src/services/buildops/fuzzy-search.ts`

No external dependencies — all implemented in this single file (~150 lines):

```typescript
// Jaro-Winkler similarity (~35 lines)
function jaroWinkler(s1: string, s2: string): number

// Soundex phonetic hash (~25 lines) — catches Smith/Smyth, Johnson/Johnston
function soundex(word: string): string
function phoneticBonus(a: string, b: string): number  // soundex(a) === soundex(b) → +0.10

// USPS abbreviation table — inline constant (Street→ST, Avenue→AVE, Road→RD, etc.)
const USPS_ABBR: Record<string, string>
function normalizeAddress(line: string): string       // uppercase, expand abbrevs, strip punctuation

// Jaccard token-set ratio — for address line comparison
function tokenSetRatio(a: string, b: string): number

function normalizeName(s: string): string             // lowercase, strip diacritics, collapse whitespace
function normalizePhoneLast10(s: string): string      // digits only, last 10

// Main scoring — sorted descending by score
export function scoreCandidates(query: FuzzyQuery, candidates: CustomerRow[]): ScoredCandidate[]

// Decision band assignment
export function applyThreshold(candidates: ScoredCandidate[]): LookupDecision
```

Weighted scoring (against `customer.name` split into first/last word and `customer.addresses[0]`):

| Field | Method | Weight |
|---|---|---|
| last name token | Jaro-Winkler + Soundex bonus | 0.25 |
| first name token | Jaro-Winkler | 0.10 |
| address line1 | Token-set ratio, USPS normalized | 0.30 |
| city | Exact normalized | 0.05 |
| state | Exact | 0.05 |
| zip (first 5) | Exact | 0.10 |
| old phone | Last-10 exact → full weight | 0.15 |

Thresholds:
- `>= 0.90` AND gap to #2 `>= 0.10` → `accept`
- `0.75 – 0.90` OR gap < 0.10 → `disambiguate` (return top 3)
- `< 0.75` → `handoff`

*(`session.ts` is removed — inbound-call lifecycle functions live in `src/services/buildops/db/inbound-calls.ts` and are imported directly by handlers.)*

### `src/lib/retell.ts`

Top-level dispatcher:
```typescript
export async function handleRetellWebhook(body: unknown): Promise<object>
```

**`call_started` handler:**
1. Extract `call.to_number` (receiver), `call.from_number` (caller), `call.call_id`
2. `resolveByInboundNumber(toNumber)` → not found → return graceful error string
3. Build `BuildOpsContext` from resolution row + `env.buildopsApiUrl`
4. `createInboundCall({ retellCallId, tenantId, caller, receiver })`
5. Return `{ ok: true }`

**`tool_call` handler:**
1. `getInboundCall(callId)` → load session
2. `resolveByInboundNumber(session.receiver)` → rebuild `BuildOpsContext`
3. Route by function `name`:

| Function | Logic |
|---|---|
| `lookup_customer_by_phone` | normalize caller last 10 → `findCustomersByPhone()` → 1 match: `setMatchedCustomer()` + confirm; 2+: disambiguate list; 0: "not found" |
| `lookup_customer_fuzzy` | `getFuzzyCandidates()` → `scoreCandidates()` → `applyThreshold()`: accept → `setMatchedCustomer()`; disambiguate → top 3 list; handoff → `setCallStatus('handed_off')` + hand-off script |
| `confirm_customer` | verify `candidate_id` in DB → `setMatchedCustomer()` |
| `get_properties_for_customer` | `getPropertiesForCustomer(session.matched_customer_id)` → format list |
| `get_pricebook_items` | `getPricebook(tenantId, ctx)` → `searchPricebook(items, searchTerm)` |
| `get_job_types` | `getJobTypes(ctx)` → return list |
| `get_departments` | `getDepartments(tenantId)` → return list |
| `create_job` | validate session has `matchedCustomerId`; `createJob(ctx, args)`; `setJobCreated(jobId)`; `setCallStatus('job_created')`; return job number |
| `add_task_to_job` | `createTask(ctx, jobId, name, entries)` |

### `src/routes/buildops.ts`

```typescript
router.post('/retell/webhook', async (req, res) => {
  const result = await handleRetellWebhook(req.body);
  res.json(result);
});

// Admin: upsert tenant record (for onboarding)
router.post('/admin/tenant', ...);

// Admin: list tenants
router.get('/admin/tenants', ...);
```

Zod validates all inputs.

### `src/config/env.ts`

Add: `BUILDOPS_API_URL: z.string().url().optional()` → `env.buildopsApiUrl` (default `'https://public-api.live.buildops.com'`).

### `src/server.ts`

```typescript
import buildopsRouter from './routes/buildops.js';
app.use('/api/buildops', buildopsRouter);
```

---

## Dependencies to Add

**Runtime:** None — fuzzy matching is fully custom-implemented.

**Dev (tests):**
```bash
npm install --save-dev vitest @vitest/coverage-v8
```
Vitest is chosen over Jest because the project uses `"type": "module"` (ESM) and TypeScript — Vitest handles both natively without extra transform config.

Add to `package.json`:
```json
"scripts": {
  "test": "vitest run",
  "test:watch": "vitest"
}
```

---

## Test Files

### `tests/buildops/fuzzy-search.test.ts` — Unit tests (no network, no DB)
```typescript
import { describe, it, expect } from 'vitest';
import { scoreCandidates, applyThreshold } from '../../src/services/buildops/fuzzy-search';

describe('jaroWinkler', () => { /* exact match = 1.0, empty = 0, transposition */ });

describe('scoreCandidates', () => {
  it('scores exact name + address as near 1.0');
  it('scores "Smyth" against "Smith" above 0.80 (phonetic bonus)');
  it('scores "123 Oak" against "123 Oak Street" above 0.75 (USPS normalization)');
  it('scores unrelated candidate below 0.50');
});

describe('applyThreshold', () => {
  it('returns accept when top score >= 0.90 and gap >= 0.10');
  it('returns disambiguate when top score 0.75-0.90');
  it('returns handoff when top score < 0.75');
});
```

### `tests/buildops/client.test.ts` — BuildOps API call integration
Uses `vi.fn()` to mock `fetch` / the HTTP layer; asserts correct URL, headers, and body shape:
```typescript
it('createJob sends customerPropertyId, jobTypeId, priceBookId, customerId, isUseTaxable, status');
it('createTask sends name and entries array under the correct jobId path');
it('all requests include Authorization: Bearer <token> and tenantId headers');
it('createJob returns { jobId, jobNumber } from response body');
```

### `tests/buildops/retell-webhook.test.ts` — Retell webhook integration
Mocks Supabase client and BuildOps client; drives the full handler chain:
```typescript
it('call_started resolves tenant by TO_NUMBER and inserts inbound_calls row');
it('call_started returns { ok: true } for known number');
it('call_started returns graceful error for unknown TO_NUMBER');

it('lookup_customer_by_phone matches by normalized phone and sets matched_customer_id');
it('lookup_customer_by_phone returns not-found when no match');

it('lookup_customer_fuzzy returns accept result and calls setMatchedCustomer');
it('lookup_customer_fuzzy returns disambiguate list when score 0.75-0.90');
it('lookup_customer_fuzzy returns handoff instruction when score < 0.75');

it('create_job posts to BuildOps and writes buildops_job_id to inbound_calls');
it('create_job returns error when session has no matched_customer_id');
it('add_task_to_job sends entries array to correct endpoint');
```

### `tests/buildops/db.test.ts` — Supabase query integration
Requires `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` env vars; runs against a seeded test schema:
```typescript
it('resolveByInboundNumber returns resolution row for known number');
it('findCustomersByPhone returns matching customer by normalized phone');
it('getFuzzyCandidates limits to 200 rows and filters by name + zip');
it('searchPricebook returns active items matching search term');
it('createInboundCall inserts row; setMatchedCustomer updates matched_customer_id');
```

---

## Build Order

1. Create Supabase tables (SQL per schemas above)
2. `src/services/buildops/types.ts`
3. `src/config/env.ts` — add BUILDOPS_API_URL
4. `src/services/buildops/client.ts` — all BuildOps API calls (no OAuth)
5. `src/services/buildops/db/tenants.ts`
6. `src/services/buildops/db/inbound-calls.ts`
7. `src/services/buildops/db/customers.ts`
8. `src/services/buildops/db/properties.ts`
9. `src/services/buildops/db/departments.ts`
10. `src/services/buildops/db/pricebook.ts`
11. `src/services/buildops/fuzzy-search.ts` (Jaro-Winkler + Soundex + scoring — no dependencies)
12. `src/services/buildops/handlers/phone-lookup.ts`
13. `src/services/buildops/handlers/fuzzy-lookup.ts`
14. `src/services/buildops/handlers/customer.ts`
15. `src/services/buildops/handlers/pricebook.ts`
16. `src/services/buildops/handlers/job-types.ts`
17. `src/services/buildops/handlers/job.ts`
18. `src/lib/retell.ts` — dispatcher routing call events + functions to handlers
19. `src/routes/buildops.ts` — Express router + Zod schemas
20. `src/server.ts` — mount router
21. `npm install --save-dev vitest @vitest/coverage-v8` + update `package.json` scripts
22. `tests/buildops/fuzzy-search.test.ts`
23. `tests/buildops/client.test.ts`
24. `tests/buildops/retell-webhook.test.ts`
25. `tests/buildops/db.test.ts`

---

## Verification

1. **Fuzzy scoring unit test** — call `scoreCandidates()` with typos ("Smyth"→"Smith", "123 Oak" for "123 Oak Street"); assert bands.
2. **call_started** — `curl -X POST /api/buildops/retell/webhook -d '{"event":"call_started","call":{"call_id":"t1","to_number":"+15552000001","from_number":"+15559876543"}}'` → row in `inbound_calls`.
3. **Phone lookup** — mock `tool_call` for `lookup_customer_by_phone` → correct customer + `matched_customer_id` written.
4. **Fuzzy lookup** — partial name + zip → correct band.
5. **create_job** — full args → verify BuildOps POST has all required fields (`customerPropertyId`, `jobTypeId`, `priceBookId`, `customerId`, `isUseTaxable`, `status`); `buildops_job_id` written to `inbound_calls`.
6. **E2E** — real Retell call → trace `retell_call_id` through `inbound_calls` → job in BuildOps.
