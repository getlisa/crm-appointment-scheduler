/**
 * Creates a job against claraprop2 using the already-indexed "Clara PropManager" rep,
 * then verifies customerRepName and customerRepSortKey are both populated.
 *
 * WHY WE LOOK UP THE REP INSTEAD OF CREATING A FRESH ONE
 * ─────────────────────────────────────────────────────────────────────────────
 * BuildOps indexes new reps asynchronously. Creating a rep and immediately using
 * it as customerRepId causes the accounting sync to fail with:
 *   "Cannot read properties of null (reading 'sortKey')"
 * because the rep isn't yet in their sync pipeline index.
 *
 * Using a pre-existing rep (already indexed) avoids the race condition.
 *
 * Usage: node create_job_with_property_rep.ts
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const CLIENT_ID     = process.env.CLIENT_ID!;
const CLIENT_SECRET = process.env.CLIENT_SECRET!;
const TENANT_ID     = process.env.TENANT_ID!;
const BASE_URL      = 'https://public-api.live.buildops.com/v1';

// ── Clara Customer (from buildops_customers) ──────────────────────────────────
const CUSTOMER_ID   = '3e34ee30-60e4-4017-ab5b-f7c1c7cb6426';
const PROPERTY_ID   = 'dc1fb42a-db15-4e82-9d50-8233879b5c49'; // claraprop2
const PRICE_BOOK_ID = 'f3bbf510-5937-48fe-9332-2e55a6f5e8a5';

// Rep to find — created earlier, already indexed by BuildOps
const TARGET_REP_LAST_NAME = 'PropManager';

const JOB_TYPE_ID = '04df1a40-16b1-43f4-aa9b-8eafcec812ad'; // Time & Material

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function getAccessToken(): Promise<string> {
  const res = await fetch(`${BASE_URL}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, tenantId: TENANT_ID }),
  });
  if (!res.ok) throw new Error(`Auth failed (${res.status}): ${await res.text()}`);
  return (await res.json()).access_token;
}

async function apiPost<T>(token: string, endpoint: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      tenantId: TENANT_ID,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`POST ${endpoint} → ${res.status}: ${text.slice(0, 400)}`);
  return data as T;
}

async function apiGet<T>(token: string, endpoint: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      tenantId: TENANT_ID,
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`GET ${endpoint} → ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

// ── Steps ─────────────────────────────────────────────────────────────────────

async function step1_findExistingRep(token: string): Promise<{ id: string; name: string; contactRole: string | null }> {
  console.log('\n── Step 1: Find existing property rep ──────────────────────────────────');
  console.log(`  GET /v1/properties/${PROPERTY_ID}/representatives`);
  console.log(`  Looking for: lastName="${TARGET_REP_LAST_NAME}"`);

  const data = await apiGet<{ items?: Record<string, unknown>[] }>(
    token,
    `/properties/${PROPERTY_ID}/representatives?page=0&page_size=100`,
  );

  const items = data.items ?? [];
  console.log(`  Found ${items.length} rep(s) on this property:`);
  for (const r of items) {
    console.log(`    - ${r['firstName']} ${r['lastName']} | role: ${r['contactRole'] ?? '(none)'} | id: ${r['id']}`);
  }

  const rep = items.find(
    r => String(r['lastName'] ?? '').toLowerCase() === TARGET_REP_LAST_NAME.toLowerCase(),
  );
  if (!rep) throw new Error(`Rep with lastName="${TARGET_REP_LAST_NAME}" not found on property ${PROPERTY_ID}. Run create_property_representative.ts first.`);

  const id = rep['id'] as string;
  const name = `${rep['firstName']} ${rep['lastName']}`;
  const contactRole = (rep['contactRole'] as string | null) ?? null;
  console.log(`\n  ✓ Using rep: "${name}" | role: ${contactRole ?? '(none)'} | id: ${id}`);
  return { id, name, contactRole };
}

async function step2_createJob(token: string, repId: string): Promise<{ id: string; jobNumber: string }> {
  console.log('\n── Step 2: Create job ──────────────────────────────────────────────────');
  console.log(`  POST /v1/jobs`);
  console.log(`  customerRepId  = ${repId}`);
  console.log(`  authorizedById = ${repId}`);

  const payload = {
    customerId:         CUSTOMER_ID,
    customerPropertyId: PROPERTY_ID,
    priceBookId:        PRICE_BOOK_ID,
    jobTypeId:          JOB_TYPE_ID,
    status:             'Open',
    isUseTaxable:       false,
    customerRepId:      repId,
    authorizedById:     repId,
    issueDescription:   '[Test Job - Clara Rep Visibility]\nVerifying customerRepName and customerRepSortKey are populated using a pre-indexed property rep.',
  };

  const job = await apiPost<Record<string, unknown>>(token, '/jobs', payload);
  const id = job['id'] as string;
  const jobNumber = job['jobNumber'] as string;

  console.log(`\n  ✓ jobId     : ${id}`);
  console.log(`  ✓ jobNumber : ${jobNumber}`);
  console.log(`  (create response) customerRepId   : ${job['customerRepId'] ?? '(null)'}`);
  console.log(`  (create response) customerRepName : ${job['customerRepName'] ?? '(null — resolved async)'}`);

  return { id, jobNumber };
}

async function step3_verifyJob(token: string, jobId: string): Promise<void> {
  console.log('\n── Step 3: Fetch job back and verify ───────────────────────────────────');
  console.log(`  GET /v1/jobs/${jobId}`);

  const job = await apiGet<Record<string, unknown>>(token, `/jobs/${jobId}`);

  const repId       = job['customerRepId']       as string | null;
  const repName     = job['customerRepName']      as string | null;
  const repSortKey  = job['customerRepSortKey']   as string | null;
  const authId      = job['authorizedById']       as string | null;
  const syncStatus  = job['syncStatus']           as string | null;
  const syncLog     = job['syncLog']              as string | null;

  console.log(`\n  jobNumber            : ${job['jobNumber']}`);
  console.log(`  status               : ${job['status']}`);
  console.log(`  customerRepId        : ${repId      ?? '(null)'}`);
  console.log(`  customerRepName      : ${repName    ?? '(null)'}`);
  console.log(`  customerRepSortKey   : ${repSortKey ?? '(null)'}`);
  console.log(`  authorizedById       : ${authId     ?? '(null)'}`);
  console.log(`  syncStatus           : ${syncStatus ?? '(null)'}`);
  console.log(`  syncLog              : ${syncLog    ?? '(null)'}`);

  console.log('\n═══════════════════════════════════════════════════════════════════════');

  const repOk      = !!repId;
  const nameOk     = !!repName;
  const sortKeyOk  = !!repSortKey;
  const syncOk     = syncStatus === 'InSync';

  console.log(`  customerRepId        : ${repOk     ? '✓' : '✗'} ${repId ?? 'missing'}`);
  console.log(`  customerRepName      : ${nameOk    ? '✓' : '✗'} ${repName ?? 'missing'}`);
  console.log(`  customerRepSortKey   : ${sortKeyOk ? '✓' : '✗'} ${repSortKey ?? 'missing — accounting sync will fail'}`);
  console.log(`  syncStatus           : ${syncOk    ? '✓' : '⏳'} ${syncStatus ?? 'null'} ${!syncOk ? '(may still be pending — re-check in BuildOps UI)' : ''}`);

  if (syncLog?.includes('Cannot read properties of null')) {
    console.log(`\n  ✗ syncLog still shows the null-sortKey error.`);
    console.log(`    If customerRepSortKey is set above, this may be a stale sync run —`);
    console.log(`    check the job in BuildOps UI in a minute.`);
  }

  console.log('═══════════════════════════════════════════════════════════════════════');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const token = await getAccessToken();
  console.log('Token acquired.');
  console.log(`\nTarget:`);
  console.log(`  customer   : Clara Customer (${CUSTOMER_ID})`);
  console.log(`  property   : claraprop2 (${PROPERTY_ID})`);
  console.log(`  priceBook  : ${PRICE_BOOK_ID}`);

  const rep = await step1_findExistingRep(token);
  const job = await step2_createJob(token, rep.id);
  await step3_verifyJob(token, job.id);

  console.log(`\n  Follow-up:`);
  console.log(`    node tests/buildops/api_endpoints/get_job.ts -id ${job.id}`);
}

main().catch(console.error);
