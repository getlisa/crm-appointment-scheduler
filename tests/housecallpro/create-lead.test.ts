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
  createAddress: vi.fn(),
  listLeadSources: vi.fn(),
}));
vi.mock('../../src/services/housecallpro/db/leads.js', () => ({
  insertLead: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/services/housecallpro/db/customers.js', () => ({
  getCustomerByHcpId: vi.fn().mockResolvedValue(null),
  upsertCustomer: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../src/services/housecallpro/db/jobTypes.js', () => ({
  resolveJobTypeUuid: vi.fn(),
  resolveJobTypeName: vi.fn(),
}));
vi.mock('../../src/services/housecallpro/db/callsessions.js', () => ({
  setLeadCreated: vi.fn().mockResolvedValue(undefined),
  setMatchedCustomer: vi.fn().mockResolvedValue(undefined),
  setSelectedSlot: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/services/housecallpro/emailNotificationService.js', () => ({
  sendHcpNotification: vi.fn().mockResolvedValue({ sent: false }),
}));

import { handleCreateLead, clearLeadSourceCache } from '../../src/services/housecallpro/handlers/lead.js';
import { createLead, createAddress, listLeadSources } from '../../src/services/housecallpro/client.js';
import { insertLead } from '../../src/services/housecallpro/db/leads.js';
import { resolveJobTypeUuid, resolveJobTypeName } from '../../src/services/housecallpro/db/jobTypes.js';
import { setLeadCreated, setMatchedCustomer } from '../../src/services/housecallpro/db/callsessions.js';
import { upsertCustomer } from '../../src/services/housecallpro/db/customers.js';
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
const setLeadCreatedMock = setLeadCreated as unknown as Mock;
const setMatchedCustomerMock = setMatchedCustomer as unknown as Mock;
const upsertCustomerMock = upsertCustomer as unknown as Mock;
const createAddressMock = createAddress as unknown as Mock;
const listLeadSourcesMock = listLeadSources as unknown as Mock;
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
    leadSourceName: null,
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
  clearLeadSourceCache();
  listLeadSourcesMock.mockResolvedValue({
    lead_sources: [
      { id: 'lsrc_1', name: 'Google' },
      { id: 'lsrc_2', name: 'PG&E' },
      { id: 'lsrc_3', name: 'Google Local Services Vallejo' },
    ],
  });
  createLeadMock.mockResolvedValue({ id: 'lea_1', number: 136 });
  createAddressMock.mockResolvedValue({ id: 'adr_new' });
  resolveJobTypeUuidMock.mockResolvedValue(null);
  resolveJobTypeNameMock.mockResolvedValue(null);
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

  it('uses the caller\'s answer when it names a configured source', async () => {
    // call_69ba94bf: the caller said "Google", which Pierce has configured, and
    // the lead was still created with no attribution at all.
    await handleCreateLead(makeSession({ leadSourceName: null }), ctx, {
      issue: 'Wiring inspection',
      lead_source: 'Google',
    });

    const body = createLeadMock.mock.calls[0][1] as HcpCreateLeadInput;
    expect(body.lead_source).toBe('Google');
    expect(body.note).toContain('Heard about us :- Google');
  });

  it('matches a configured name regardless of casing and punctuation', async () => {
    await handleCreateLead(makeSession({ leadSourceName: null }), ctx, {
      issue: 'No power',
      lead_source: 'pg and e',
    });

    expect((createLeadMock.mock.calls[0][1] as HcpCreateLeadInput).lead_source).toBe('PG&E');
  });

  it('does not consult the account list when the tracking line already resolved', async () => {
    await handleCreateLead(makeSession({ leadSourceName: 'Google Local Services Vallejo' }), ctx, {
      issue: 'No power',
      lead_source: 'Google',
    });

    expect(listLeadSourcesMock).not.toHaveBeenCalled();
    expect((createLeadMock.mock.calls[0][1] as HcpCreateLeadInput).lead_source)
      .toBe('Google Local Services Vallejo');
  });

  it('stamps Clara when the dialed line maps to nothing, keeping the words on the note', async () => {
    await handleCreateLead(makeSession({ leadSourceName: null }), ctx, {
      service_type: 'Electrical Repair',
      issue: 'Breaker keeps tripping',
      lead_source: 'my neighbour used you last year',
    });

    const body = createLeadMock.mock.calls[0][1] as HcpCreateLeadInput;
    // Names no configured source, so it cannot be sent as one.
    expect(body.lead_source).toBe('Clara');
    expect(body.note).toContain('Heard about us :- my neighbour used you last year');
  });

  it('lets the dialed tracking line beat whatever the caller said', async () => {
    await handleCreateLead(makeSession({ leadSourceName: 'Google Local Services Vallejo' }), ctx, {
      issue: 'Breaker keeps tripping',
      lead_source: 'I saw your van',
    });

    const body = createLeadMock.mock.calls[0][1] as HcpCreateLeadInput;
    expect(body.lead_source).toBe('Google Local Services Vallejo');
    // It is still recorded, because the two disagreeing is worth seeing.
    expect(body.note).toContain('Heard about us :- I saw your van');
  });

  it('still stamps Clara when the line is unmapped and nobody was asked', async () => {
    const res = await handleCreateLead(makeSession({ leadSourceName: null }), ctx, {
      issue: 'Breaker keeps tripping',
    });

    const body = createLeadMock.mock.calls[0][1] as HcpCreateLeadInput;
    expect(body.lead_source).toBe('Clara');
    expect(body.note).not.toContain('Heard about us');
    expect(JSON.parse(res.result).status).toBe('created');
  });

  it('uses the session lead source when the caller was never asked', async () => {
    await handleCreateLead(makeSession({ leadSourceName: 'Google Local Services Vallejo' }), ctx, {
      service_type: 'Electrical Repair',
      issue: 'Breaker keeps tripping',
    });

    const body = createLeadMock.mock.calls[0][1] as HcpCreateLeadInput;
    expect(body.lead_source).toBe('Google Local Services Vallejo');
    expect(body.note).not.toContain('Heard about us');
  });

  it('never sends an lsrc_ id in the lead_source name field', async () => {
    await handleCreateLead(makeSession({ leadSourceName: null }), ctx, {
      service_type: 'Electrical Repair',
      issue: 'Breaker keeps tripping',
    });

    const body = createLeadMock.mock.calls[0][1] as HcpCreateLeadInput;
    expect(body.lead_source).toBe('Clara');
    expect(body.lead_source).not.toMatch(/^lsrc_/);
  });

  it('retries without lead_source when HCP rejects the name', async () => {
    createLeadMock
      .mockRejectedValueOnce(
        new Error('HCP POST /leads → 400: {"error":{"message":"Lead source not found"}}'),
      )
      .mockResolvedValueOnce({ id: 'lea_2', number: 137 });

    const res = await handleCreateLead(makeSession({ leadSourceName: 'google my business' }), ctx, {
      service_type: 'Electrical Repair',
      issue: 'Breaker keeps tripping',
    });

    expect(createLeadMock).toHaveBeenCalledTimes(2);
    const retryBody = createLeadMock.mock.calls[1][1] as HcpCreateLeadInput;
    expect('lead_source' in retryBody).toBe(false);
    expect(JSON.parse(res.result).status).toBe('created');
  });

  it('does not retry when the failure is unrelated to the lead source', async () => {
    createLeadMock.mockRejectedValueOnce(new Error('HCP POST /leads → 500: boom'));

    const res = await handleCreateLead(makeSession({ leadSourceName: 'Google' }), ctx, {
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

  it('errors when there is neither an identified customer nor a name', async () => {
    const res = await handleCreateLead(makeSession({ housecallproCustomerId: null }), ctx, {
      service_type: 'Electrical Repair',
      issue: 'Breaker keeps tripping',
    });

    expect(res.result).toContain('no customer');
    expect(createLeadMock).not.toHaveBeenCalled();
  });

  it('errors when a new caller has a name but no address parts', async () => {
    const res = await handleCreateLead(
      makeSession({ housecallproCustomerId: null, serviceAddressMap: null }),
      ctx,
      { issue: 'Breaker keeps tripping', first_name: 'Dana', last_name: 'Reed' },
    );

    expect(res.result).toContain('pass street, city, state and zip');
    expect(createLeadMock).not.toHaveBeenCalled();
  });

  it('creates the customer inline for a new caller and saves their address', async () => {
    createLeadMock.mockResolvedValue({
      id: 'lea_9',
      number: 140,
      customer: { id: 'cus_new', first_name: 'Dana', last_name: 'Reed' },
    });

    const res = await handleCreateLead(
      makeSession({ housecallproCustomerId: null, serviceAddressMap: null }),
      ctx,
      {
        issue: 'No power to the garage',
        first_name: 'Dana',
        last_name: 'Reed',
        email: 'dana at example dot com',
        street: '18 Oak Street',
        city: 'Vallejo',
        state: 'CA',
        zip: '94590',
      },
    );

    const body = createLeadMock.mock.calls[0][1] as HcpCreateLeadInput;
    expect('customer_id' in body).toBe(false);
    // The spoken form is normalised before it reaches HCP.
    expect(body.customer).toMatchObject({ first_name: 'Dana', last_name: 'Reed', email: 'dana@example.com' });
    // Falls back to the number they are calling from.
    expect(body.customer?.mobile_number).toBe('+13105551212');
    expect(body.address).toEqual({ street: '18 Oak Street', city: 'Vallejo', state: 'CA', zip: '94590' });

    // The inline address is text on the lead only, so a real one is created after.
    // country is mandatory — HCP 422s "Country is required" without it.
    expect(createAddressMock).toHaveBeenCalledWith(ctx, 'cus_new', {
      street: '18 Oak Street',
      city: 'Vallejo',
      state: 'CA',
      zip: '94590',
      country: 'US',
    });
    // ...and the caller must be cached, or customer_lookup misses them next time.
    expect(upsertCustomerMock).toHaveBeenCalledWith('tenant-1', expect.objectContaining({ id: 'cus_new' }));
    expect(setMatchedCustomerMock).toHaveBeenCalledWith('sess-1', 'cus_new', 'Dana Reed', 'new_customer');

    const persisted = insertLeadMock.mock.calls[0][1];
    expect(persisted.housecallproCustomerId).toBe('cus_new');
    expect(persisted.addressId).toBe('adr_new');
    expect(JSON.parse(res.result).status).toBe('created');
  });

  it('still logs the lead when saving the new address fails', async () => {
    createLeadMock.mockResolvedValue({
      id: 'lea_9',
      number: 140,
      customer: { id: 'cus_new', first_name: 'Dana', last_name: 'Reed' },
    });
    createAddressMock.mockRejectedValue(new Error('HCP POST /customers/cus_new/addresses → 500'));

    const res = await handleCreateLead(
      makeSession({ housecallproCustomerId: null, serviceAddressMap: null }),
      ctx,
      {
        issue: 'No power to the garage',
        first_name: 'Dana',
        last_name: 'Reed',
        street: '18 Oak Street',
        city: 'Vallejo',
        state: 'CA',
        zip: '94590',
      },
    );

    expect(JSON.parse(res.result).status).toBe('created');
    expect(insertLeadMock.mock.calls[0][1].addressId).toBeNull();
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
