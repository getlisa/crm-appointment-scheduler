import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createJob,
  createTask,
  getJobTypes,
  getCustomer,
} from '../../src/services/buildops/client.js';
import type { BuildOpsContext, CreateJobInput } from '../../src/services/buildops/types.js';

const ctx: BuildOpsContext = {
  accessToken: 'test-token',
  buildopsTenantId: 'tenant-123',
  apiUrl: 'https://api.buildops.test',
};

function mockFetch(responseBody: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: () => Promise.resolve(responseBody),
    text: () => Promise.resolve(JSON.stringify(responseBody)),
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('createJob', () => {
  it('sends correct headers and body to BuildOps', async () => {
    const fetchMock = mockFetch({ id: 'job-1', jobNumber: 'J-001' });
    vi.stubGlobal('fetch', fetchMock);

    const input: CreateJobInput = {
      customerPropertyId: 'prop-1',
      jobTypeId: 'jt-1',
      priceBookId: 'pb-1',
      customerId: 'cust-1',
      isUseTaxable: true,
      status: 'Open',
    };

    const result = await createJob(ctx, input);

    expect(result).toEqual({ jobId: 'job-1', jobNumber: 'J-001' });

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.buildops.test/v1/jobs');
    expect((options.headers as Record<string, string>)['Authorization']).toBe('Bearer test-token');
    expect((options.headers as Record<string, string>)['tenantId']).toBe('tenant-123');

    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    expect(body.customerPropertyId).toBe('prop-1');
    expect(body.jobTypeId).toBe('jt-1');
    expect(body.priceBookId).toBe('pb-1');
    expect(body.customerId).toBe('cust-1');
    expect(body.isUseTaxable).toBe(true);
    expect(body.status).toBe('Open');
  });

  it('throws on non-2xx response', async () => {
    vi.stubGlobal('fetch', mockFetch({ message: 'Bad request' }, 400));
    await expect(
      createJob(ctx, {
        customerPropertyId: 'p',
        jobTypeId: 'j',
        priceBookId: 'pb',
        customerId: 'c',
        isUseTaxable: false,
        status: 'Open',
      }),
    ).rejects.toThrow('400');
  });
});

describe('createTask', () => {
  it('posts entries array to correct job path', async () => {
    const fetchMock = mockFetch(null, 200);
    vi.stubGlobal('fetch', fetchMock);

    await createTask(ctx, 'job-42', 'Replace filter', [
      { productId: 'prod-1', description: '16x25 filter', quantity: 2 },
    ]);

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.buildops.test/v1/jobs/job-42/tasks');

    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    expect(body.name).toBe('Replace filter');
    expect(Array.isArray(body.entries)).toBe(true);
    expect((body.entries as unknown[])[0]).toMatchObject({ productId: 'prod-1', quantity: 2 });
  });
});

describe('getJobTypes', () => {
  it('returns array from data field', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({ data: [{ id: 'jt-1', name: 'HVAC Repair' }] }),
    );

    const result = await getJobTypes(ctx);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('HVAC Repair');
  });

  it('handles flat array response', async () => {
    vi.stubGlobal('fetch', mockFetch([{ id: 'jt-2', name: 'Plumbing' }]));
    const result = await getJobTypes(ctx);
    expect(result[0].name).toBe('Plumbing');
  });
});

describe('request headers', () => {
  it('always includes Authorization and tenantId', async () => {
    const fetchMock = mockFetch({ addresses: [] });
    vi.stubGlobal('fetch', fetchMock);

    await getCustomer(ctx, 'c-1');

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-token');
    expect(headers['tenantId']).toBe('tenant-123');
  });
});
