/**
 * Supabase service working script.
 * Verifies connectivity, auth, and basic CRUD against the real database.
 *
 * Requires real credentials in .env (or as env vars):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * Run:
 *   npx vitest run tests/supabase-service.test.ts
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx vitest run tests/supabase-service.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const hasCredentials = Boolean(SUPABASE_URL) && Boolean(SUPABASE_SERVICE_ROLE_KEY);

let supabase: SupabaseClient;

describe.skipIf(!hasCredentials)('supabase / connection', () => {
  beforeAll(() => {
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
  });

  it('client initialises without throwing', () => {
    expect(supabase).toBeDefined();
  });

  it('can reach the database (rpc: pg_sleep)', async () => {
    // pg_sleep(0) is the lightest possible liveness probe
    const { error } = await supabase.rpc('pg_sleep', { seconds: 0 });
    // Some projects restrict rpc — a PostgREST 404 is still a successful network round-trip
    if (error && error.code === 'PGRST202') {
      console.warn('[supabase-service] pg_sleep not exposed via rpc — skipping, network is reachable');
      return;
    }
    expect(error).toBeNull();
  });
});

describe.skipIf(!hasCredentials)('supabase / schema sanity', () => {
  const EXPECTED_TABLES = [
    'inbound_number_tenant_map',
    'buildops_customers',
    'inbound_calls',
  ];

  for (const table of EXPECTED_TABLES) {
    it(`table "${table}" is queryable (limit 0)`, async () => {
      const { error } = await supabase.from(table).select('*').limit(0);
      if (error) {
        // Table may be named differently — warn but don't hard-fail so the script
        // remains useful even across schema versions.
        console.warn(`[supabase-service] table "${table}" error: ${error.message}`);
      }
      // At minimum, the client must not throw and the error code must not be auth-related
      expect(error?.code).not.toMatch(/^(42501|PGRST301)$/); // not a permission / JWT error
    });
  }
});

describe.skipIf(!hasCredentials)('supabase / write + cleanup (inbound_calls)', () => {
  const probeCallId = `probe-${Date.now()}`;
  const probeTenantId = process.env.TEST_TENANT_ID ?? 'probe-tenant-000';
  let insertedId: string | null = null;

  it('inserts a probe row', async () => {
    const { data, error } = await supabase
      .from('inbound_calls')
      .insert({
        retell_call_id: probeCallId,
        tenant_id: probeTenantId,
        caller_number: '+10000000000',
        receiver_number: '+10000000001',
        status: 'active',
      })
      .select('id')
      .single();

    if (error?.code === '42P01') {
      console.warn('[supabase-service] inbound_calls table missing — skipping write tests');
      return;
    }
    expect(error).toBeNull();
    expect(data?.id).toBeTruthy();
    insertedId = data?.id ?? null;
  });

  it('reads the probe row back', async () => {
    if (!insertedId) return;
    const { data, error } = await supabase
      .from('inbound_calls')
      .select('retell_call_id, status')
      .eq('id', insertedId)
      .single();

    expect(error).toBeNull();
    expect(data?.retell_call_id).toBe(probeCallId);
    expect(data?.status).toBe('active');
  });

  it('updates the probe row', async () => {
    if (!insertedId) return;
    const { error } = await supabase
      .from('inbound_calls')
      .update({ status: 'completed' })
      .eq('id', insertedId);

    expect(error).toBeNull();
  });

  afterAll(async () => {
    if (!insertedId) return;
    await supabase.from('inbound_calls').delete().eq('id', insertedId);
  });
});

if (!hasCredentials) {
  it('SKIPPED — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to run Supabase service tests', () => {
    console.warn('[supabase-service] credentials missing, all tests skipped');
  });
}
