import { describe, it, expect } from 'vitest';
import {
  jaroWinkler,
  normalizePhoneLast10,
  computeMatchSignals,
  assignTier,
  crossValidate,
} from '../../src/services/housecallpro/fuzzy-search.js';
import type { HcpCustomerRow } from '../../src/services/housecallpro/types.js';

function customer(overrides: Partial<HcpCustomerRow> = {}): HcpCustomerRow {
  const first = overrides.firstName ?? 'Matt';
  const last = overrides.lastName ?? 'Sollett';
  return {
    id: 'row-1',
    tenantId: 'tenant-1',
    housecallproCustomerId: 'cus_1',
    firstName: first,
    lastName: last,
    name: [first, last].filter(Boolean).join(' ').trim(),
    companyName: null,
    email: null,
    mobileNumber: '9176179615',
    normalizedMobile: '9176179615',
    allNumbers: ['9176179615'],
    notificationsEnabled: false,
    leadSource: null,
    notes: null,
    tags: [],
    doNotService: null,
    addressIds: ['adr_1'],
    housecallproCreatedAt: null,
    housecallproUpdatedAt: null,
    addresses: [
      { id: 'adr_1', street: '416 N Reese Pl', streetLine2: null, city: 'Burbank', state: 'CA', zip: '91506', country: 'US', formatted: '416 N Reese Pl, Burbank, CA 91506' },
    ],
    ...overrides,
  };
}

describe('jaroWinkler', () => {
  it('returns 1 for identical strings', () => {
    expect(jaroWinkler('matt', 'matt')).toBe(1);
  });
  it('scores near-misses high and unrelated low', () => {
    expect(jaroWinkler('sollett', 'sollet')).toBeGreaterThan(0.9);
    expect(jaroWinkler('sollett', 'zzzzz')).toBeLessThan(0.5);
  });
});

describe('normalizePhoneLast10', () => {
  it('strips formatting and keeps the last 10 digits', () => {
    expect(normalizePhoneLast10('+1 (917) 617-9615')).toBe('9176179615');
    expect(normalizePhoneLast10('917.617.9615')).toBe('9176179615');
  });
});

describe('tier assignment', () => {
  it('phone + address → Tier 1', () => {
    const signals = computeMatchSignals(undefined, '416 N Reese Pl', '9176179615', customer(), {
      customersForName: 1,
      customersForExactPhone: 1,
    });
    expect(signals.phoneExact).toBe(true);
    expect(signals.addressMatch).toBe(true);
    expect(assignTier(signals).tier).toBe(1);
  });

  it('exact name + single customer → Tier 1', () => {
    const signals = computeMatchSignals('Matt Sollett', undefined, undefined, customer(), {
      customersForName: 1,
      customersForExactPhone: 0,
    });
    expect(signals.nameExact).toBe(true);
    expect(assignTier(signals).tier).toBe(1);
  });

  it('unrelated name, no address/phone → Tier 3', () => {
    const signals = computeMatchSignals('Bob Zzz', undefined, undefined, customer(), {
      customersForName: 1,
      customersForExactPhone: 0,
    });
    expect(assignTier(signals).tier).toBe(3);
  });
});

describe('crossValidate', () => {
  it('passes when the address corroborates', () => {
    const signals = computeMatchSignals(undefined, '416 N Reese Pl', '9176179615', customer(), {
      customersForName: 1,
      customersForExactPhone: 1,
    });
    expect(crossValidate(undefined, '416 N Reese Pl', '9176179615', signals).pass).toBe(true);
  });

  it('fails when name and address both mismatch', () => {
    const signals = computeMatchSignals('Bob Zzz', '999 Nowhere Ave', undefined, customer(), {
      customersForName: 1,
      customersForExactPhone: 0,
    });
    const result = crossValidate('Bob Zzz', '999 Nowhere Ave', undefined, signals);
    expect(result.pass).toBe(false);
  });
});
