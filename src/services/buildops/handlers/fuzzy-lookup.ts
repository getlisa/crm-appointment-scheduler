import { getFuzzyCandidates } from '../db/customers.js';
import { setMatchedCustomer, setCallStatus } from '../db/inbound-calls.js';
import { scoreCandidates, applyThreshold, normalizePhoneLast10 } from '../fuzzy-search.js';
import type { InboundCallRow, FuzzyQuery, RetellFunctionResult } from '../types.js';

export async function handleLookupFuzzy(
  session: InboundCallRow,
  args: Record<string, unknown>,
): Promise<RetellFunctionResult> {
  const query: FuzzyQuery = {
    name: args.name as string | undefined,
    address: args.address as string | undefined,
    zip: args.zip as string | undefined,
    oldPhone: args.old_phone as string | undefined,
  };

  if (!query.name && !query.zip) {
    return {
      result: 'need_more_info: please provide at least a name or zip code to search',
    };
  }

  const candidates = await getFuzzyCandidates(session.tenantId, query);
  const scored = scoreCandidates(query, candidates);
  const decision = applyThreshold(scored);

  if (decision.band === 'accept') {
    await setMatchedCustomer(session.retellCallId, decision.candidate.id);

    const callerLast10 = session.caller ? normalizePhoneLast10(session.caller) : null;
    const newNumberDetected =
      callerLast10 !== null &&
      callerLast10 !== decision.candidate.normalizedPhonePrimary &&
      callerLast10 !== decision.candidate.normalizedPhoneSecondary;

    return {
      result: JSON.stringify({
        status: 'found',
        identified: true,
        confidence: scored[0]?.score ?? 1,
        customer_id: decision.candidate.id,
        customer_name: decision.candidate.name,
        new_number_detected: newNumberDetected,
        address: decision.candidate.addresses?.[0] ?? null,
      }),
    };
  }

  if (decision.band === 'disambiguate') {
    return {
      result: JSON.stringify({
        status: 'multiple_matches',
        identified: false,
        confidence: scored[0]?.score ?? 0,
        customer_id: null,
        customer_name: null,
        new_number_detected: false,
        candidates: decision.candidates.map(c => ({
          id: c.id,
          name: c.name,
          address: c.addresses?.[0] ?? null,
        })),
      }),
    };
  }

  // Handoff — no confident match found
  await setCallStatus(session.retellCallId, 'handed_off');
  return {
    result: JSON.stringify({
      status: 'not_found',
      identified: false,
      confidence: scored[0]?.score ?? 0,
      customer_id: null,
      customer_name: null,
      new_number_detected: false,
      message: "I wasn't able to find your account. I'm not finding that account in our system.",
    }),
  };
}
