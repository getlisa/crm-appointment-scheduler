/**
 * Retell function handlers for customer + address resolution (Office-Hours flow):
 *   confirm_customer  — finalize a candidate after multiple_matches
 *   create_customer   — non-customer flow: POST /customers, then cache + match on session
 *   match_address     — Scenario B: fuzzy-match a spoken address to a customer address_id
 *   create_address    — add a new service address to the customer
 */

import { createCustomer, createAddress, getCustomerAddresses } from '../client.js';
import { upsertCustomer, appendAddressId, getCustomerByHcpId } from '../db/customers.js';
import { setMatchedCustomer, setServiceAddressMap } from '../db/callsessions.js';
import { normalizePhoneLast10 } from '../fuzzy-search.js';
import { toAddressLite, scoreAddress, formatAddress } from '../address.js';
import type {
  HcpCallSessionRow,
  HcpContext,
  HcpAddressLite,
  HcpServiceAddressMap,
  RetellFunctionResult,
} from '../types.js';

const MATCH_CONFIDENT = 0.6;
const MATCH_AMBIG_GAP = 0.15;

export async function handleConfirmCustomer(
  session: HcpCallSessionRow,
  args: Record<string, unknown>,
): Promise<RetellFunctionResult> {
  const candidateId = (args.candidate_id as string | undefined)?.trim();
  if (!candidateId) return { result: 'error: candidate_id is required' };

  const customer = await getCustomerByHcpId(session.tenantId, candidateId);
  if (!customer) return { result: 'error: customer not found for this tenant' };

  await setMatchedCustomer(session.sessionId, customer.housecallproCustomerId, customer.name, 'confirmed');
  return {
    result: JSON.stringify({
      status: 'confirmed',
      customer_id: customer.housecallproCustomerId,
      customer_name: customer.name,
      first_name: customer.firstName,
      last_name: customer.lastName,
    }),
  };
}

export async function handleCreateCustomer(
  session: HcpCallSessionRow,
  ctx: HcpContext,
  args: Record<string, unknown>,
): Promise<RetellFunctionResult> {
  const firstName = (args.first_name as string | undefined)?.trim();
  const lastName = (args.last_name as string | undefined)?.trim();
  if (!firstName || !lastName) {
    return { result: 'error: first_name and last_name are required' };
  }

  const mobileArg = (args.mobile_number as string | undefined)?.trim();
  const mobileNumber = mobileArg || (session.caller ? normalizePhoneLast10(session.caller) : undefined);

  try {
    const created = await createCustomer(ctx, {
      first_name: firstName,
      last_name: lastName,
      email: (args.email as string | undefined)?.trim() || undefined,
      company: (args.company as string | undefined)?.trim() || undefined,
      mobile_number: mobileNumber || undefined,
      notifications_enabled: true,
      tags: ['Clara'],
      lead_source: (args.lead_source as string | undefined)?.trim() || 'Clara',
      notes: (args.notes as string | undefined)?.trim() || undefined,
    });

    await upsertCustomer(session.tenantId, created).catch(() => null);
    const name = [created.first_name, created.last_name].filter(Boolean).join(' ').trim();
    await setMatchedCustomer(session.sessionId, created.id, name, 'new_customer');

    console.log('[hcp] create_customer', { sessionId: session.sessionId, customerId: created.id });
    return {
      result: JSON.stringify({
        status: 'created',
        customer_id: created.id,
        customer_name: name,
      }),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[hcp] create_customer error', { sessionId: session.sessionId, error: msg });
    return { result: `error: could not create customer — ${msg}` };
  }
}

/** Loads the customer's addresses into the session map (fetches once, then cached). */
async function ensureAddressMap(
  session: HcpCallSessionRow,
  ctx: HcpContext,
  customerId: string,
): Promise<HcpServiceAddressMap> {
  const existing = session.serviceAddressMap;
  if (existing && existing.addresses && Object.keys(existing.addresses).length > 0) {
    return existing;
  }
  const res = await getCustomerAddresses(ctx, customerId);
  const addresses: Record<string, HcpAddressLite> = {};
  for (const a of res.addresses ?? []) addresses[a.id] = toAddressLite(a);
  const map: HcpServiceAddressMap = { addresses, selectedAddressId: existing?.selectedAddressId ?? null };
  await setServiceAddressMap(session.sessionId, map);
  return map;
}

export async function handleMatchAddress(
  session: HcpCallSessionRow,
  ctx: HcpContext,
  args: Record<string, unknown>,
): Promise<RetellFunctionResult> {
  if (!session.housecallproCustomerId) {
    return { result: 'error: no customer identified yet — identify or create the customer first' };
  }
  const spoken = (args.spoken_address as string | undefined)?.trim();
  if (!spoken) return { result: 'error: spoken_address is required' };

  const map = await ensureAddressMap(session, ctx, session.housecallproCustomerId);
  const addresses = Object.values(map.addresses);
  if (addresses.length === 0) {
    return { result: JSON.stringify({ status: 'no_addresses', message: 'Customer has no saved addresses — create one.' }) };
  }

  const scored = addresses
    .map(a => ({ address: a, score: scoreAddress(spoken, a) }))
    .sort((x, y) => y.score - x.score);

  const best = scored[0];
  const second = scored[1];

  if (best.score < MATCH_CONFIDENT) {
    return { result: JSON.stringify({ status: 'not_found', message: 'address_not_matched' }) };
  }
  if (second && best.score - second.score < MATCH_AMBIG_GAP) {
    return {
      result: JSON.stringify({
        status: 'ambiguous',
        candidates: scored.slice(0, 3).map(s => ({ address_id: s.address.id, address: s.address.formatted })),
      }),
    };
  }

  await setServiceAddressMap(session.sessionId, { ...map, selectedAddressId: best.address.id });
  return {
    result: JSON.stringify({
      status: 'matched',
      address_id: best.address.id,
      address: best.address.formatted,
    }),
  };
}

export async function handleCreateAddress(
  session: HcpCallSessionRow,
  ctx: HcpContext,
  args: Record<string, unknown>,
): Promise<RetellFunctionResult> {
  if (!session.housecallproCustomerId) {
    return { result: 'error: no customer identified yet — identify or create the customer first' };
  }
  const street = (args.street as string | undefined)?.trim();
  const city = (args.city as string | undefined)?.trim();
  const state = (args.state as string | undefined)?.trim();
  const zip = (args.zip as string | undefined)?.trim();
  if (!street || !city || !state || !zip) {
    return { result: 'error: street, city, state and zip are required' };
  }

  try {
    const created = await createAddress(ctx, session.housecallproCustomerId, {
      street,
      street_line_2: (args.street_line_2 as string | undefined)?.trim() || undefined,
      city,
      state,
      zip,
      country: (args.country as string | undefined)?.trim() || 'US',
    });

    await appendAddressId(session.tenantId, session.housecallproCustomerId, created.id).catch(() => undefined);

    const lite = toAddressLite(created);
    const map = session.serviceAddressMap ?? { addresses: {}, selectedAddressId: null };
    map.addresses[created.id] = lite;
    map.selectedAddressId = created.id;
    await setServiceAddressMap(session.sessionId, map);

    console.log('[hcp] create_address', { sessionId: session.sessionId, addressId: created.id });
    return {
      result: JSON.stringify({
        status: 'created',
        address_id: created.id,
        address: lite.formatted || formatAddress({ street, city, state, zip }),
      }),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[hcp] create_address error', { sessionId: session.sessionId, error: msg });
    return { result: `error: could not create address — ${msg}` };
  }
}
