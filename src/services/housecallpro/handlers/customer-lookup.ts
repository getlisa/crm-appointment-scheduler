/**
 * Retell function handler: customer_lookup.
 *
 * Phone-based caller identification. In the Twilio-Function (registerPhoneCall)
 * path there is no `call_inbound` webhook, so identification can't happen at call
 * setup — the agent calls this once the caller asks for a service request. It looks
 * the caller up by the number they're calling from (stored on the session) and, on
 * a single match, records the customer on the session so the downstream flow
 * (match_address / book_job) works. Return shape mirrors handleLookupFuzzy so the
 * agent branches identically: found / not_found (→ fuzzy) / multiple_matches.
 */

import { findCustomersByPhone, getCustomerByHcpId } from '../db/customers.js';
import { setMatchedCustomer } from '../db/callsessions.js';
import { normalizePhoneLast10 } from '../fuzzy-search.js';
import type { HcpCallSessionRow, RetellFunctionResult } from '../types.js';

export async function handleCustomerLookup(
  session: HcpCallSessionRow,
): Promise<RetellFunctionResult> {
  // Idempotent: if already identified (e.g. the agent calls it twice), return the match.
  if (session.housecallproCustomerId) {
    const c = await getCustomerByHcpId(session.tenantId, session.housecallproCustomerId).catch(() => null);
    return {
      result: JSON.stringify({
        status: 'found',
        identified: true,
        customer_id: session.housecallproCustomerId,
        customer_name: session.customerName ?? c?.name ?? '',
        first_name: c?.firstName ?? '',
        last_name: c?.lastName ?? '',
      }),
    };
  }

  const last10 = session.caller ? normalizePhoneLast10(session.caller) : '';
  const matches = last10 ? await findCustomersByPhone(session.tenantId, last10) : [];
  console.log('[hcp] customer_lookup', { sessionId: session.sessionId, last10, matchCount: matches.length });

  if (matches.length === 1) {
    const c = matches[0];
    await setMatchedCustomer(session.sessionId, c.housecallproCustomerId, c.name, 'phone');
    return {
      result: JSON.stringify({
        status: 'found',
        identified: true,
        customer_id: c.housecallproCustomerId,
        customer_name: c.name,
        first_name: c.firstName ?? '',
        last_name: c.lastName ?? '',
      }),
    };
  }

  if (matches.length === 0) {
    // Do NOT record a customer — leaves the door open for lookup_customer_fuzzy.
    return { result: JSON.stringify({ status: 'not_found', identified: false }) };
  }

  // 2+ matches on the same number — let the agent disambiguate, then confirm_customer.
  return {
    result: JSON.stringify({
      status: 'multiple_matches',
      identified: false,
      candidates: matches.map(m => ({ id: m.housecallproCustomerId, name: m.name })),
    }),
  };
}
