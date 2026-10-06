/**
 * Unit tests for handleSetJobType — the classification step that runs on its own,
 * before create_lead. It resolves the agent's job-type NAME to the tenant's uuid
 * and pins it to the call session; it never writes to HCP.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('../../src/services/housecallpro/db/jobTypes.js', () => ({
  resolveJobTypeUuid: vi.fn(),
}));
vi.mock('../../src/services/housecallpro/db/callsessions.js', () => ({
  setJobType: vi.fn().mockResolvedValue(undefined),
}));

import { handleSetJobType } from '../../src/services/housecallpro/handlers/jobType.js';
import { resolveJobTypeUuid } from '../../src/services/housecallpro/db/jobTypes.js';
import { setJobType } from '../../src/services/housecallpro/db/callsessions.js';
import type { HcpCallSessionRow } from '../../src/services/housecallpro/types.js';

const resolveJobTypeUuidMock = resolveJobTypeUuid as unknown as Mock;
const setJobTypeMock = setJobType as unknown as Mock;

const REPAIR_UUID = 'jbt_a9d450afb2924b17bde05435c2c824dc';

function makeSession(overrides: Partial<HcpCallSessionRow> = {}): HcpCallSessionRow {
  return {
    id: 'row-1',
    sessionId: 'sess-1',
    tenantId: 'tenant-1',
    retellCallId: 'call_1',
    caller: '+13105551212',
    toNumber: '+17076223573',
    leadSourceNumber: null,
    housecallproCustomerId: 'cus_1',
    customerName: 'Jane Doe',
    matchTier: 'phone',
    selectedSlotStart: null,
    selectedSlotEnd: null,
    selectedSlotDisplay: null,
    selectedTechnicianId: null,
    housecallproJobId: null,
    housecallproJobNumber: null,
    housecallproLeadId: null,
    housecallproLeadNumber: null,
    jobTypeUuid: null,
    escalationType: null,
    escalationSummary: null,
    status: 'active',
    serviceAddressMap: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveJobTypeUuidMock.mockResolvedValue(REPAIR_UUID);
});

describe('handleSetJobType', () => {
  it('pins the resolved uuid to the session and echoes only the name', async () => {
    const res = await handleSetJobType(makeSession(), { job_type: 'Repair' });

    expect(resolveJobTypeUuidMock).toHaveBeenCalledWith('tenant-1', 'Repair');
    expect(setJobTypeMock).toHaveBeenCalledWith('sess-1', REPAIR_UUID);

    const result = JSON.parse(res.result);
    expect(result).toEqual({ status: 'set', job_type: 'Repair' });
    // The agent must never see a jbt_ id.
    expect(res.result).not.toContain('jbt_');
  });

  it('tells the agent to carry on when the name is not configured', async () => {
    resolveJobTypeUuidMock.mockResolvedValue(null);

    const res = await handleSetJobType(makeSession(), { job_type: 'Rewiring' });

    expect(setJobTypeMock).not.toHaveBeenCalled();
    const result = JSON.parse(res.result);
    expect(result.status).toBe('unknown_job_type');
    expect(result.message).toContain('create the lead anyway');
  });

  it('errors on a missing job_type without touching the session', async () => {
    const res = await handleSetJobType(makeSession(), {});

    expect(res.result).toBe('error: job_type is required');
    expect(resolveJobTypeUuidMock).not.toHaveBeenCalled();
    expect(setJobTypeMock).not.toHaveBeenCalled();
  });

  it('trims whitespace before resolving', async () => {
    await handleSetJobType(makeSession(), { job_type: '  Install  ' });
    expect(resolveJobTypeUuidMock).toHaveBeenCalledWith('tenant-1', 'Install');
  });
});
