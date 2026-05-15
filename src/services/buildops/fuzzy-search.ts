/**
 * Customer identification algorithms for the BuildOps integration.
 * Implements Jaro-Winkler string similarity, Soundex phonetic encoding,
 * USPS address normalization, and token-set ratio (Jaccard) matching.
 * Exports scoreCandidates() for weighted multi-field scoring, applyThreshold()
 * for accept/disambiguate/handoff band assignment, and computeMatchSignals() +
 * assignTier() + crossValidate() for confidence tier determination.
 */

import type { CustomerRow, PropertyRow, FuzzyQuery, ScoredCandidate, LookupDecision } from './types.js';

// ── Jaro-Winkler ──────────────────────────────────────────────────────────────

function jaro(s1: string, s2: string): number {
  if (s1 === s2) return 1;
  const len1 = s1.length;
  const len2 = s2.length;
  if (len1 === 0 || len2 === 0) return 0;

  const matchDist = Math.max(Math.floor(Math.max(len1, len2) / 2) - 1, 0);
  const s1Matches = new Array<boolean>(len1).fill(false);
  const s2Matches = new Array<boolean>(len2).fill(false);

  let matches = 0;
  let transpositions = 0;

  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchDist);
    const end = Math.min(i + matchDist + 1, len2);
    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0;

  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  return (matches / len1 + matches / len2 + (matches - transpositions / 2) / matches) / 3;
}

export function jaroWinkler(s1: string, s2: string): number {
  const jaroScore = jaro(s1, s2);
  if (jaroScore < 0.7) return jaroScore;

  let prefix = 0;
  const maxPrefix = Math.min(4, Math.min(s1.length, s2.length));
  for (let i = 0; i < maxPrefix; i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }

  return jaroScore + prefix * 0.1 * (1 - jaroScore);
}

// ── Soundex (phonetic) ────────────────────────────────────────────────────────

const SOUNDEX_MAP: Record<string, string> = {
  b: '1', f: '1', p: '1', v: '1',
  c: '2', g: '2', j: '2', k: '2', q: '2', s: '2', x: '2', z: '2',
  d: '3', t: '3',
  l: '4',
  m: '5', n: '5',
  r: '6',
};

export function soundex(word: string): string {
  if (!word) return '';
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return '';

  const first = w[0].toUpperCase();
  let code = first;
  let prev = SOUNDEX_MAP[w[0]] ?? '0';

  for (let i = 1; i < w.length && code.length < 4; i++) {
    const curr = SOUNDEX_MAP[w[i]] ?? '0';
    if (curr !== '0' && curr !== prev) code += curr;
    prev = curr;
  }

  return code.padEnd(4, '0');
}

function phoneticBonus(a: string, b: string): number {
  return soundex(a) === soundex(b) ? 0.1 : 0;
}

// ── Address normalization ─────────────────────────────────────────────────────

const USPS_ABBR: Record<string, string> = {
  STREET: 'ST', AVENUE: 'AVE', ROAD: 'RD', BOULEVARD: 'BLVD',
  DRIVE: 'DR', LANE: 'LN', COURT: 'CT', PLACE: 'PL', CIRCLE: 'CIR',
  HIGHWAY: 'HWY', FREEWAY: 'FWY', PARKWAY: 'PKWY', TERRACE: 'TER',
  NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W',
  NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE', SOUTHWEST: 'SW',
  APARTMENT: 'APT', SUITE: 'STE', FLOOR: 'FL', BUILDING: 'BLDG',
};

export function normalizeAddress(line: string): string {
  return line
    .toUpperCase()
    .replace(/[.,#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map(token => USPS_ABBR[token] ?? token)
    .join(' ');
}

// ── Token-set ratio (Jaccard on word tokens) ──────────────────────────────────

function tokenize(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/\s+/).filter(Boolean));
}

export function tokenSetRatio(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;

  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection++;

  return intersection / (ta.size + tb.size - intersection);
}

// ── Name normalization ────────────────────────────────────────────────────────

export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizePhoneLast10(s: string): string {
  return s.replace(/\D/g, '').slice(-10);
}

// ── Weighted scoring ──────────────────────────────────────────────────────────

// Weights must sum to 1.0
const W_LAST_NAME   = 0.25;
const W_FIRST_NAME  = 0.10;
const W_ADDRESS     = 0.30;
const W_CITY        = 0.05;
const W_ZIP         = 0.15;
const W_PHONE       = 0.15;

