// This script performs end-to-end testing of the BuildOps job creation workflow via Retell's API.
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://localhost:8080/api/buildops';
const TENANT_INBOUND_NO = process.env.TENANT_INBOUND_NO ?? '+19842056510';

const CLARA = {
  id: '08af512c-930d-408e-8cc2-673871b44c14',
  name: 'clara',
  phoneE164: '+19330243839',
  propertyId: '039de7b5-1549-4077-9965-7c82308ff9bc',
  address: '2 Church St, Toronto, ON',
};

const CLARA_CUSTOMER = {
  id: 'dc45fcd3-e445-4c72-837e-005f89502161',
  name: 'Clara Customer',
  phoneE164: '+14155201480',
  address: '742 Evergreen Terrace, Suite 1, Springfield, IL',
};

const UNKNOWN_CALLER = '+17778887777';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

async function getSession(callId: string): Promise<Record<string, unknown> | null> {
  const { data } = await supabase
    .from('buildops_inbound_calls')
    .select('retell_call_id, caller, tenant_id, matched_customer_id, status, buildops_job_id')
    .eq('retell_call_id', callId)
    .single();
  return (data as Record<string, unknown> | null) ?? null;
}

async function getMostRecentSession(): Promise<Record<string, unknown> | null> {
  const { data } = await supabase
    .from('buildops_inbound_calls')
    .select('session_id, retell_call_id, caller, tenant_id, matched_customer_id, status, buildops_job_id, created_at')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  return (data as Record<string, unknown> | null) ?? null;
}

type Result = { label: string; pass: boolean; detail: string };
const results: Result[] = [];

function check(label: string, condition: boolean, detail: string): boolean {
  results.push({ label, pass: condition, detail });
  const icon = condition ? '✓' : '✗';
  console.log(`  ${icon} ${label}: ${detail}`);
  return condition;
}

function parseResult(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && 'result' in (raw as object)) {
    const r = (raw as Record<string, unknown>).result;
    if (typeof r === 'string') {
      try { return JSON.parse(r) as Record<string, unknown>; } catch { return { raw: r }; }
    }
    return r as Record<string, unknown>;
  }
  return raw as Record<string, unknown>;
}

// ── Test A: Unknown caller → fuzzy → job → add_rep → call_ended ──────────────

