/**
 * Supabase connectivity and DB liveness tests.
 * Verifies the client initializes and the database is reachable.
 * Skipped automatically when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are absent.
 *
 * Run:
 *   npx vitest run tests/buildops/supabase-service.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
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
    const { error } = await supabase.rpc('pg_sleep', { seconds: 0 });
    // Some projects restrict rpc — a PostgREST 404 is still a successful network round-trip
    if (error && error.code === 'PGRST202') {
      console.warn('[supabase-service] pg_sleep not exposed via rpc — skipping, network is reachable');
      return;
    }
    expect(error).toBeNull();
  });
});

if (!hasCredentials) {
  it('SKIPPED — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to run Supabase connectivity tests', () => {
    console.warn('[supabase-service] credentials missing, all tests skipped');
  });
}