function scoreCandidate(query: FuzzyQuery, customer: CustomerRow): number {
  let score = 0;

  // Split customer.name into first / last tokens
  const nameParts = normalizeName(customer.name ?? '').split(' ');
  const customerFirst = nameParts[0] ?? '';
  const customerLast = nameParts[nameParts.length - 1] ?? '';

  if (query.name) {
    const queryParts = normalizeName(query.name).split(' ');
    const queryFirst = queryParts[0] ?? '';
    const queryLast = queryParts[queryParts.length - 1] ?? '';

    const lastSim = jaroWinkler(queryLast, customerLast) + phoneticBonus(queryLast, customerLast);
    score += Math.min(lastSim, 1.0) * W_LAST_NAME;
    score += jaroWinkler(queryFirst, customerFirst) * W_FIRST_NAME;
  }

  // Score against business address, billing address, and property addresses
  const propertyAddresses = customer.propertyAddresses ?? [];
  const spokenAddress = query.address ?? query.propertyAddress;

  if (spokenAddress) {
    const normalizedSpoken = normalizeAddress(spokenAddress);
    const addrScores: number[] = [
      ...(customer.businessAddress ? [tokenSetRatio(normalizedSpoken, normalizeAddress(customer.businessAddress))] : []),
      ...(customer.billingAddress ? [tokenSetRatio(normalizedSpoken, normalizeAddress(customer.billingAddress))] : []),
      ...propertyAddresses.filter(a => a.line1).map(a => tokenSetRatio(normalizedSpoken, normalizeAddress(a.line1!))),
    ];
    const bestAddrScore = addrScores.length > 0 ? Math.max(...addrScores) : 0;
    if (bestAddrScore > 0) score += bestAddrScore * W_ADDRESS;

    // City bonus from property addresses (structured fields)
    for (const a of propertyAddresses) {
      if (a.city) {
        const qCity = normalizeName(spokenAddress.split(',').pop()?.trim() ?? '');
        const cCity = normalizeName(a.city);
        if (qCity && cCity && qCity === cCity) { score += W_CITY; break; }
      }
    }
  }

  const firstPropAddr = propertyAddresses[0];
  if (query.zip && firstPropAddr?.zip) {
    score += (query.zip.slice(0, 5) === firstPropAddr.zip.slice(0, 5) ? 1 : 0) * W_ZIP;
  }

  if (query.oldPhone) {
    const qPhone = normalizePhoneLast10(query.oldPhone);
    const phones = [
      customer.normalizedPhonePrimary,
      customer.normalizedPhoneSecondary,
    ].filter(Boolean) as string[];
    if (phones.some(p => p === qPhone)) score += W_PHONE;
  }

  return score;
}

export function scoreCandidates(
  query: FuzzyQuery,
  candidates: CustomerRow[],
): ScoredCandidate[] {
  return candidates
    .map(customer => ({ customer, score: scoreCandidate(query, customer) }))
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score);
}

// ── Threshold bands ───────────────────────────────────────────────────────────

const ACCEPT_THRESHOLD     = 0.90;
const ACCEPT_GAP           = 0.10;
const DISAMBIGUATE_THRESHOLD = 0.75;
const DISAMBIGUATE_RETURN_COUNT = 3;

export function applyThreshold(candidates: ScoredCandidate[]): LookupDecision {
  if (candidates.length === 0) return { band: 'handoff' };

  const top = candidates[0];
  const runnerUp = candidates[1];

  if (
    top.score >= ACCEPT_THRESHOLD &&
    (!runnerUp || top.score - runnerUp.score >= ACCEPT_GAP)
  ) {
    return { band: 'accept', candidate: top.customer };
  }

  if (top.score >= DISAMBIGUATE_THRESHOLD) {
    return {
      band: 'disambiguate',
      candidates: candidates.slice(0, DISAMBIGUATE_RETURN_COUNT).map(c => c.customer),
    };
  }

  return { band: 'handoff' };
}

// ── Text normalizer (for tier-based matching) ─────────────────────────────────

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

// ── Bigram (Dice coefficient) similarity ─────────────────────────────────────

function bigramSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const bigrams = (s: string): string[] => {
    const out: string[] = [];
    for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
    return out;
  };
  const ba = bigrams(a);
  const bb = bigrams(b);
  if (ba.length === 0 || bb.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const g of bb) freq.set(g, (freq.get(g) ?? 0) + 1);
  let shared = 0;
  for (const g of ba) {
    const c = freq.get(g) ?? 0;
    if (c > 0) { shared++; freq.set(g, c - 1); }
  }
  return (2 * shared) / (ba.length + bb.length);
}

// ── fuzzySimilarity — max of token-set and bigram ────────────────────────────