async function testA() {
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('TEST A — Unknown caller → fuzzy lookup → job → add_rep → call_ended');
  console.log('══════════════════════════════════════════════════════════');
  const callId = 'test-a-job-001';

  console.log('\n[A1] call_inbound — unknown caller (expect: not_found)');
  const inboundRes = await post('/retell/webhook', {
    event: 'call_inbound',
    call_inbound: { from_number: UNKNOWN_CALLER, to_number: TENANT_INBOUND_NO },
  }) as Record<string, unknown>;
  const inboundVars = (inboundRes?.call_inbound as Record<string, unknown>)?.dynamic_variables as Record<string, unknown> | undefined;
  check('A1 status=not_found', inboundVars?.status === 'not_found', `status="${inboundVars?.status}"`);

  const sessionAfterInbound = await getMostRecentSession();
  check(
    'A1 session created',
    !!sessionAfterInbound && sessionAfterInbound.caller === UNKNOWN_CALLER && sessionAfterInbound.matched_customer_id === null,
    `caller="${sessionAfterInbound?.caller}", matched="${sessionAfterInbound?.matched_customer_id}"`,
  );
  const tempId = sessionAfterInbound?.session_id as string | undefined;
  console.log(`     session_id: "${tempId}"`);

  console.log('\n[A2] call_started — real call_id assigned (expect: session swap)');
  await post('/retell/webhook', {
    event: 'call_started',
    call: { call_id: callId, from_number: UNKNOWN_CALLER, to_number: TENANT_INBOUND_NO },
  });
  const sessionAfterStarted = await getSession(callId);
  check(
    'A2 session swap',
    !!sessionAfterStarted,
    sessionAfterStarted
      ? `retell_call_id="${sessionAfterStarted.retell_call_id}" (was "${tempId}")`
      : 'session NOT found by real call_id — swap failed',
  );

  console.log('\n[A3] lookup_customer_fuzzy — name="clara", address (expect: found → clara.id)');
  const fuzzyRaw = await post('/fn/lookup_customer_fuzzy', {
    call: { call_id: callId, from_number: UNKNOWN_CALLER, to_number: TENANT_INBOUND_NO },
    name: 'clara',
    property_address: '2 Church St Toronto',
  });
  const fuzzy = parseResult(fuzzyRaw);
  check('A3 fuzzy status=found', fuzzy.status === 'found', `status="${fuzzy.status}" customer_id="${fuzzy.customer_id}"`);
  check('A3 fuzzy customer=clara', fuzzy.customer_id === CLARA.id, `got="${fuzzy.customer_id}" want="${CLARA.id}"`);
  const sessionAfterFuzzy = await getSession(callId);
  check('A3 matchedCustomerId set', sessionAfterFuzzy?.matched_customer_id === CLARA.id, `matched="${sessionAfterFuzzy?.matched_customer_id}"`);

  console.log('\n[A4] prepare_job — clara property (expect: created)');
  const jobRaw = await post('/fn/prepare_job', {
    call: { call_id: callId, from_number: UNKNOWN_CALLER, to_number: TENANT_INBOUND_NO },
    customer_property_id: CLARA.propertyId,
    issue_description: 'Test A — job creation script',
  });
  const job = parseResult(jobRaw);
  check('A4 job status=created', job.status === 'created', `status="${job.status}"`);
  if (job.status === 'created') {
    console.log(`     job_id="${job.job_id}"  job_number="${job.job_number}"`);
  } else {
    console.log(`     failure reason: ${JSON.stringify(job)}`);
  }
  const sessionAfterJob = await getSession(callId);
  check('A4 session.status=job_created', sessionAfterJob?.status === 'job_created', `status="${sessionAfterJob?.status}"`);
  check('A4 buildops_job_id set', !!sessionAfterJob?.buildops_job_id, `buildops_job_id="${sessionAfterJob?.buildops_job_id}"`);

  console.log('\n[A5] add_representative — new caller number (expect: added)');
  const repRaw = await post('/fn/add_representative', {
    call: { call_id: callId, from_number: UNKNOWN_CALLER, to_number: TENANT_INBOUND_NO },
    first_name: 'Test',
    last_name: 'Caller',
  });
  const rep = parseResult(repRaw);
  check('A5 rep status=added', rep.status === 'added', `status="${rep.status}" ${rep.status !== 'added' ? JSON.stringify(rep) : ''}`);

  console.log('\n[A6] call_ended — disconnection_reason=user_hangup');
  await post('/retell/webhook', {
    event: 'call_ended',
    call: {
      call_id: callId,
      from_number: UNKNOWN_CALLER,
      to_number: TENANT_INBOUND_NO,
      disconnection_reason: 'user_hangup',
    },
  });
  const sessionFinal = await getSession(callId);
  check('A6 session.status=user_hangup', sessionFinal?.status === 'user_hangup', `status="${sessionFinal?.status}"`);
}

// ── Test B: Registered caller (clara) → direct id → job → call_ended ─────────

async function testB() {
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('TEST B — Registered caller (clara) → direct identification → job → call_ended');
  console.log('══════════════════════════════════════════════════════════');
  const callId = 'test-b-job-001';

  console.log('\n[B1] call_inbound — clara registered number (expect: found, matched to clara)');
  const inboundRes = await post('/retell/webhook', {
    event: 'call_inbound',
    call_inbound: { from_number: CLARA.phoneE164, to_number: TENANT_INBOUND_NO },
  }) as Record<string, unknown>;
  const inboundVars = (inboundRes?.call_inbound as Record<string, unknown>)?.dynamic_variables as Record<string, unknown> | undefined;
  check('B1 status=found', inboundVars?.status === 'found', `status="${inboundVars?.status}" customer_name="${inboundVars?.customer_name}"`);

  const sessionAfterInbound = await getMostRecentSession();
  check('B1 matchedCustomerId=clara', sessionAfterInbound?.matched_customer_id === CLARA.id, `matched="${sessionAfterInbound?.matched_customer_id}"`);
  const tempId = sessionAfterInbound?.session_id as string | undefined;

  console.log('\n[B2] call_started — swap UUID to real call_id');
  await post('/retell/webhook', {
    event: 'call_started',
    call: { call_id: callId, from_number: CLARA.phoneE164, to_number: TENANT_INBOUND_NO },
  });
  const sessionAfterStarted = await getSession(callId);
  check('B2 session swap', !!sessionAfterStarted, sessionAfterStarted ? `swapped from "${tempId}"` : 'swap failed');

  console.log('\n[B3] prepare_job — clara property (expect: created)');
  const jobRaw = await post('/fn/prepare_job', {
    call: { call_id: callId, from_number: CLARA.phoneE164, to_number: TENANT_INBOUND_NO },
    customer_property_id: CLARA.propertyId,
    issue_description: 'Test B — job creation script',
  });
  const job = parseResult(jobRaw);
  check('B3 job status=created', job.status === 'created', `status="${job.status}"`);
  if (job.status === 'created') {
    console.log(`     job_id="${job.job_id}"  job_number="${job.job_number}"`);
  } else {
    console.log(`     failure reason: ${JSON.stringify(job)}`);
  }

  console.log('\n[B4] call_ended — disconnection_reason=user_hangup');
  await post('/retell/webhook', {
    event: 'call_ended',
    call: {
      call_id: callId,
      from_number: CLARA.phoneE164,
      to_number: TENANT_INBOUND_NO,
      disconnection_reason: 'user_hangup',
    },
  });
  const sessionFinal = await getSession(callId);
  check('B4 session.status=user_hangup', sessionFinal?.status === 'user_hangup', `status="${sessionFinal?.status}"`);
}

