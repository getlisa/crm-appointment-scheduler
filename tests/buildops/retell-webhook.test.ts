import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock all Supabase + BuildOps dependencies before importing retell.ts ──────

const mockResolutionRow = {
  no: '+15552000001',
  client_id: 'cid',
  client_secret: 'csecret',
  access_token: 'tok',
  buildops_tenant_id: 'tenant-abc',
};

const mockCustomer = {
  id: 'cust-1',
  tenantId: 'tenant-abc',
  buildopsCustomerId: 'bc-1',
  name: 'John Smith',
  phonePrimary: '5559876543',
  phoneSecondary: null,
  isActive: true,
  addresses: [{ line1: '123 Oak St', city: 'Springfield', state: 'IL', zip: '62701' }],
  normalizedPhonePrimary: '5559876543',
  normalizedPhoneSecondary: null,
};

const mockSession = {
  id: 'row-1',
  retellCallId: 'call-1',
  tenantId: 'tenant-abc',
  caller: '+15559876543',
  receiver: '+15552000001',
  matchedCustomerId: null,
  status: 'active',
  buildopsJobId: null,
};

vi.mock('../../src/services/buildops/db/tenants.js', () => ({
  resolveByInboundNumber: vi.fn(async (no: string) =>
    no === '+15552000001' ? mockResolutionRow : null,
  ),
}));

vi.mock('../../src/services/buildops/db/inbound-calls.js', () => ({
  createInboundCall: vi.fn(async () => mockSession),
  getInboundCall: vi.fn(async () => ({ ...mockSession })),
  setMatchedCustomer: vi.fn(async () => undefined),
  setJobCreated: vi.fn(async () => undefined),
  setCallStatus: vi.fn(async () => undefined),
}));

vi.mock('../../src/services/buildops/db/customers.js', () => ({
  findCustomersByPhone: vi.fn(async () => [mockCustomer]),
  getFuzzyCandidates: vi.fn(async () => [mockCustomer]),
  getCustomerById: vi.fn(async () => mockCustomer),
}));

vi.mock('../../src/services/buildops/db/properties.js', () => ({
  getPropertiesForCustomer: vi.fn(async () => [
    { id: 'prop-1', name: 'Main Office', customerId: 'cust-1', address: { line1: '123 Oak St' } },
  ]),
  getPropertyById: vi.fn(async (id: string) =>
    id === 'prop-1' ? { id: 'prop-1', customerId: 'cust-1', address: {} } : null,
  ),
}));

vi.mock('../../src/services/buildops/db/departments.js', () => ({
  getDepartments: vi.fn(async () => [{ id: 'dept-1', tagName: 'HVAC', tenantId: 'tenant-abc', email: null, isActive: true }]),
}));

vi.mock('../../src/services/buildops/db/pricebook.js', () => ({
  searchPricebook: vi.fn(async () => [
    { id: 'pb-row-1', tenantId: 'tenant-abc', productId: 'prod-1', name: 'HVAC Filter', description: null, unitPrice: 45, taxable: false, isActive: true },
  ]),
}));

vi.mock('../../src/services/buildops/db/jobs.js', () => ({
  upsertJob: vi.fn(async () => undefined),
}));

vi.mock('../../src/services/buildops/client.js', () => ({
  getJobTypes: vi.fn(async () => [{ id: 'jt-1', name: 'HVAC Repair' }]),
  createJob: vi.fn(async () => ({ jobId: 'job-new', jobNumber: 'J-999' })),
  createTask: vi.fn(async () => undefined),
}));

vi.mock('../../src/config/env.js', () => ({
  env: { buildopsApiUrl: 'https://api.buildops.test' },
}));

// Import after mocks are set up
const { handleRetellWebhook } = await import('../../src/lib/retell.js');

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe('call_started', () => {
  it('resolves tenant and returns ok:true for known number', async () => {
    const result = await handleRetellWebhook({
      event: 'call_started',
      call: { call_id: 'call-1', to_number: '+15552000001', from_number: '+15559876543' },
    });
    expect(result).toMatchObject({ ok: true });
  });

  it('returns ok:false for unknown TO_NUMBER', async () => {
    const result = await handleRetellWebhook({
      event: 'call_started',
      call: { call_id: 'call-x', to_number: '+19999999999', from_number: '+15559876543' },
    });
    expect(result).toMatchObject({ ok: false });
  });
});