export function fuzzySimilarity(a: string, b: string): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  return Math.max(tokenSetRatio(na, nb), bigramSimilarity(na, nb));
}

// ── Address-level similarity ─────────────────────────────────────────────────

export function addressSimilarityScore(a: string, b: string): number {
  const na = normalizeAddress(a);
  const nb = normalizeAddress(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1.0;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  return Math.max(tokenSetRatio(na, nb), bigramSimilarity(na, nb));
}

// ── Address query match (strict variant check) ────────────────────────────────

const DIR_PREFIX_RE = /^(N|S|E|W|NE|NW|SE|SW|NORTH|SOUTH|EAST|WEST|NORTHEAST|NORTHWEST|SOUTHEAST|SOUTHWEST)\s+/i;
const STREET_SUFFIX_RE = /\s+(ST|AVE|BLVD|DR|RD|LN|CT|PL|WAY|CIR|TER|HWY|PKWY|STREET|AVENUE|BOULEVARD|DRIVE|ROAD|LANE|COURT|PLACE|CIRCLE|TERRACE|HIGHWAY|PARKWAY)\.?$/i;

export function addressQueryMatch(query: string, candidate: string): boolean {
  if (!query || !candidate) return false;
  const base = normalizeAddress(query);
  const cand = normalizeAddress(candidate);
  if (!base || !cand) return false;
  const variants = [
    base,
    base.replace(DIR_PREFIX_RE, ''),
    base.replace(STREET_SUFFIX_RE, ''),
    base.replace(DIR_PREFIX_RE, '').replace(STREET_SUFFIX_RE, ''),
  ].filter(Boolean);
  return variants.some(v => v === cand || cand.includes(v) || v.includes(cand));
}

// ── Match signal and tier types ───────────────────────────────────────────────

export interface MatchSignals {
  phoneExact: boolean;
  locationNameExact: boolean;
  locationNameFuzzy: number;
  companyNameExact: boolean;
  companyNameFuzzy: number;
  companyNamePrefixMatch: boolean;
  locationNameMatchesCompany: boolean;
  locationNameMatchesCompanyFuzzy: number;
  companyNameMatchesLocation: boolean;
  addressSimilarity: number;
  addressQueryMatch: boolean;
  addressMatch: boolean;
  nameSimilarity: number;
  locationsForCompany: number;
  locationsForExactPhone: number;
  // ── Name confidence breakdown ────────────────────────────────────────────────
  nameMatchStrong: boolean;       // last-name exact+first fuzzy, or overall fuzzy >= 0.75
  nameMatchWeak: boolean;         // first-name-only query that matches candidate's first token
  nameMismatch: boolean;          // full name given but clearly doesn't match (fuzzy < 0.65)
  queryHasFullName: boolean;      // caller provided 2+ name tokens
  queryHasFirstNameOnly: boolean; // caller provided exactly 1 name token
}

export interface TierAssignment {
  tier: 1 | 2 | 3;
  rule: string;
}

// ── computeMatchSignals ───────────────────────────────────────────────────────
// Note: in BuildOps, customer.name serves as both "company name" and "location
// name" (there is no separate location-name field). Cross-field signals
// (locationNameMatchesCompany, companyNameMatchesLocation) therefore map to the
// same comparison, which is intentional — the tier rules still work correctly
// because they were designed to require at least two corroborating signals.

export function computeMatchSignals(
  queryName: string | undefined,
  queryAddress: string | undefined,
  queryPhone: string | undefined,
  candidate: CustomerRow,
  stats: { locationsForCompany: number; locationsForExactPhone: number },
): MatchSignals {
  const qNorm = normalizeText(queryName ?? '');
  const cNorm = normalizeText(candidate.name ?? '');
  const nameExact = !!(qNorm && qNorm === cNorm);
  const nameFuzzy = queryName ? fuzzySimilarity(queryName, candidate.name ?? '') : 0;
  const prefixMatch = !!(qNorm.length >= 5 && cNorm.length >= 5 && qNorm.slice(0, 5) === cNorm.slice(0, 5));

  // ── Token-level name breakdown ────────────────────────────────────────────────
  const queryTokens     = qNorm ? qNorm.split(/\s+/).filter(Boolean) : [];
  const candidateTokens = cNorm ? cNorm.split(/\s+/).filter(Boolean) : [];
  const queryHasFullName      = queryTokens.length >= 2;
  const queryHasFirstNameOnly = queryTokens.length === 1;

  const qFirst = queryTokens[0] ?? '';
  const qLast  = queryHasFullName ? queryTokens[queryTokens.length - 1] : '';
  const cFirst = candidateTokens[0] ?? '';
  const cLast  = candidateTokens.length >= 2 ? candidateTokens[candidateTokens.length - 1] : '';

  const firstFuzzy   = qFirst && cFirst ? fuzzySimilarity(qFirst, cFirst) : 0;
  const lastExact    = !!(qLast && cLast && qLast === cLast);
  const lastFuzzy    = qLast && cLast ? fuzzySimilarity(qLast, cLast) : 0;

  const nameMatchStrong = !!(
    (qNorm && qNorm === cNorm) ||                          // exact full name
    (lastExact && firstFuzzy >= 0.75) ||                   // last exact + first fuzzy
    (lastFuzzy >= 0.85 && firstFuzzy >= 0.75) ||           // both parts strongly fuzzy
    nameFuzzy >= 0.75                                       // overall fuzzy >= 0.75
  );
  const nameMatchWeak = !nameMatchStrong && queryHasFirstNameOnly && firstFuzzy >= 0.8;
  const nameMismatch  = !nameMatchStrong && !nameMatchWeak && queryHasFullName && nameFuzzy < 0.65;

  const addrStrings: string[] = [
    ...(candidate.businessAddress ? [candidate.businessAddress] : []),
    ...(candidate.billingAddress ? [candidate.billingAddress] : []),
    ...(candidate.propertyAddresses ?? [])
      .filter(a => a.line1)
      .map(a => [a.line1, a.city, a.state, a.zip].filter(Boolean).join(' ')),
  ];

  const qAddr = queryAddress ?? '';
  const bestAddrScore = addrStrings.length > 0
    ? Math.max(...addrStrings.map(ca => addressSimilarityScore(qAddr, ca)))
    : 0;
  const addrQMatch = addrStrings.some(ca => addressQueryMatch(qAddr, ca));
  const addrThreshold = qNorm ? 0.6 : 0.75;
  const addrMatch = addrQMatch || bestAddrScore > addrThreshold;

  return {
    phoneExact: !!(queryPhone && candidate.allNumbers.includes(queryPhone)),
    locationNameExact: nameExact,
    locationNameFuzzy: nameFuzzy,
    companyNameExact: nameExact,
    companyNameFuzzy: nameFuzzy,
    companyNamePrefixMatch: prefixMatch,
    locationNameMatchesCompany: nameExact,
    locationNameMatchesCompanyFuzzy: nameFuzzy,
    companyNameMatchesLocation: nameExact,
    addressSimilarity: bestAddrScore,
    addressQueryMatch: addrQMatch,
    addressMatch: addrMatch,
    nameSimilarity: 0,
    locationsForCompany: stats.locationsForCompany,
    locationsForExactPhone: stats.locationsForExactPhone,
    nameMatchStrong,
    nameMatchWeak,
    nameMismatch,
    queryHasFullName,
    queryHasFirstNameOnly,
  };
}

// ── assignTier ────────────────────────────────────────────────────────────────

export function assignTier(s: MatchSignals): TierAssignment {
  // Tier 1 — high confidence, auto-create job
  if (s.phoneExact && s.addressMatch)
    return { tier: 1, rule: 'phone_and_address_match' };
  if (s.locationNameExact && s.addressMatch)
    return { tier: 1, rule: 'location_name_and_address_match' };
  if (s.locationNameMatchesCompany && s.addressMatch)
    return { tier: 1, rule: 'location_as_company_and_address_match' };
  if (s.phoneExact && s.locationsForExactPhone === 1)
    return { tier: 1, rule: 'phone_match_single_location' };
  if (s.companyNameFuzzy > 0.95 && s.locationNameExact && s.addressMatch)
    return { tier: 1, rule: 'company_fuzzy_location_and_address_match' };
  if (s.companyNamePrefixMatch && s.locationNameExact && s.addressMatch)
    return { tier: 1, rule: 'company_prefix_location_and_address_match' };
  // locationsForCompany === 1 guard: prevents a false Tier 1 when multiple
  // customers share the same name (both signals collapse to the same field here)
  if (s.locationNameExact && s.companyNameExact && s.locationsForCompany === 1)
    return { tier: 1, rule: 'location_and_company_exact' };
  if (s.locationNameMatchesCompany && s.locationsForCompany === 1)
    return { tier: 1, rule: 'location_as_company_single_location' };
  if (s.phoneExact && s.addressSimilarity > 0.5)
    return { tier: 1, rule: 'phone_match_with_address_similarity' };

  // Tier 1 — address query match + strong name (full name confirmed at this address)
  if (s.addressQueryMatch && s.nameMatchStrong)
    return { tier: 1, rule: 'address_and_strong_name_match' };

  // Tier 2 — medium confidence, create job + manual review
  if (s.phoneExact && s.locationsForExactPhone > 1)
    return { tier: 2, rule: 'phone_match_multiple_locations' };
  // address match + first-name-only (weak name — needs disambiguation)
  if (s.addressQueryMatch && s.nameMatchWeak)
    return { tier: 2, rule: 'address_and_weak_name_match' };
  // address match with no name provided at all
  if (s.addressQueryMatch && !s.queryHasFullName && !s.queryHasFirstNameOnly)
    return { tier: 2, rule: 'address_query_match' };
  if (s.companyNameExact && s.addressMatch)
    return { tier: 2, rule: 'company_and_address_exact_no_location' };
  if (s.companyNameFuzzy > 0.9 && s.addressMatch)
    return { tier: 2, rule: 'company_fuzzy_and_address_no_location' };
  if (s.companyNamePrefixMatch && s.addressMatch)
    return { tier: 2, rule: 'company_prefix_and_address_no_location' };
  if (s.locationNameExact)
    return { tier: 2, rule: 'location_name_exact' };
  if (s.locationNameMatchesCompany)
    return { tier: 2, rule: 'location_name_matches_company' };
  if (s.companyNameMatchesLocation)
    return { tier: 2, rule: 'company_name_matches_location' };
  if (s.companyNameExact && s.locationsForCompany === 1)
    return { tier: 2, rule: 'company_match_single_location' };
  if (s.companyNameFuzzy > 0.6 && s.addressMatch)
    return { tier: 2, rule: 'company_fuzzy_and_address' };
  if (s.locationNameFuzzy > 0.8 && s.addressMatch)
    return { tier: 2, rule: 'location_fuzzy_and_address' };
  if (s.companyNameFuzzy > 0.8 && s.locationNameFuzzy > 0.8)
    return { tier: 2, rule: 'company_and_location_fuzzy' };

  // Tier 3 — low confidence, no job, transfer
  // Full name given + address found but name clearly doesn't match any candidate
  if (s.nameMismatch && (s.addressQueryMatch || s.addressMatch))
    return { tier: 3, rule: 'address_match_name_mismatch' };
  if (s.companyNameExact)
    return { tier: 3, rule: 'company_name_exact_only' };
  if (s.locationNameFuzzy > 0.7)
    return { tier: 3, rule: 'location_fuzzy_weak' };
  if (s.addressMatch)
    return { tier: 3, rule: 'address_match_no_name' };

  return { tier: 3, rule: 'no_strong_match' };
}

// ── crossValidate ─────────────────────────────────────────────────────────────

export function crossValidate(
  queryName: string | undefined,
  queryAddress: string | undefined,
  _queryPhone: string | undefined,
  signals: MatchSignals,
): { pass: boolean; reason?: string } {
  const hasName = !!queryName;
  const hasAddr = !!queryAddress;

  if (!hasName && !hasAddr) return { pass: true };

  const nameOk =
    !hasName ||
    signals.companyNameExact ||
    signals.locationNameMatchesCompany ||
    signals.companyNameFuzzy >= 0.6 ||
    signals.locationNameExact ||
    signals.locationNameFuzzy >= 0.75;

  const addrOk =
    !hasAddr ||
    signals.addressMatch ||
    signals.addressSimilarity >= 0.75;

  if (!nameOk && !addrOk) return { pass: false, reason: 'retell_data_mismatch' };

  if (signals.phoneExact && signals.locationsForExactPhone > 1 && hasName && !nameOk) {
    return { pass: false, reason: 'ambiguous_phone_mapping' };
  }

  return { pass: true };
}

// ── Primary address picker ────────────────────────────────────────────────────
// Priority: businessAddress → first property with a line1 → billingAddress

export type AddressSource = 'businessAddress' | 'propertyAddress' | 'billingAddress';

export function pickPrimaryAddress(
  customer: CustomerRow,
  properties?: PropertyRow[],
): { address: string | null; addressSource: AddressSource | null } {
  if (customer.businessAddress) {
    return { address: customer.businessAddress, addressSource: 'businessAddress' };
  }
  if (properties && properties.length > 0) {
    const prop = properties.find(p => p.address?.line1);
    if (prop) {
      const a = prop.address;
      return {
        address: [a.line1, a.city, a.state, a.zip].filter(Boolean).join(', '),
        addressSource: 'propertyAddress',
      };
    }
  }
  if (customer.billingAddress) {
    return { address: customer.billingAddress, addressSource: 'billingAddress' };
  }
  return { address: null, addressSource: null };
}
