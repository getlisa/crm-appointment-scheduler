import { describe, it, expect } from 'vitest';
import {
  jaroWinkler,
  soundex,
  normalizeAddress,
  tokenSetRatio,
  normalizeName,
  scoreCandidates,
  applyThreshold,
} from '../../src/services/buildops/fuzzy-search.js';
import type { CustomerRow, FuzzyQuery } from '../../src/services/buildops/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCustomer(overrides: Partial<CustomerRow> = {}): CustomerRow {
  return {
    id: 'c1',
    tenantId: 't1',
    buildopsCustomerId: 'bc1',
    name: 'John Smith',
    phonePrimary: '5551234567',
    phoneSecondary: null,
    isActive: true,
    addresses: [{ line1: '123 Oak Street', city: 'Springfield', state: 'IL', zip: '62701' }],
    normalizedPhonePrimary: '5551234567',
    normalizedPhoneSecondary: null,
    ...overrides,
  };
}

// ── jaroWinkler ───────────────────────────────────────────────────────────────

describe('jaroWinkler', () => {
  it('returns 1.0 for identical strings', () => {
    expect(jaroWinkler('smith', 'smith')).toBe(1);
  });

  it('returns 0 for empty vs non-empty', () => {
    expect(jaroWinkler('', 'smith')).toBe(0);
    expect(jaroWinkler('smith', '')).toBe(0);
  });

  it('returns high score for near-identical strings', () => {
    expect(jaroWinkler('smyth', 'smith')).toBeGreaterThan(0.8);
  });

  it('returns low score for very different strings', () => {
    expect(jaroWinkler('john', 'xyz')).toBeLessThan(0.5);
  });

  it('gives prefix bonus for matching starts', () => {
    const withPrefix = jaroWinkler('johnso', 'johnson');
    const noPrefix = jaroWinkler('nhosjn', 'johnson');
    expect(withPrefix).toBeGreaterThan(noPrefix);
  });
});

// ── soundex ───────────────────────────────────────────────────────────────────

describe('soundex', () => {
  it('Smith and Smyth encode the same', () => {
    expect(soundex('Smith')).toBe(soundex('Smyth'));
  });

  it('Miller and Miler encode the same', () => {
    expect(soundex('Miller')).toBe(soundex('Miler'));
  });

  it('returns 4-char code', () => {
    expect(soundex('Lee')).toHaveLength(4);
    expect(soundex('A')).toHaveLength(4);
  });

  it('very different names have different codes', () => {
    expect(soundex('Smith')).not.toBe(soundex('Garcia'));
  });
});

// ── normalizeAddress ──────────────────────────────────────────────────────────

describe('normalizeAddress', () => {
  it('expands Street to ST', () => {
    expect(normalizeAddress('123 Oak Street')).toBe('123 OAK ST');
  });

  it('expands Avenue to AVE', () => {
    expect(normalizeAddress('45 Main Avenue')).toBe('45 MAIN AVE');
  });

  it('strips punctuation', () => {
    expect(normalizeAddress('123 Oak St.')).toBe('123 OAK ST');
  });

  it('uppercases', () => {
    expect(normalizeAddress('123 oak st')).toBe('123 OAK ST');
  });
});

// ── tokenSetRatio ─────────────────────────────────────────────────────────────

describe('tokenSetRatio', () => {
  it('returns 1 for identical strings', () => {
    expect(tokenSetRatio('123 oak st', '123 oak st')).toBe(1);
  });

  it('returns high score when one is a subset of the other', () => {
    expect(tokenSetRatio('123 oak', '123 oak street')).toBeGreaterThan(0.6);
  });

  it('returns 0 for completely different tokens', () => {
    expect(tokenSetRatio('abc def', 'xyz qrs')).toBe(0);
  });
});

// ── scoreCandidates + applyThreshold ─────────────────────────────────────────

describe('scoreCandidates', () => {
  it('scores exact name + address as near 1.0', () => {
    const customer = makeCustomer();
    const query: FuzzyQuery = {
      name: 'John Smith',
      address: '123 Oak Street',
      zip: '62701',
    };
    const results = scoreCandidates(query, [customer]);
    // name(0.25+0.10) + address(0.30) + zip(0.10) = 0.75 with current weights
    expect(results[0].score).toBeGreaterThan(0.70);
  });

  it('scores "Smyth" against "Smith" above 0.55 (phonetic bonus)', () => {
    const customer = makeCustomer({ name: 'John Smith' });
    // Only name fields queried → max ≈ lastName(0.25) + firstName(0.10) ≈ 0.35
    const query: FuzzyQuery = { name: 'John Smyth' };
    const results = scoreCandidates(query, [customer]);
    expect(results[0].score).toBeGreaterThan(0.30);
  });

  it('scores "123 Oak" against "123 Oak Street" above 0.20', () => {
    const customer = makeCustomer();
    const query: FuzzyQuery = { name: 'John Smith', address: '123 Oak' };
    const results = scoreCandidates(query, [customer]);
    expect(results[0].score).toBeGreaterThan(0.2);
  });

  it('scores unrelated candidate lower than matching one', () => {
    const match = makeCustomer({ id: 'c1', name: 'John Smith' });
    const noise = makeCustomer({
      id: 'c2',
      name: 'Maria Garcia',
      addresses: [{ line1: '999 Maple Ave', city: 'Chicago', state: 'IL', zip: '60601' }],
    });
    const query: FuzzyQuery = { name: 'John Smith', address: '123 Oak Street', zip: '62701' };
    const results = scoreCandidates(query, [match, noise]);
    expect(results[0].customer.id).toBe('c1');
    expect(results[0].score).toBeGreaterThan(results[1]?.score ?? 0);
  });

  it('returns empty when no candidate scores above 0', () => {
    const customer = makeCustomer({ name: 'John Smith' });
    // No overlap fields at all
    const results = scoreCandidates({}, [customer]);
    expect(results).toHaveLength(0);
  });
});

describe('applyThreshold', () => {
  it('returns handoff when candidates is empty', () => {
    expect(applyThreshold([])).toEqual({ band: 'handoff' });
  });

  it('returns accept when top score >= 0.90 and gap >= 0.10', () => {
    const customer = makeCustomer();
    const scored = [
      { customer, score: 0.95 },
      { customer: makeCustomer({ id: 'c2', name: 'Other Person' }), score: 0.80 },
    ];
    const result = applyThreshold(scored);
    expect(result.band).toBe('accept');
  });

  it('returns disambiguate when top score is 0.75–0.89', () => {
    const c1 = makeCustomer({ id: 'c1' });
    const c2 = makeCustomer({ id: 'c2', name: 'Jane Smith' });
    const scored = [
      { customer: c1, score: 0.82 },
      { customer: c2, score: 0.60 },
    ];
    const result = applyThreshold(scored);
    expect(result.band).toBe('disambiguate');
  });

  it('returns handoff when top score < 0.75', () => {
    const customer = makeCustomer();
    const scored = [{ customer, score: 0.50 }];
    expect(applyThreshold(scored)).toEqual({ band: 'handoff' });
  });

  it('disambiguates when top two are within 0.10 of each other even above 0.90', () => {
    const c1 = makeCustomer({ id: 'c1' });
    const c2 = makeCustomer({ id: 'c2', name: 'Jane Smith' });
    const scored = [
      { customer: c1, score: 0.93 },
      { customer: c2, score: 0.88 },
    ];
    const result = applyThreshold(scored);
    expect(result.band).toBe('disambiguate');
  });
});
