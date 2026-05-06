import { getFuzzyCandidates } from '../db/customers.js';
import { setMatchedCustomer, setCallStatus } from '../db/inbound-calls.js';
import { scoreCandidates, applyThreshold } from '../fuzzy-search.js';
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
    return {
      result: JSON.stringify({
        status: 'matched',
        customer: {
          id: decision.candidate.id,
          name: decision.candidate.name,
          address: decision.candidate.addresses?.[0] ?? null,
        },
      }),
    };
  }

  if (decision.band === 'disambiguate') {
    return {
      result: JSON.stringify({
        status: 'multiple_candidates',
        candidates: decision.candidates.map(c => ({
          id: c.id,
          name: c.name,
          address: c.addresses?.[0] ?? null,
        })),
      }),
    };
  }

  // Handoff
  await setCallStatus(session.retellCallId, 'handed_off');
  return {
    result: JSON.stringify({
      status: 'handoff',
      message:
        "I wasn't able to find your account with confidence. Let me get a teammate to help you — can I take a callback number?",
      top_candidates: scored.slice(0, 3).map(c => ({
        id: c.customer.id,
        name: c.customer.name,
        score: c.score,
      })),
    }),
  };
}
