import { findCustomersByPhone } from '../db/customers.js';
import { setMatchedCustomer } from '../db/inbound-calls.js';
import { normalizePhoneLast10 } from '../fuzzy-search.js';
import type { InboundCallRow, RetellFunctionResult } from '../types.js';

export async function handleLookupByPhone(
  session: InboundCallRow,
): Promise<RetellFunctionResult> {
  if (!session.caller) {
    return { result: 'no_caller_id: caller number is not available' };
  }

  const phoneLast10 = normalizePhoneLast10(session.caller);
  if (!phoneLast10) {
    return { result: 'no_caller_id: could not normalize caller number' };
  }

  const matches = await findCustomersByPhone(session.tenantId, phoneLast10);

  if (matches.length === 0) {
    return { result: 'not_found' };
  }

  if (matches.length === 1) {
    await setMatchedCustomer(session.retellCallId, matches[0].id);
    return {
      result: JSON.stringify({
        status: 'matched',
        customer: {
          id: matches[0].id,
          name: matches[0].name,
          address: matches[0].addresses?.[0] ?? null,
        },
      }),
    };
  }

  // Multiple matches — return list for agent to disambiguate
  return {
    result: JSON.stringify({
      status: 'multiple_matches',
      candidates: matches.slice(0, 4).map(c => ({
        id: c.id,
        name: c.name,
        address: c.addresses?.[0] ?? null,
      })),
    }),
  };
}
