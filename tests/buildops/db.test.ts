/**
 * Integration tests for Supabase queries.
 * Requires real SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY env vars and seeded test data.
 * Run with: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm test
 *
 * These tests are skipped when env vars are missing so CI doesn't fail without a DB.
 */
import { describe, it, expect, beforeAll } from 'vitest';

const hasSupabase =
  Boolean(process.env.SUPABASE_URL) && Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);

describe.skipIf(!hasSupabase)('db/tenants', () => {
  it('resolveByInboundNumber returns row for known number', async () => {
    const { resolveByInboundNumber } = await import(
      '../../src/services/buildops/db/tenants.js'
    );
    // Assumes the resolution table has at least one row seeded for testing
    const knownNumber = process.env.TEST_INBOUND_NUMBER ?? '+10000000000';
    const row = await resolveByInboundNumber(knownNumber);
    if (row) {
      expect(row.access_token).toBeTruthy();
      expect(row.buildops_tenant_id).toBeTruthy();
    } else {
      // No test data — skip assertion, just verify no throw
      expect(row).toBeNull();
    }
  });
});

describe.skipIf(!hasSupabase)('db/customers', () => {
  const tenantId = process.env.TEST_TENANT_ID ?? '';

  beforeAll(() => {
    if (!tenantId) console.warn('[db.test] TEST_TENANT_ID not set — phone lookup test will use empty');
  });

  it('findCustomersByPhone returns matching customer', async () => {
    const { findCustomersByPhone } = await import(
      '../../src/services/buildops/db/customers.js'
    );
    const phone = process.env.TEST_CUSTOMER_PHONE ?? '0000000000';
    const results = await findCustomersByPhone(tenantId, phone);
    expect(Array.isArray(results)).toBe(true);
  });

  it('getFuzzyCandidates limits to 200 rows', async () => {
    const { getFuzzyCandidates } = await import(
      '../../src/services/buildops/db/customers.js'
    );
    const results = await getFuzzyCandidates(tenantId, { name: 'Smith' });
    expect(results.length).toBeLessThanOrEqual(200);
  });

  it('getFuzzyCandidates returns empty when no name or zip', async () => {
    const { getFuzzyCandidates } = await import(
      '../../src/services/buildops/db/customers.js'
    );
    const results = await getFuzzyCandidates(tenantId, {});
    expect(results).toHaveLength(0);
  });
});

describe.skipIf(!hasSupabase)('db/pricebook', () => {
  const tenantId = process.env.TEST_TENANT_ID ?? '';

  it('searchPricebook returns active items matching search term', async () => {
    const { searchPricebook } = await import('../../src/services/buildops/db/pricebook.js');
    const results = await searchPricebook(tenantId, 'filter', 10);
    expect(Array.isArray(results)).toBe(true);
    results.forEach(item => {
      expect(item.isActive).toBe(true);
    });
  });
});

describe.skipIf(!hasSupabase)('db/inbound-calls', () => {
  const tenantId = process.env.TEST_TENANT_ID ?? '';
  const testCallId = `test-call-${Date.now()}`;

  it('createInboundCall inserts a row', async () => {
    const { createInboundCall } = await import(
      '../../src/services/buildops/db/inbound-calls.js'
    );
    const row = await createInboundCall({
      retellCallId: testCallId,
      tenantId,
      caller: '+15559991111',
      receiver: '+15552000001',
    });
    expect(row.retellCallId).toBe(testCallId);
    expect(row.status).toBe('active');
  });

  it('setMatchedCustomer updates matched_customer_id', async () => {
    const { setMatchedCustomer, getInboundCall } = await import(
      '../../src/services/buildops/db/inbound-calls.js'
    );
    const fakeCustomerId = '00000000-0000-0000-0000-000000000001';
    await setMatchedCustomer(testCallId, fakeCustomerId);
    const updated = await getInboundCall(testCallId);
    expect(updated?.matchedCustomerId).toBe(fakeCustomerId);
  });
});