// ── Test C: Clara Customer (no property, no priceBook) → expect failure ───────

async function testC() {
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('TEST C — Clara Customer (no property/priceBook) → expected job creation failure');
  console.log('══════════════════════════════════════════════════════════');
  const callId = 'test-c-job-001';

  console.log('\n[C1] call_inbound — Clara Customer registered number (expect: found)');
  const inboundRes = await post('/retell/webhook', {
    event: 'call_inbound',
    call_inbound: { from_number: CLARA_CUSTOMER.phoneE164, to_number: TENANT_INBOUND_NO },
  }) as Record<string, unknown>;
  const inboundVars = (inboundRes?.call_inbound as Record<string, unknown>)?.dynamic_variables as Record<string, unknown> | undefined;
  check('C1 status=found', inboundVars?.status === 'found', `status="${inboundVars?.status}" customer_name="${inboundVars?.customer_name}"`);

  console.log('\n[C2] call_started');
  await post('/retell/webhook', {
    event: 'call_started',
    call: { call_id: callId, from_number: CLARA_CUSTOMER.phoneE164, to_number: TENANT_INBOUND_NO },
  });

  console.log('\n[C3] prepare_job — expect failure (no priceBookId on customer record)');
  const jobRaw = await post('/fn/prepare_job', {
    call: { call_id: callId, from_number: CLARA_CUSTOMER.phoneE164, to_number: TENANT_INBOUND_NO },
    customer_property_id: 'nonexistent-property-id',
    issue_description: 'Test C — expected failure',
  });
  const job = parseResult(jobRaw);
  const isExpectedFailure = job.status !== 'created';
  check(
    'C3 job fails (expected)',
    isExpectedFailure,
    isExpectedFailure
      ? `reason: ${typeof job === 'string' ? job : (job.message ?? job.result ?? JSON.stringify(job))}`
      : 'UNEXPECTED: job was created — Clara Customer should not have been able to create a job',
  );

  console.log('\n[C4] call_ended');
  await post('/retell/webhook', {
    event: 'call_ended',
    call: {
      call_id: callId,
      from_number: CLARA_CUSTOMER.phoneE164,
      to_number: TENANT_INBOUND_NO,
      disconnection_reason: 'user_hangup',
    },
  });
  const sessionFinal = await getSession(callId);
  check('C4 session.status=user_hangup', sessionFinal?.status === 'user_hangup', `status="${sessionFinal?.status}"`);
}

// ── Summary ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== BuildOps Job Creation Test ===');
  console.log(`BASE_URL: ${BASE_URL}`);
  console.log(`TENANT_INBOUND_NO: ${TENANT_INBOUND_NO}`);

  await testA();
  await testB();
  await testC();

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('RESULTS');
  console.log('══════════════════════════════════════════════════════════');
  let pass = 0, fail = 0;
  for (const r of results) {
    const icon = r.pass ? '✓' : '✗';
    console.log(`${icon} ${r.label}: ${r.detail}`);
    if (r.pass) pass++; else fail++;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch(console.error);
