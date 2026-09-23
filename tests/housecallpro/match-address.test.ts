/**
 * Unit tests for handleMatchAddress — covers the "caller names no address"
 * path ("the address on file"), which cannot be scored and must read the saved
 * addresses back instead of returning not_found.
 *
 * All I/O (HCP client, session writes) is mocked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('../../src/services/housecallpro/client.js', () => ({
  createCustomer: vi.fn(),
  createAddress: vi.fn(),
  getCustomerAddresses: vi.fn(),
}));
vi.mock('../../src/services/housecallpro/db/customers.js', () => ({
  upsertCustomer: vi.fn().mockResolvedValue(undefined),
  appendAddressId: vi.fn().mockResolvedValue(undefined),
  getCustomerByHcpId: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../src/services/housecallpro/db/leadSources.js', () => ({
  resolveLeadSource: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../src/services/housecallpro/db/callsessions.js', () => ({
  setMatchedCustomer: vi.fn().mockResolvedValue(undefined),
  setServiceAddressMap: vi.fn().mockResolvedValue(undefined),
}));

import { handleMatchAddress } from '../../src/services/housecallpro/handlers/customer.js';
import { setServiceAddressMap } from '../../src/services/housecallpro/db/callsessions.js';
import type { HcpAddressLite, HcpCallSessionRow, HcpContext } from '../../src/services/housecallpro/types.js';

const setServiceAddressMapMock = setServiceAddressMap as unknown as Mock;
const ctx: HcpContext = { apiKey: 'k', tenantId: 'tenant-1', emailTo: null, ccMail: null };

function lite(id: string, street: string, city: string, state: string, zip: string): HcpAddressLite {
  return {
    id,
    street,
    streetLine2: null,
    city,
    state,
    zip,
    country: 'US',
    formatted: `${street}, ${city}, ${state} ${zip}`,
  };
}

function makeSession(addresses: HcpAddressLite[]): HcpCallSessionRow {
  return {
    id: 'row-1',
    sessionId: 'sess-1',
    tenantId: 'tenant-1',
    retellCallId: 'call_1',
    caller: '+14155201480',
    toNumber: '+17076223573',
    leadSourceNumber: '+17076564397',
    housecallproCustomerId: 'cus_1',
    customerName: 'Clara Subham',
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
    serviceAddressMap: {
      addresses: Object.fromEntries(addresses.map(a => [a.id, a])),
      selectedAddressId: null,
    },
  };
}

const lyngate = lite('adr_1', '5246 Lyngate Ct', 'Burke', 'VA', '22015');
const oak = lite('adr_2', '18 Oak Street', 'Vallejo', 'CA', '94590');

beforeEach(() => vi.clearAllMocks());

describe('handleMatchAddress', () => {
  it('returns the saved addresses when the caller names none', async () => {
    const res = await handleMatchAddress(makeSession([lyngate, oak]), ctx, {
      spoken_address: 'the address on file',
    });

    const parsed = JSON.parse(res.result);
    expect(parsed.status).toBe('options');
    expect(parsed.candidates).toEqual([
      { address_id: 'adr_1', address: '5246 Lyngate Ct, Burke, VA 22015' },
      { address_id: 'adr_2', address: '18 Oak Street, Vallejo, CA 94590' },
    ]);
  });

  it('selects the only saved address when the caller names none', async () => {
    const res = await handleMatchAddress(makeSession([lyngate]), ctx, {
      spoken_address: 'same as last time',
    });

    const parsed = JSON.parse(res.result);
    expect(parsed.status).toBe('matched');
    expect(parsed.address_id).toBe('adr_1');
    expect(setServiceAddressMapMock.mock.calls[0][1].selectedAddressId).toBe('adr_1');
  });

  it('still fuzzy-matches a spoken street', async () => {
    const res = await handleMatchAddress(makeSession([lyngate, oak]), ctx, {
      spoken_address: '5246 Lyngate Court Burke 22015',
    });

    const parsed = JSON.parse(res.result);
    expect(parsed.status).toBe('matched');
    expect(parsed.address_id).toBe('adr_1');
  });
});
