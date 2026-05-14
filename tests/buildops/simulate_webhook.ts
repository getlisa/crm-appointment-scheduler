/**
 * Simulates a full Retell inbound-call flow against the local server.
 *
 * Usage:
 *   node simulate_webhook.ts --inbound=+15551234567 --caller=+18049720061
 *
 * Steps:
 *   1. Gets a fresh BuildOps access token
 *   2. Registers/updates the tenant via POST /api/buildops/admin/tenant
 *   3. Sends call_started
 *   4. Sends lookup_customer_by_phone
 *   5. Sends get_job_types
 *   6. Sends create_job  (if lookup matched a customer — requires job_type_id etc.)
 *
 * Prerequisites:
 *   - `npm run dev` running in a separate terminal (server on port 8080)
 *   - Supabase tables exist: inbound_no_to_tenant_resolution, inbound_calls, customers
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const CLIENT_ID     = process.env.CLIENT_ID!;
const CLIENT_SECRET = process.env.CLIENT_SECRET!;
const TENANT_ID     = process.env.TENANT_ID!;
const BUILDOPS_URL  = 'https://public-api.live.buildops.com/v1';
const LOCAL_SERVER  = 'http://localhost:8080';

// ── Parse CLI args ─────────────────────────────────────────────────────────────

function getArg(flag: string): string | undefined {
  const match = process.argv.find(a => a.startsWith(`--${flag}=`));
  return match?.split('=', 2)[1];
}

const INBOUND_NO = getArg('inbound');  // E.164, e.g. +15551234567
const CALLER_NO  = getArg('caller');   // E.164, e.g. +18049720061

if (!INBOUND_NO || !CALLER_NO) {
  console.error('Usage: node simulate_webhook.ts --inbound=+1XXXXXXXXXX --caller=+1XXXXXXXXXX');
  process.exit(1);
}

// ── Helpers ────────────────────────────────────────────────────────────────────

let stepNo = 0;
function step(label: string) {
  stepNo++;
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Step ${stepNo}: ${label}`);
  console.log('─'.repeat(60));
}

async function post(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = text; }
  console.log(`  HTTP ${res.status}`);
  console.log('  Response:', JSON.stringify(data, null, 2));
  return data;
}

async function webhook(body: unknown): Promise<unknown> {
  return post(`${LOCAL_SERVER}/api/buildops/retell/webhook`, body);
}

// ── BuildOps auth ──────────────────────────────────────────────────────────────

async function getAccessToken(): Promise<string> {
  const res = await fetch(`${BUILDOPS_URL}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, tenantId: TENANT_ID }),
  });
  if (!res.ok) throw new Error(`BuildOps auth failed: ${res.status}`);
  return (await res.json()).access_token;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const CALL_ID = `sim-${Date.now()}`;
  console.log(`Simulating call  call_id=${CALL_ID}`);
  console.log(`  inbound (to)  : ${INBOUND_NO}`);
  console.log(`  caller (from) : ${CALLER_NO}`);

  // 1. Fresh BuildOps token
  step('Get BuildOps access token');
  const accessToken = await getAccessToken();
  console.log(`  Token: ${accessToken.slice(0, 40)}...`);

  // 2. Register / refresh tenant in Supabase via admin endpoint
  step('Register tenant via POST /api/buildops/admin/tenant');
  await post(`${LOCAL_SERVER}/api/buildops/admin/tenant`, {
    buildops_tenant_id: TENANT_ID,
    company_name:       'Test Company',
    e164_no:            INBOUND_NO,
    is_active:          true,
    client_id:          CLIENT_ID,
    client_secret:      CLIENT_SECRET,
    access_token:       accessToken,
  });

  // 3. call_started
  step('Send call_started');
  await webhook({
    event:       'call_started',
    call: {
      call_id:     CALL_ID,
      to_number:   INBOUND_NO,
      from_number: CALLER_NO,
    },
  });

  // 4. lookup_customer_by_phone
  step('Function: lookup_customer_by_phone');
  const lookupResult = await webhook({
    event:     'tool_call',
    name:      'lookup_customer_by_phone',
    arguments: {},
    call: {
      call_id:     CALL_ID,
      to_number:   INBOUND_NO,
      from_number: CALLER_NO,
    },
  }) as { result?: string };

  // 5. get_job_types
  step('Function: get_job_types');
  await webhook({
    event:     'tool_call',
    name:      'get_job_types',
    arguments: {},
    call: {
      call_id:     CALL_ID,
      to_number:   INBOUND_NO,
      from_number: CALLER_NO,
    },
  });

  // 6. get_properties_for_customer
  step('Function: get_properties_for_customer');
  await webhook({
    event:     'tool_call',
    name:      'get_properties_for_customer',
    arguments: {},
    call: {
      call_id:     CALL_ID,
      to_number:   INBOUND_NO,
      from_number: CALLER_NO,
    },
  });

  // 7. call_ended
  step('Send call_ended');
  await webhook({
    event: 'call_ended',
    call: {
      call_id:     CALL_ID,
      to_number:   INBOUND_NO,
      from_number: CALLER_NO,
    },
  });

  console.log('\n\nSimulation complete.');
  console.log('To test create_job, copy a job_type_id and property_id from the responses above');
  console.log('and run step 6 manually or extend this script.');
}

main().catch(console.error);
