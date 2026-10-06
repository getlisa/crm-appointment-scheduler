/**
 * Unit tests for matchLeadSource — narrows a caller's free-text answer to one of
 * the lead-source names configured on the HCP account, or to nothing.
 *
 * The contract that matters: it never invents a name. HCP rejects the whole
 * POST /leads with 400 "Lead source not found" on an unknown string, so a wrong
 * guess costs the lead, while a null costs only the attribution.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('../../src/services/housecallpro/client.js', () => ({
  listLeadSources: vi.fn(),
}));

import { matchLeadSource, clearLeadSourceCache } from '../../src/services/housecallpro/leadSourceMatch.js';
import { listLeadSources } from '../../src/services/housecallpro/client.js';
import type { HcpContext } from '../../src/services/housecallpro/types.js';

const listLeadSourcesMock = listLeadSources as unknown as Mock;

const ctx: HcpContext = { apiKey: 'k', tenantId: 'tenant-1', emailTo: null, ccMail: null };

/** Pierce Electric's real configured names, trailing space and typo included. */
const PIERCE_NAMES = [
  'referal', 'Van', 'Kevin Meyer', 'PG&E', 'Horse Pals', 'Online', 'Google LS Message',
  'Existing Customer ', 'WECA', 'Repeat Customer', 'Google Local Services Vallejo', 'GLS',
  'Google', 'facebook', 'Tony Nino', 'Vallejo Chamber', 'American Canyon Chamber of Commerce',
  'qmerit', 'Benicia Chamber of Commerce', 'Laura', 'google my business', 'neighbor',
  'website', 'community name recognition', 'buildertrend', 'Referral',
];

beforeEach(() => {
  clearLeadSourceCache();
  vi.clearAllMocks();
  listLeadSourcesMock.mockResolvedValue({
    page: 1,
    page_size: 200,
    total_pages: 1,
    total_items: PIERCE_NAMES.length,
    lead_sources: PIERCE_NAMES.map((name, i) => ({ id: `lsrc_${i}`, name })),
  });
});

describe('matchLeadSource', () => {
  it('returns the name exactly as HCP spells it', async () => {
    await expect(matchLeadSource(ctx, 'facebook')).resolves.toBe('facebook');
    await expect(matchLeadSource(ctx, 'Google')).resolves.toBe('Google');
    await expect(matchLeadSource(ctx, 'qmerit')).resolves.toBe('qmerit');
  });

  it('matches regardless of the caller\'s casing or punctuation', async () => {
    await expect(matchLeadSource(ctx, 'FACEBOOK')).resolves.toBe('facebook');
    await expect(matchLeadSource(ctx, 'pg and e')).resolves.toBe('PG&E');
  });

  it('maps a spoken phrase onto the configured name', async () => {
    await expect(matchLeadSource(ctx, 'I saw your van on the freeway')).resolves.toBe('Van');
    await expect(matchLeadSource(ctx, 'my neighbour used you')).resolves.toBe('neighbor');
    await expect(matchLeadSource(ctx, 'someone referred me')).resolves.toBe('Referral');
    await expect(matchLeadSource(ctx, "you've done work for me before")).resolves.toBe('Repeat Customer');
    await expect(matchLeadSource(ctx, 'found you on google')).resolves.toBe('Google');
    await expect(matchLeadSource(ctx, 'your google business listing')).resolves.toBe('google my business');
  });

  it('returns null rather than guess when nothing fits', async () => {
    await expect(matchLeadSource(ctx, 'the guy who did my panel')).resolves.toBeNull();
    await expect(matchLeadSource(ctx, 'a flyer in the mail')).resolves.toBeNull();
  });

  it('returns null for an empty or missing answer', async () => {
    await expect(matchLeadSource(ctx, '')).resolves.toBeNull();
    await expect(matchLeadSource(ctx, '   ')).resolves.toBeNull();
    await expect(matchLeadSource(ctx, null)).resolves.toBeNull();
    expect(listLeadSourcesMock).not.toHaveBeenCalled();
  });

  it('returns null when the account list cannot be fetched', async () => {
    listLeadSourcesMock.mockRejectedValue(new Error('HCP GET /lead_sources → 500'));
    await expect(matchLeadSource(ctx, 'facebook')).resolves.toBeNull();
  });

  it('fetches the account list once and reuses it', async () => {
    await matchLeadSource(ctx, 'facebook');
    await matchLeadSource(ctx, 'website');
    await matchLeadSource(ctx, 'qmerit');
    expect(listLeadSourcesMock).toHaveBeenCalledTimes(1);
  });

  it('matches a name stored with a trailing space', async () => {
    await expect(matchLeadSource(ctx, 'existing customer')).resolves.toBe('Existing Customer ');
  });

  it('stays null when a phrase is ambiguous across several names', async () => {
    // Three chambers are configured; "chamber" alone cannot pick one.
    await expect(matchLeadSource(ctx, 'the chamber of commerce')).resolves.toBeNull();
  });
});