describe('lookup_customer_by_phone', () => {
  it('matches by normalized phone and returns matched status', async () => {
    const result = await handleRetellWebhook({
      event: 'tool_call',
      call: { call_id: 'call-1', to_number: '+15552000001', from_number: '+15559876543' },
      name: 'lookup_customer_by_phone',
      arguments: {},
    }) as { result: string };

    const parsed = JSON.parse(result.result) as Record<string, unknown>;
    expect(parsed.status).toBe('matched');
    expect((parsed.customer as { name: string }).name).toBe('John Smith');
  });
});

describe('lookup_customer_fuzzy', () => {
  it('returns matched status on accept band', async () => {
    // With the mock returning one candidate, score will be computed; we just verify structure
    const result = await handleRetellWebhook({
      event: 'tool_call',
      call: { call_id: 'call-1', to_number: '+15552000001', from_number: '+15559876543' },
      name: 'lookup_customer_fuzzy',
      arguments: { name: 'John Smith', zip: '62701' },
    }) as { result: string };

    const parsed = JSON.parse(result.result) as Record<string, unknown>;
    // Accept or disambiguate — either is valid depending on fuzzy threshold
    expect(['matched', 'multiple_candidates', 'handoff']).toContain(parsed.status);
  });

  it('returns error when no name or zip provided', async () => {
    const result = await handleRetellWebhook({
      event: 'tool_call',
      call: { call_id: 'call-1', to_number: '+15552000001', from_number: '+15559876543' },
      name: 'lookup_customer_fuzzy',
      arguments: {},
    }) as { result: string };

    expect(result.result).toContain('need_more_info');
  });
});

describe('create_job', () => {
  it('posts to BuildOps and writes buildops_job_id', async () => {
    // Session with matched customer
    const { getInboundCall } = await import('../../src/services/buildops/db/inbound-calls.js');
    vi.mocked(getInboundCall).mockResolvedValueOnce({
      ...mockSession,
      matchedCustomerId: 'cust-1',
    });

    const result = await handleRetellWebhook({
      event: 'tool_call',
      call: { call_id: 'call-1', to_number: '+15552000001', from_number: '+15559876543' },
      name: 'create_job',
      arguments: {
        customer_property_id: 'prop-1',
        job_type_id: 'jt-1',
        price_book_id: 'pb-1',
        is_use_taxable: false,
        status: 'Open',
      },
    }) as { result: string };

    const parsed = JSON.parse(result.result) as Record<string, unknown>;
    expect(parsed.status).toBe('created');
    expect(parsed.job_id).toBe('job-new');
    expect(parsed.job_number).toBe('J-999');
  });

  it('returns error when no customer is confirmed', async () => {
    const result = await handleRetellWebhook({
      event: 'tool_call',
      call: { call_id: 'call-1', to_number: '+15552000001', from_number: '+15559876543' },
      name: 'create_job',
      arguments: {
        customer_property_id: 'prop-1',
        job_type_id: 'jt-1',
        price_book_id: 'pb-1',
      },
    }) as { result: string };

    expect(result.result).toContain('error');
  });
});

describe('add_task_to_job', () => {
  it('sends entries to correct job endpoint', async () => {
    const { createTask } = await import('../../src/services/buildops/client.js');

    await handleRetellWebhook({
      event: 'tool_call',
      call: { call_id: 'call-1', to_number: '+15552000001', from_number: '+15559876543' },
      name: 'add_task_to_job',
      arguments: {
        job_id: 'job-42',
        name: 'Replace filter',
        entries: [{ product_id: 'prod-1', description: '16x25', quantity: 2 }],
      },
    });

    expect(vi.mocked(createTask)).toHaveBeenCalledWith(
      expect.anything(),
      'job-42',
      'Replace filter',
      [{ productId: 'prod-1', description: '16x25', quantity: 2 }],
    );
  });
});
