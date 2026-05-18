/**
 * Retell function handler: lookup_customer_fuzzy.
 * Scores DB candidates using multi-algorithm fuzzy matching, assigns confidence
 * tiers, and returns found/multiple_matches/not_found. Tier 1 accepts auto-confirm
 * the customer; Tier 2 accepts require verbal confirmation; Tier 3 transfers the call.
 */

import { getFuzzyCandidates } from '../db/customers.js';
import { setMatchedCustomer, setCallStatus } from '../db/inbound-calls.js';
import { getPropertiesByIds } from '../db/properties.js';
import {
  normalizePhoneLast10,
  computeMatchSignals,
  assignTier,
  crossValidate,
  pickPrimaryAddress,
} from '../fuzzy-search.js';
import type { InboundCallRow, FuzzyQuery, RetellFunctionResult } from '../types.js';

/**
 * Handles the lookup_customer_fuzzy Retell function call.
 * Requires at least one of: name, zip, address, property_address in args.
 *
 * @param session - Current inbound call session with tenantId and caller
 * @param args    - Function arguments from Retell: name, address, property_address, zip, old_phone
 * @returns RetellFunctionResult — status: found | multiple_matches | not_found, with supporting fields
 */
export async function handleLookupFuzzy(
  session: InboundCallRow,
  args: Record<string, unknown>,
): Promise<RetellFunctionResult> {
  if (session.matchedCustomerId) {
    console.log('[buildops] lookup_customer_fuzzy blocked: caller already identified', {
      retellCallId: session.retellCallId,
      matchedCustomerId: session.matchedCustomerId,
    });
    return {
      result: JSON.stringify({
        status: 'error',
        message: 'Caller already identified. Cannot look up a different account.',
      }),
    };
  }

  const query: FuzzyQuery = {
    name: args.name as string | undefined,
    address: args.address as string | undefined,
    propertyAddress: args.property_address as string | undefined,
    zip: args.zip as string | undefined,
    oldPhone: args.old_phone as string | undefined,
  };

  if (!query.name && !query.zip && !query.address && !query.propertyAddress) {
    return {
      result: 'need_more_info: please provide at least a name, zip code, or address to search',
    };
  }

  console.log('[buildops] fuzzy lookup start', {
    retellCallId: session.retellCallId,
    tenantId: session.tenantId,
    query,
  });

  const candidates = await getFuzzyCandidates(session.tenantId, query);

  if (candidates.length === 0) {
    await setCallStatus(session.retellCallId, 'handed_off');
    return {
      result: JSON.stringify({
        status: 'not_found',
        identified: false,
        message: 'no_matches',
      }),
    };
  }

  const callerPhone = session.caller ? normalizePhoneLast10(session.caller) : undefined;
  const queryPhone  = query.oldPhone ? normalizePhoneLast10(query.oldPhone) : callerPhone;
  const queryName   = query.name;
  const queryAddr   = query.propertyAddress ?? query.address;

  // Aggregate stats from the candidate set (within-tenant approximation)
  const phoneCounts = new Map<string, number>();
  const nameCounts  = new Map<string, number>();
  for (const c of candidates) {
    const key = (c.name ?? '').toLowerCase().trim();
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
    if (queryPhone) {
      for (const p of c.allNumbers) {
        if (p === queryPhone) phoneCounts.set(queryPhone, (phoneCounts.get(queryPhone) ?? 0) + 1);
      }
    }
  }

  // Rate each candidate with signals + tier
  const rated = candidates.map(c => {
    const nameKey = (c.name ?? '').toLowerCase().trim();
    const stats = {
      locationsForCompany: nameCounts.get(nameKey) ?? 1,
      locationsForExactPhone: queryPhone ? (phoneCounts.get(queryPhone) ?? 0) : 0,
    };
    const signals = computeMatchSignals(queryName, queryAddr, queryPhone, c, stats);
    const tier    = assignTier(signals);
    return { customer: c, signals, tier };
  });

  // Sort: tier asc → addressSimilarity desc → companyNameFuzzy desc
  rated.sort((a, b) =>
    a.tier.tier !== b.tier.tier
      ? a.tier.tier - b.tier.tier
      : b.signals.addressSimilarity - a.signals.addressSimilarity ||
        b.signals.companyNameFuzzy  - a.signals.companyNameFuzzy,
  );

  const tier1 = rated.filter(r => r.tier.tier === 1);
  const tier2 = rated.filter(r => r.tier.tier === 2);

  // ── Pre-tree: full name + address given, address found, but name clearly mismatches ──
  // e.g. "Rahul Jason" + "2 London Road" where records are "Rahul Saxena" / "Rahul Singh"
  if (rated[0]?.signals.queryHasFullName && queryAddr) {
    const addrMatches = rated.filter(r => r.signals.addressQueryMatch || r.signals.addressMatch);
    if (addrMatches.length > 0 && addrMatches.every(r => r.signals.nameMismatch)) {
      await setCallStatus(session.retellCallId, 'handed_off');
      return {
        result: JSON.stringify({
          status: 'not_found',
          identified: false,
          message: 'name_address_mismatch',
        }),
      };
    }
  }

  console.log('[buildops] fuzzy lookup scored', {
    retellCallId: session.retellCallId,
    candidateCount: candidates.length,
    tier1Count: tier1.length,
    tier2Count: tier2.length,
  });

  // Shared accept path — stores matched customer and builds response
  const accept = async (
    r: (typeof rated)[0],
    confidenceTier: 1 | 2,
  ): Promise<RetellFunctionResult> => {
    console.log('[buildops] fuzzy lookup accepted', {
      retellCallId: session.retellCallId,
      customerId: r.customer.id,
      customerName: r.customer.name,
      confidenceTier,
      tierRule: r.tier.rule,
    });
    await setMatchedCustomer(session.retellCallId, r.customer.id);
    const newNumberDetected = !!callerPhone && !r.customer.allNumbers.includes(callerPhone);
    const properties = await getPropertiesByIds(r.customer.propertyIds);
    const primary = pickPrimaryAddress(r.customer, properties);
    return {
      result: JSON.stringify({
        status: 'found',
        identified: true,
        confidence_tier: confidenceTier,
        requires_review: confidenceTier === 2,
        customer_id: r.customer.id,
        customer_name: r.customer.name,
        new_number_detected: newNumberDetected,
        address: primary.address,
        addressSource: primary.addressSource,
        tier_reason: r.tier.rule,
        property_count: properties.length,
        ...(properties.length === 1 ? { property_id: properties[0].id } : {}),
      }),
    };
  };

  // ── Tier 1 — high confidence → auto-create job ──────────────────────────────
  if (tier1.length > 0) {
    const best = tier1[0];
    const cv = crossValidate(queryName, queryAddr, queryPhone, best.signals);
    if (cv.pass) return accept(best, 1);
    await setCallStatus(session.retellCallId, 'handed_off');
    return {
      result: JSON.stringify({
        status: 'not_found',
        identified: false,
        message: cv.reason ?? 'retell_data_mismatch',
      }),
    };
  }

  // ── Tier 2 — medium confidence → job + review ───────────────────────────────
  if (tier2.length > 0) {
    const uniqueIds = [...new Set(tier2.map(r => r.customer.id))];
    if (uniqueIds.length === 1) return accept(tier2[0], 2);
    // Multiple Tier 2 candidates pointing to different customers → disambiguate
    // When all are weak-name matches (first-name-only), tell the agent to ask for the last name
    const needLastName = tier2.every(r => r.signals.nameMatchWeak);
    return {
      result: JSON.stringify({
        status: 'multiple_matches',
        identified: false,
        ...(needLastName ? { message: 'need_last_name' } : {}),
        candidates: tier2.slice(0, 3).map(r => ({
          id: r.customer.id,
          name: r.customer.name,
          address: r.customer.businessAddress ?? r.customer.billingAddress ?? null,
          tier_reason: r.tier.rule,
        })),
      }),
    };
  }

  // ── Tier 3 — low confidence → transfer ─────────────────────────────────────
  await setCallStatus(session.retellCallId, 'handed_off');
  return {
    result: JSON.stringify({
      status: 'not_found',
      identified: false,
      message: 'low_confidence_matches',
    }),
  };
}
