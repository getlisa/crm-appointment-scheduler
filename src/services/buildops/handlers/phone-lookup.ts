/**
 * Retell function handler: lookup_customer_by_phone.
 * Performs an exact phone lookup using the caller's from_number against the
 * all_numbers GIN index. This is the fastest identification path and runs
 * automatically at call_inbound before any fuzzy logic is needed.
 */

import { findCustomersByPhone } from '../db/customers.js';
import { getPropertiesByIds } from '../db/properties.js';
import { setMatchedCustomer } from '../db/inbound-calls.js';
import { normalizePhoneLast10, pickPrimaryAddress } from '../fuzzy-search.js';
import type { InboundCallRow, RetellFunctionResult } from '../types.js';

/**
 * Looks up a customer by the caller's phone number.
 * Returns 'matched' with customer data on a single hit, 'multiple_matches' with
 * a candidate list on 2–4 hits, or 'not_found' when no match exists.
 *
 * @param session - Current inbound call session (must have caller set)
 * @returns RetellFunctionResult with status and customer data
 */
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
    const properties = await getPropertiesByIds(matches[0].propertyIds);
    const primary = pickPrimaryAddress(matches[0], properties);
    return {
      result: JSON.stringify({
        status: 'matched',
        customer: {
          id: matches[0].id,
          name: matches[0].name,
          address: primary.address,
          addressSource: primary.addressSource,
        },
      }),
    };
  }

  // Multiple matches — return list for agent to disambiguate
  return {
    result: JSON.stringify({
      status: 'multiple_matches',
      candidates: matches.slice(0, 4).map(c => {
        const primary = pickPrimaryAddress(c);
        return { id: c.id, name: c.name, address: primary.address, addressSource: primary.addressSource };
      }),
    }),
  };
}
