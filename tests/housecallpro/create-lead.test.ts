/**
 * Unit tests for handleCreateLead — asserts the lead-only contract for Pierce:
 * the POST /leads body carries the pinned customer, the issue + requested
 * timeframe in the SINGULAR `note` field, a top-level `job_type_uuid` resolved
 * from the job-type table, and a lead_source that prefers the caller's spoken
 * answer over the dialed tracking line.
 *
 * All I/O (HCP client, db writes, job-type + lead-source lookup, email) is mocked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';

// ── Mocks (paths resolve to the same modules handleCreateLead imports) ────────
vi.mock('../../src/services/housecallpro/client.js', () => ({
  createLead: vi.fn(),
}));
vi.mock('../../src/services/housecallpro/db/leads.js', () => ({
  insertLead: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/services/housecallpro/db/customers.js', () => ({
  getCustomerByHcpId: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../src/services/housecallpro/db/jobTypes.js', () => ({
  resolveJobTypeUuid: vi.fn(),
  resolveJobTypeName: vi.fn(),
}));
vi.mock('../../src/services/housecallpro/db/leadSources.js', () => ({
  resolveLeadSource: vi.fn(),
}));
vi.mock('../../src/services/housecallpro/db/callsessions.js', () => ({
  setLeadCreated: vi.fn().mockResolvedValue(undefined),
  setSelectedSlot: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/services/housecallpro/emailNotificationService.js', () => ({
  sendHcpNotification: vi.fn().mockResolvedValue({ sent: false }),
}));

import { handleCreateLead } from '../../src/services/housecallpro/handlers/lead.js';
import { createLead } from '../../src/services/housecallpro/client.js';
import { insertLead } from '../../src/services/housecallpro/db/leads.js';
import { resolveJobTypeUuid, resolveJobTypeName } from '../../src/services/housecallpro/db/jobTypes.js';
import { resolveLeadSource } from '../../src/services/housecallpro/db/leadSources.js';
import { setLeadCreated } from '../../src/services/housecallpro/db/callsessions.js';
import { sendHcpNotification } from '../../src/services/housecallpro/emailNotificationService.js';
import type {
  HcpCallSessionRow,
  HcpContext,
  HcpCreateLeadInput,
} from '../../src/services/housecallpro/types.js';

const createLeadMock = createLead as unknown as Mock;
const insertLeadMock = insertLead as unknown as Mock;
const resolveJobTypeUuidMock = resolveJobTypeUuid as unknown as Mock;
const resolveJobTypeNameMock = resolveJobTypeName as unknown as Mock;
const resolveLeadSourceMock = resolveLeadSource as unknown as Mock;
const setLeadCreatedMock = setLeadCreated as unknown as Mock;
const sendHcpNotificationMock = sendHcpNotification as unknown as Mock;

const REPAIR_UUID = 'jbt_a9d450afb2924b17bde05435c2c824dc';

const ctx: HcpContext = { apiKey: 'k', tenantId: 'tenant-1', emailTo: null, ccMail: null };

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
    serviceAddressMap: { addresses: {}, selectedAddressId: 'adr_1' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  createLeadMock.mockResolvedValue({ id: 'lea_1', number: 136 });
  resolveJobTypeUuidMock.mockResolvedValue(null);
  resolveJobTypeNameMock.mockResolvedValue(null);
  resolveLeadSourceMock.mockResolvedValue(null);
});

describe('handleCreateLead — lead-only intake', () => {
  it('sends the pinned customer and address, with issue + timeframe in the singular note', async () => {
    const res = await handleCreateLead(makeSession(), ctx, {
      service_type: 'Outlet Repair',
      issue: 'Two outlets in the kitchen stopped working',
      scheduled_start: '2026-07-24T14:00:00',
      scheduled_end: '2026-07-24T16:00:00',
    });

    expect(createLeadMock).toHaveBeenCalledTimes(1);
    const body = createLeadMock.mock.calls[0][1] as HcpCreateLeadInput;

    expect(body.customer_id).toBe('cus_1');
    expect(body.address_id).toBe('adr_1');
    expect(body.note).toBe(
      'Service :- Outlet Repair\n' +
        'Issue Description :- Two outlets in the kitchen stopped working\n' +
        'Request logged for July 24, 2026 in the afternoon',
    );
    // `notes` (plural) is silently dropped by HCP — it must never be used.
    expect('notes' in body).toBe(false);
    expect(body.tags).toEqual(['Clara']);

    const result = JSON.parse(res.result);
    expect(result).toEqual({ status: 'created', lead_id: 'lea_1', lead_number: 136, scheduled: false });
  });

  it('takes the job type off the session, at the top level, never under job_fields', async () => {
    await handleCreateLead(makeSession({ jobTypeUuid: REPAIR_UUID }), ctx, {
      service_type: 'Outlet Repair',
      issue: 'No power to the kitchen outlets',
    });

    const body = createLeadMock.mock.calls[0][1] as HcpCreateLeadInput;
    expect(body.job_type_uuid).toBe(REPAIR_UUID);
    expect('job_fields' in body).toBe(false);
    // set_job_type already resolved it — no second lookup.
    expect(resolveJobTypeUuidMock).not.toHaveBeenCalled();
  });

  it('falls back to a job_type argument when set_job_type was skipped', async () => {
    resolveJobTypeUuidMock.mockResolvedValue(REPAIR_UUID);

    await handleCreateLead(makeSession(), ctx, {
      issue: 'No power to the kitchen outlets',
      job_type: 'Repair',
    });

    expect(resolveJobTypeUuidMock).toHaveBeenCalledWith('tenant-1', 'Repair');
    const body = createLeadMock.mock.calls[0][1] as HcpCreateLeadInput;
    expect(body.job_type_uuid).toBe(REPAIR_UUID);
  });

  it('still creates the lead when no job type was ever set', async () => {
    const res = await handleCreateLead(makeSession(), ctx, {
      issue: 'Wants a quote for rewiring the garage',
    });

    const body = createLeadMock.mock.calls[0][1] as HcpCreateLeadInput;
    expect('job_type_uuid' in body).toBe(false);
    expect(JSON.parse(res.result).status).toBe('created');
  });

  it('does not let a job_type argument leak into the Issue Description', async () => {
    resolveJobTypeUuidMock.mockResolvedValue(REPAIR_UUID);

    // No issue / service_name / reason given — book_job would fall back to
    // job_type here, but for a lead that value is a classification, not words.
    await handleCreateLead(makeSession(), ctx, { job_type: 'Repair' });

    const body = createLeadMock.mock.calls[0][1] as HcpCreateLeadInput;
    expect(body.note).toBe('Issue Description :- Service request');
  });

  it('omits service_type from the note when the agent could not label the work', async () => {
    await handleCreateLead(makeSession({ jobTypeUuid: REPAIR_UUID }), ctx, {
      issue: 'Something is buzzing behind the wall',
    });

    const body = createLeadMock.mock.calls[0][1] as HcpCreateLeadInput;
    expect(body.note).toBe('Issue Description :- Something is buzzing behind the wall');
  });

  it('stamps Clara as the source when the caller was asked, keeping their words on the note', async () => {
    resolveLeadSourceMock.mockResolvedValue(null); // tracking line maps to nothing

    await handleCreateLead(makeSession(), ctx, {
      service_type: 'Electrical Repair',
      issue: 'Breaker keeps tripping',
      lead_source: 'my neighbour used you last year',
    });

    const body = createLeadMock.mock.calls[0][1] as HcpCreateLeadInput;
    // The answer is free text and cannot be trusted as an HCP name.
    expect(body.lead_source).toBe('Clara');
    expect(body.note).toContain('Heard about us :- my neighbour used you last year');
  });

  it('lets the dialed tracking line beat whatever the caller said', async () => {
    resolveLeadSourceMock.mockResolvedValue({
      leadSourceId: 'lsrc_7b2',
      leadName: 'Google Local Services Vallejo',
    });

    await handleCreateLead(makeSession({ leadSourceNumber: '+17075134910' }), ctx, {
      issue: 'Breaker keeps tripping',
      lead_source: 'I saw your van',
    });

    const body = createLeadMock.mock.calls[0][1] as HcpCreateLeadInput;
    expect(body.lead_source).toBe('Google Local Services Vallejo');
    // It is still recorded, because the two disagreeing is worth seeing.
    expect(body.note).toContain('Heard about us :- I saw your van');
  });

  it('sends no lead_source at all when the line is unmapped and nobody was asked', async () => {
    resolveLeadSourceMock.mockResolvedValue(null);

    const res = await handleCreateLead(makeSession(), ctx, { issue: 'Breaker keeps tripping' });

    const body = createLeadMock.mock.calls[0][1] as HcpCreateLeadInput;
    expect('lead_source' in body).toBe(false);
    expect(body.note).not.toContain('Heard about us');
    expect(JSON.parse(res.result).status).toBe('created');
  });

  it('falls back to the dialed tracking line when the caller was not asked', async () => {
    resolveLeadSourceMock.mockResolvedValue({
      leadSourceId: 'lsrc_7b2',
      leadName: 'Google Local Services Vallejo',
    });

    await handleCreateLead(makeSession({ leadSourceNumber: '+17075134910' }), ctx, {
      service_type: 'Electrical Repair',
      issue: 'Breaker keeps tripping',
    });

    expect(resolveLeadSourceMock).toHaveBeenCalledWith('+17075134910');
    const body = createLeadMock.mock.calls[0][1] as HcpCreateLeadInput;
    expect(body.lead_source).toBe('Google Local Services Vallejo');
  });

  it('never sends the lsrc_ id in the lead_source name field', async () => {
    resolveLeadSourceMock.mockResolvedValue({ leadSourceId: 'lsrc_abc', leadName: null });

    await handleCreateLead(makeSession(), ctx, {
      service_type: 'Electrical Repair',
      issue: 'Breaker keeps tripping',
    });

    const body = createLeadMock.mock.calls[0][1] as HcpCreateLeadInput;
    expect('lead_source' in body).toBe(false);
  });

  it('retries without lead_source when HCP rejects the name', async () => {
    resolveLeadSourceMock.mockResolvedValue({ leadSourceId: 'ls_1', leadName: 'google my business' });
    createLeadMock
      .mockRejectedValueOnce(
        new Error('HCP POST /leads → 400: {"error":{"message":"Lead source not found"}}'),
      )
      .mockResolvedValueOnce({ id: 'lea_2', number: 137 });

    const res = await handleCreateLead(makeSession(), ctx, {
      service_type: 'Electrical Repair',
      issue: 'Breaker keeps tripping',
    });

    expect(createLeadMock).toHaveBeenCalledTimes(2);
    const retryBody = createLeadMock.mock.calls[1][1] as HcpCreateLeadInput;
    expect('lead_source' in retryBody).toBe(false);
    expect(JSON.parse(res.result).status).toBe('created');
  });

  it('does not retry when the failure is unrelated to the lead source', async () => {
    resolveLeadSourceMock.mockResolvedValue({ leadSourceId: 'ls_1', leadName: 'Google' });
    createLeadMock.mockRejectedValueOnce(new Error('HCP POST /leads → 500: boom'));

    const res = await handleCreateLead(makeSession(), ctx, {
      service_type: 'Electrical Repair',
      issue: 'Breaker keeps tripping',
    });

    expect(createLeadMock).toHaveBeenCalledTimes(1);
    expect(res.result).toContain('lead creation failed');
  });

  it('persists the lead and records it on the session, keeping the window locally', async () => {
    await handleCreateLead(makeSession({ jobTypeUuid: REPAIR_UUID }), ctx, {
      service_type: 'Outlet Repair',
      issue: 'No power to the kitchen outlets',
      scheduled_start: '2026-07-24T09:00:00',
      scheduled_end: '2026-07-24T12:00:00',
    });

    expect(insertLeadMock).toHaveBeenCalledTimes(1);
    const persisted = insertLeadMock.mock.calls[0][1];
    expect(persisted.housecallproLeadId).toBe('lea_1');
    expect(persisted.leadNumber).toBe(136);
    expect(persisted.jobTypeUuid).toBe(REPAIR_UUID);
    expect(persisted.requestedStart).toBe('2026-07-24T09:00:00');
    expect(persisted.requestedEnd).toBe('2026-07-24T12:00:00');

    expect(setLeadCreatedMock).toHaveBeenCalledWith('sess-1', 'lea_1', 136, REPAIR_UUID);
  });

  it('sends the lead_created email with the job-type name, not job_booked', async () => {
    resolveJobTypeNameMock.mockResolvedValue('Repair');

    await handleCreateLead(makeSession({ jobTypeUuid: REPAIR_UUID }), ctx, {
      service_type: 'Outlet Repair',
      issue: 'No power to the kitchen outlets',
    });

    expect(sendHcpNotificationMock).toHaveBeenCalledTimes(1);
    const sent = sendHcpNotificationMock.mock.calls[0][0];
    expect(sent.kind).toBe('lead_created');
    expect(sent.details.jobType).toBe('Repair');
    expect(sent.details.leadNumber).toBe(136);
  });

  it('errors when no customer is identified', async () => {
    const res = await handleCreateLead(makeSession({ housecallproCustomerId: null }), ctx, {
      service_type: 'Electrical Repair',
      issue: 'Breaker keeps tripping',
    });

    expect(res.result).toContain('no customer identified');
    expect(createLeadMock).not.toHaveBeenCalled();
  });

  it('errors when no address is selected', async () => {
    const res = await handleCreateLead(
      makeSession({ serviceAddressMap: { addresses: {}, selectedAddressId: null } }),
      ctx,
      { service_type: 'Electrical Repair', issue: 'Breaker keeps tripping' },
    );

    expect(res.result).toContain('no address selected');
    expect(createLeadMock).not.toHaveBeenCalled();
  });
});
