/**
 * Maps what a caller SAID about hearing of the company onto one of the lead
 * source names configured on their HCP account.
 *
 * Why this exists: `lead_source` on POST /leads is matched by exact NAME. HCP
 * rejects the whole write with 400 "Lead source not found" on anything else, so
 * the agent's free-text answer ("I saw your van", "found you on google") can
 * never be forwarded as-is. This narrows it to a real name, or to nothing.
 *
 * Never guesses: an answer that doesn't clearly match sends no lead_source at
 * all. The caller's own words are kept on the lead note instead, so a miss
 * costs attribution but loses no information.
 */

import { listLeadSources } from './client.js';
import type { HcpContext } from './types.js';

/** Configured names per tenant. Lives for the lifetime of a warm instance. */
const CACHE_TTL_MS = 10 * 60_000;
const cache = new Map<string, { names: string[]; at: number }>();

/** Lowercase, strip punctuation, collapse whitespace. "PG&E" → "pg e". */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Phrases a caller plausibly says, mapped to the normalized form of the name to
 * look for. Only the common, unambiguous ones — anything subtler is left to the
 * no-match path rather than guessed at.
 */
const SYNONYMS: [RegExp, string][] = [
  [/\bgoogle\b.*\b(local|lsa|service)\b|\blsa\b/, 'google local services'],
  [/\bgoogle (my )?business\b|\bgmb\b|\bmaps\b/, 'google my business'],
  [/\bgoogle\b|\bsearch(ed)? (you )?online\b/, 'google'],
  [/\bfacebook\b|\bfb\b|\bmeta\b/, 'facebook'],
  [/\b(web ?site|online|internet)\b/, 'website'],
  [/\b(referr?al|referred|recommend(ed|ation)?|word of mouth)\b/, 'referral'],
  [/\bneighbou?r\b/, 'neighbor'],
  [/\b(used you|used them|before|repeat|existing|already a customer|last time)\b/, 'repeat customer'],
  [/\b(van|truck|vehicle|wrap|sign on)\b/, 'van'],
  [/\b(pg ?and ?e|pge|pg e|utility)\b/, 'pg and e'],
  [/\bchamber\b/, 'chamber'],
  [/\bqmerit\b/, 'qmerit'],
  [/\bbuildertrend\b/, 'buildertrend'],
  [/\bweca\b/, 'weca'],
];

async function configuredNames(ctx: HcpContext): Promise<string[]> {
  const hit = cache.get(ctx.tenantId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.names;

  const res = await listLeadSources(ctx);
  const names = (res.lead_sources ?? []).map(s => s.name).filter(Boolean);
  cache.set(ctx.tenantId, { names, at: Date.now() });
  return names;
}

/**
 * Resolves the caller's answer to a configured lead-source name.
 *
 * Order: exact (normalized) name, then a synonym phrase, then a containment
 * match in either direction. Several candidates at the same strength means the
 * answer was ambiguous — return null rather than pick one.
 *
 * @returns the name spelled exactly as HCP stores it, or null to send none
 */
export async function matchLeadSource(
  ctx: HcpContext,
  spoken: string | null | undefined,
): Promise<string | null> {
  const said = normalize(spoken ?? '');
  if (!said) return null;

  const names = await configuredNames(ctx).catch(() => [] as string[]);
  if (names.length === 0) return null;

  // HCP accounts carry names with stray casing and trailing spaces
  // ("Existing Customer ", "referal"), so compare on the normalized form and
  // always return the original spelling.
  const byNorm = names.map(name => ({ name, norm: normalize(name) }));

  const exact = byNorm.filter(n => n.norm === said);
  if (exact.length >= 1) return exact[0].name;

  for (const [pattern, target] of SYNONYMS) {
    if (!pattern.test(said)) continue;
    const hits = byNorm.filter(n => n.norm === target || n.norm.includes(target));
    if (hits.length === 1) return hits[0].name;
    // Prefer the shortest name when a synonym maps onto a family
    // ("google" also matches "google my business").
    if (hits.length > 1) {
      const sorted = [...hits].sort((a, b) => a.norm.length - b.norm.length);
      if (sorted[0].norm === target) return sorted[0].name;
    }
  }

  const contained = byNorm.filter(n => said.includes(n.norm) || n.norm.includes(said));
  if (contained.length === 1) return contained[0].name;

  return null;
}

/** Test seam — drops the per-tenant name cache. */
export function clearLeadSourceCache(): void {
  cache.clear();
}
