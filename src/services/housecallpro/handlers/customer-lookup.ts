/**
 * Retell function handler: customer_lookup.
 *
 * Phone-based caller identification. In the Twilio-Function (registerPhoneCall)
 * path there is no `call_inbound` webhook, so identification can't happen at call
 * setup — the agent calls this once the caller asks for a service request. It looks
 * the caller up by the number they're calling from (stored on the session) and, on
 * a single match, records the customer on the session so the downstream flow
 * (match_address / book_job / create_lead) works. Return shape mirrors
 * handleLookupFuzzy so the agent branches identically: found / not_found
 * (→ fuzzy) / multiple_matches.
 *
 * Every result also carries `ask_lead_source`. It is true when the dialed line
 * maps to no HCP lead source, which is the agent's cue to ask "how did you hear
 * about us?" later in the call and pass the answer to create_lead. Riding on
 * this call keeps attribution free of an extra round trip — customer_lookup runs
 * first on every call anyway.
 */

import { findCustomersByPhone, getCustomerByHcpId } from '../db/customers.js';
import { setMatchedCustomer } from '../db/callsessions.js';
import { normalizePhoneLast10 } from '../fuzzy-search.js';
import type { HcpCallSessionRow, RetellFunctionResult } from '../types.js';

export async function handleCustomerLookup(
  session: HcpCallSessionRow,
): Promise<RetellFunctionResult> {
  // Whether Clara has to ask "how did you hear about us?".
  //
  // Two conditions, both required. The dialed line must map to no HCP lead
  // source (resolved once at call start and pinned to the session), AND the
  // caller must be someone we don't already know — asking a repeat customer
  // where they heard of us is a question they have already answered.
  const leadSourceUnknown = !session.leadSourceName;

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
        ask_lead_source: false,
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
        ask_lead_source: false,
      }),
    };
  }

  if (matches.length === 0) {
    // Do NOT record a customer — leaves the door open for lookup_customer_fuzzy.
    return {
      result: JSON.stringify({ status: 'not_found', identified: false, ask_lead_source: leadSourceUnknown }),
    };
  }

  // 2+ matches on the same number — let the agent disambiguate, then confirm_customer.
  return {
    result: JSON.stringify({
      status: 'multiple_matches',
      identified: false,
      candidates: matches.map(m => ({ id: m.housecallproCustomerId, name: m.name })),
      ask_lead_source: false,
    }),
  };
}
