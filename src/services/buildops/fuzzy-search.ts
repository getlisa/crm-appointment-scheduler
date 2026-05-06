import type { CustomerRow, FuzzyQuery, ScoredCandidate, LookupDecision } from './types.js';

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
const W_STATE       = 0.05;
const W_ZIP         = 0.10;
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

  const addr = customer.addresses?.[0];
  if (query.address && addr?.line1) {
    score += tokenSetRatio(
      normalizeAddress(query.address),
      normalizeAddress(addr.line1),
    ) * W_ADDRESS;
  }

  if (query.zip && addr?.zip) {
    score += (query.zip.slice(0, 5) === addr.zip.slice(0, 5) ? 1 : 0) * W_ZIP;
  }

  if (addr?.city && query.address) {
    // City match is a bonus when address is being compared
    const qCity = normalizeName(query.address.split(',').pop()?.trim() ?? '');
    const cCity = normalizeName(addr.city);
    if (qCity && cCity && qCity === cCity) score += W_CITY;
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
