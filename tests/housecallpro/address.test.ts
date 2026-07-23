import { describe, it, expect } from 'vitest';
import { toAddressLite, scoreAddress, formatAddress } from '../../src/services/housecallpro/address.js';

describe('formatAddress / toAddressLite', () => {
  it('formats an HCP address into "street, city, state zip"', () => {
    const lite = toAddressLite({
      id: 'adr_1',
      street: '416 N Reese Pl',
      street_line_2: null,
      city: 'Burbank',
      state: 'CA',
      zip: '91506',
      country: 'US',
    });
    expect(lite.id).toBe('adr_1');
    expect(lite.formatted).toBe('416 N Reese Pl, Burbank, CA 91506');
  });

  it('includes street_line_2 when present', () => {
    expect(
      formatAddress({ street: '123 Main St', street_line_2: 'Apt 4B', city: 'San Diego', state: 'CA', zip: '92101' }),
    ).toBe('123 Main St, Apt 4B, San Diego, CA 92101');
  });
});

describe('scoreAddress', () => {
  const lite = toAddressLite({
    id: 'adr_1',
    street: '416 N Reese Pl',
    city: 'Burbank',
    state: 'CA',
    zip: '91506',
  });

  it('scores a matching spoken address above the confident threshold', () => {
    expect(scoreAddress('416 North Reese Place, Burbank', lite)).toBeGreaterThan(0.6);
  });

  it('scores an unrelated address below the threshold', () => {
    expect(scoreAddress('999 Nowhere Avenue, Springfield', lite)).toBeLessThan(0.6);
  });
});
