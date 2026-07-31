/**
 * Unit tests for handleBookJob — asserts the unscheduled "new job" contract:
 * the POST /jobs body has no `schedule` and no `line_items`, the issue +
 * requested window live in `notes`, and `lead_source` is resolved from the
 * dialed tracking line (falling back to 'Clara').
 *
 * All I/O (HCP client, db writes, lead-source lookup, email) is mocked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';

// ── Mocks (paths resolve to the same modules handleBookJob imports) ───────────
vi.mock('../../src/services/housecallpro/client.js', () => ({
  createJob: vi.fn(),
}));
vi.mock('../../src/services/housecallpro/db/jobs.js', () => ({
  insertJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/services/housecallpro/db/customers.js', () => ({
  getCustomerByHcpId: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../src/services/housecallpro/db/leadSources.js', () => ({
  resolveLeadSource: vi.fn(),
}));
vi.mock('../../src/services/housecallpro/db/callsessions.js', () => ({
  setJobCreated: vi.fn().mockResolvedValue(undefined),
  setSelectedSlot: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/services/housecallpro/emailNotificationService.js', () => ({
  sendHcpNotification: vi.fn().mockResolvedValue({ sent: false }),
}));

import { handleBookJob } from '../../src/services/housecallpro/handlers/job.js';
import { createJob } from '../../src/services/housecallpro/client.js';
import { insertJob } from '../../src/services/housecallpro/db/jobs.js';
import { resolveLeadSource } from '../../src/services/housecallpro/db/leadSources.js';
import type { HcpCallSessionRow, HcpContext, HcpCreateJobInput } from '../../src/services/housecallpro/types.js';

const createJobMock = createJob as unknown as Mock;
const insertJobMock = insertJob as unknown as Mock;
const resolveLeadSourceMock = resolveLeadSource as unknown as Mock;

const ctx: HcpContext = { apiKey: 'k', tenantId: 'tenant-1', emailTo: null, ccMail: null };

function makeSession(overrides: Partial<HcpCallSessionRow> = {}): HcpCallSessionRow {
  return {
    id: 'row-1',
    sessionId: 'sess-1',
    tenantId: 'tenant-1',
    retellCallId: 'call_1',
    caller: '+13105551212',
    toNumber: '+17476771558',
    housecallproCustomerId: 'cus_1',
    customerName: 'Jane Doe',
    matchTier: 'phone',
    selectedSlotStart: null,
    selectedSlotEnd: null,
    selectedSlotDisplay: null,
    selectedTechnicianId: null,
    housecallproJobId: null,
    housecallproJobNumber: null,
    escalationType: null,
    escalationSummary: null,
    status: 'active',
    serviceAddressMap: { addresses: {}, selectedAddressId: 'adr_1' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  createJobMock.mockResolvedValue({ id: 'job_1', invoice_number: '1042', work_status: 'new job' });
  resolveLeadSourceMock.mockResolvedValue(null);
});

describe('handleBookJob — unscheduled new job', () => {
  it('sends no schedule and no line_items, and puts issue + window in notes', async () => {
    resolveLeadSourceMock.mockResolvedValue({ leadSourceId: 'ls_1', leadName: 'Google LSA' });

    const res = await handleBookJob(makeSession(), ctx, {
      service_name: 'AC not cooling',
      scheduled_start: '2026-07-24T14:00:00',
      scheduled_end: '2026-07-24T16:00:00',
    });

    expect(createJobMock).toHaveBeenCalledTimes(1);
    const body = createJobMock.mock.calls[0][1] as HcpCreateJobInput;

    expect(body.schedule).toBeUndefined();
    expect(body.line_items).toBeUndefined();
    expect(body.customer_id).toBe('cus_1');
    expect(body.address_id).toBe('adr_1');
    expect(body.notes).toBe(
      'Issue Description :- AC not cooling\nJob between 2026-07-24T14:00:00 to 2026-07-24T16:00:00',
    );

    const result = JSON.parse(res.result);
    expect(result.status).toBe('created');
    expect(result.work_status).toBe('new job');
    expect(result.scheduled).toBe(false);
    expect(result.scheduled_start).toBeUndefined();
  });

  it('resolves lead_source from the dialed line', async () => {
    resolveLeadSourceMock.mockResolvedValue({ leadSourceId: 'ls_1', leadName: 'Google LSA' });

    await handleBookJob(makeSession(), ctx, { service_name: 'AC not cooling' });

    expect(resolveLeadSourceMock).toHaveBeenCalledWith('+17476771558');
    const body = createJobMock.mock.calls[0][1] as HcpCreateJobInput;
    expect(body.lead_source).toBe('Google LSA');
  });

  it('falls back to Clara when the line has no lead-source mapping', async () => {
    resolveLeadSourceMock.mockResolvedValue(null);

    await handleBookJob(makeSession(), ctx, { service_name: 'AC not cooling' });

    const body = createJobMock.mock.calls[0][1] as HcpCreateJobInput;
    expect(body.lead_source).toBe('Clara');
  });

  it('omits the "Job between" line when no requested window is given', async () => {
    await handleBookJob(makeSession(), ctx, { service_name: 'AC not cooling' });
    const body = createJobMock.mock.calls[0][1] as HcpCreateJobInput;
    expect(body.notes).toBe('Issue Description :- AC not cooling');
  });

  it('persists the job with null line_items and the requested window kept internally', async () => {
    await handleBookJob(makeSession(), ctx, {
      service_name: 'AC not cooling',
      scheduled_start: '2026-07-24T14:00:00',
      scheduled_end: '2026-07-24T16:00:00',
    });

    expect(insertJobMock).toHaveBeenCalledTimes(1);
    const persisted = insertJobMock.mock.calls[0][1];
    expect(persisted.lineItems).toBeNull();
    expect(persisted.arrivalWindow).toBeNull();
    expect(persisted.scheduledStart).toBe('2026-07-24T14:00:00');
    expect(persisted.scheduledEnd).toBe('2026-07-24T16:00:00');
  });

  it('errors when no address is selected', async () => {
    const res = await handleBookJob(
      makeSession({ serviceAddressMap: { addresses: {}, selectedAddressId: null } }),
      ctx,
      { service_name: 'AC not cooling' },
    );
    expect(res.result).toContain('no address selected');
    expect(createJobMock).not.toHaveBeenCalled();
  });
});
