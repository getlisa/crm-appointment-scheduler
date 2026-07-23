/**
 * Address helpers for the HCP integration: convert HCP API addresses to the
 * internal normalized shape and score a spoken address against stored ones.
 */

import { normalizeAddress, tokenSetRatio } from './fuzzy-search.js';
import type { HcpApiAddress, HcpAddressLite } from './types.js';

export function formatAddress(a: {
  street?: string | null;
  street_line_2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}): string {
  const stateZip = [a.state, a.zip].filter(Boolean).join(' ');
  return [a.street, a.street_line_2, a.city, stateZip].filter(Boolean).join(', ');
}

export function toAddressLite(a: HcpApiAddress): HcpAddressLite {
  return {
    id: a.id,
    street: a.street ?? null,
    streetLine2: a.street_line_2 ?? null,
    city: a.city ?? null,
    state: a.state ?? null,
    zip: a.zip ?? null,
    country: a.country ?? null,
    formatted: formatAddress(a),
  };
}

/** Fraction of the stored address's tokens that appear in the spoken address. */
function recallRatio(spoken: string, stored: string): number {
  const tokenize = (s: string): Set<string> => new Set(s.split(/\s+/).filter(Boolean));
  const ts = tokenize(spoken.toLowerCase());
  const tb = tokenize(stored.toLowerCase());
  if (tb.size === 0) return ts.size === 0 ? 1 : 0;
  let hit = 0;
  for (const t of tb) if (ts.has(t)) hit++;
  return hit / tb.size;
}

/**
 * Scores a spoken address against a stored address (0..1).
 * Street via max(token-set, recall); +0.1 city bonus, +0.1 zip bonus.
 */
export function scoreAddress(spoken: string, addr: HcpAddressLite): number {
  const normSpoken = normalizeAddress(spoken);
  const streetScore = addr.street
    ? Math.max(
        tokenSetRatio(normSpoken, normalizeAddress(addr.street)),
        recallRatio(normSpoken, normalizeAddress(addr.street)),
      )
    : 0;

  const spokenFlat = spoken.toLowerCase().replace(/[\s-]/g, '');
  const cityBonus = addr.city && (
    spoken.toLowerCase().includes(addr.city.toLowerCase()) ||
    spokenFlat.includes(addr.city.toLowerCase().replace(/[\s-]/g, ''))
  ) ? 0.1 : 0;

  const zipBonus = addr.zip && spoken.includes(addr.zip) ? 0.1 : 0;

  return Math.min(streetScore + cityBonus + zipBonus, 1);
}
