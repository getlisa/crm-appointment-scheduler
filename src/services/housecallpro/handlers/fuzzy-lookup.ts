/**
 * Retell function handler: lookup_customer_fuzzy (Scenario A).
 * Runs when the caller was not identified by phone. Gathers name candidates from
 * the cache, scores them with the tier system, and returns found / multiple_matches
 * / not_found. A Tier-1/2 accept records the matched customer on the session.
 */

import { getFuzzyCandidates } from '../db/customers.js';
import { setMatchedCustomer, setStatus } from '../db/callsessions.js';
import {
  normalizePhoneLast10,
  computeMatchSignals,
  assignTier,
  crossValidate,
} from '../fuzzy-search.js';
import type { HcpCallSessionRow, RetellFunctionResult } from '../types.js';

export async function handleLookupFuzzy(
  session: HcpCallSessionRow,
  args: Record<string, unknown>,
): Promise<RetellFunctionResult> {
  if (session.housecallproCustomerId) {
    return {
      result: JSON.stringify({
        status: 'error',
        message: 'Caller already identified. Cannot look up a different account.',
      }),
    };
  }

  const name = (args.name as string | undefined)?.trim();
  const address = (args.address as string | undefined)?.trim();
  const zip = (args.zip as string | undefined)?.trim();
  const oldPhone = (args.old_phone as string | undefined)?.trim();

  if (!name) {
    return { result: 'need_more_info: please provide at least a name to search' };
  }

  const candidates = await getFuzzyCandidates(session.tenantId, { name, zip });
  console.log('[hcp] fuzzy lookup', { sessionId: session.sessionId, name, zip, candidateCount: candidates.length });

  if (candidates.length === 0) {
    await setStatus(session.sessionId, 'handed_off');
    return { result: JSON.stringify({ status: 'not_found', identified: false, message: 'no_matches' }) };
  }

  const callerPhone = session.caller ? normalizePhoneLast10(session.caller) : undefined;
  const queryPhone = oldPhone ? normalizePhoneLast10(oldPhone) : callerPhone;

  // Aggregate within-candidate stats
  const nameCounts = new Map<string, number>();
  let phoneMatchCount = 0;
  for (const c of candidates) {
    const key = c.name.toLowerCase().trim();
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
    if (queryPhone && c.allNumbers.includes(queryPhone)) phoneMatchCount++;
  }

  const rated = candidates.map(c => {
    const stats = {
      customersForName: nameCounts.get(c.name.toLowerCase().trim()) ?? 1,
      customersForExactPhone: queryPhone ? phoneMatchCount : 0,
    };
    const signals = computeMatchSignals(name, address, queryPhone, c, stats);
    return { customer: c, signals, tier: assignTier(signals) };
  });

  rated.sort((a, b) =>
    a.tier.tier !== b.tier.tier
      ? a.tier.tier - b.tier.tier
      : b.signals.addressSimilarity - a.signals.addressSimilarity ||
        b.signals.nameFuzzy - a.signals.nameFuzzy,
  );

  const tier1 = rated.filter(r => r.tier.tier === 1);
  const tier2 = rated.filter(r => r.tier.tier === 2);

  // Pre-tree: full name + address given, address found, but name clearly mismatches
  if (rated[0]?.signals.queryHasFullName && address) {
    const addrMatches = rated.filter(r => r.signals.addressQueryMatch || r.signals.addressMatch);
    if (addrMatches.length > 0 && addrMatches.every(r => r.signals.nameMismatch)) {
      await setStatus(session.sessionId, 'handed_off');
      return { result: JSON.stringify({ status: 'not_found', identified: false, message: 'name_address_mismatch' }) };
    }
  }

  const accept = async (
    r: (typeof rated)[number],
    confidenceTier: 1 | 2,
  ): Promise<RetellFunctionResult> => {
    await setMatchedCustomer(session.sessionId, r.customer.housecallproCustomerId, r.customer.name, `tier${confidenceTier}`);
    console.log('[hcp] fuzzy lookup accepted', { sessionId: session.sessionId, customerId: r.customer.housecallproCustomerId, confidenceTier, rule: r.tier.rule });
    return {
      result: JSON.stringify({
        status: 'found',
        identified: true,
        confidence_tier: confidenceTier,
        requires_review: confidenceTier === 2,
        customer_id: r.customer.housecallproCustomerId,
        customer_name: r.customer.name,
        first_name: r.customer.firstName,
        last_name: r.customer.lastName,
        tier_reason: r.tier.rule,
      }),
    };
  };

  // Tier 1 — high confidence
  if (tier1.length > 0) {
    const best = tier1[0];
    const cv = crossValidate(name, address, queryPhone, best.signals);
    if (cv.pass) return accept(best, 1);
    await setStatus(session.sessionId, 'handed_off');
    return { result: JSON.stringify({ status: 'not_found', identified: false, message: cv.reason ?? 'retell_data_mismatch' }) };
  }

  // Tier 2 — medium confidence
  if (tier2.length > 0) {
    const uniqueIds = [...new Set(tier2.map(r => r.customer.housecallproCustomerId))];
    if (uniqueIds.length === 1) return accept(tier2[0], 2);
    const needLastName = tier2.every(r => r.signals.nameMatchWeak);
    return {
      result: JSON.stringify({
        status: 'multiple_matches',
        identified: false,
        ...(needLastName ? { message: 'need_last_name' } : {}),
        candidates: tier2.slice(0, 3).map(r => ({
          id: r.customer.housecallproCustomerId,
          name: r.customer.name,
          tier_reason: r.tier.rule,
        })),
      }),
    };
  }

  // Tier 3 — low confidence → transfer
  await setStatus(session.sessionId, 'handed_off');
  return { result: JSON.stringify({ status: 'not_found', identified: false, message: 'low_confidence_matches' }) };
}
