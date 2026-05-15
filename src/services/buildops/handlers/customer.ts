/**
 * Retell function handlers for customer confirmation and property resolution.
 * confirm_customer: finalises which account the caller belongs to after multiple matches.
 * get_properties_for_customer: lists all service locations so the agent can present them.
 * match_property: fuzzy-matches a spoken address to a BuildOps property UUID.
 */

import { getCustomerById } from '../db/customers.js';
import { getPropertiesByIds } from '../db/properties.js';
import { setMatchedCustomer, setCallStatus } from '../db/inbound-calls.js';

import { tokenSetRatio, normalizeAddress, pickPrimaryAddress } from '../fuzzy-search.js';
import type { InboundCallRow, PropertyRow, RetellFunctionResult } from '../types.js';

export async function handleConfirmCustomer(
  session: InboundCallRow,
  args: Record<string, unknown>,
): Promise<RetellFunctionResult> {
  const candidateId = args.candidate_id as string | undefined;
  if (!candidateId) return { result: 'error: candidate_id is required' };

  const customer = await getCustomerById(session.tenantId, candidateId);
  if (!customer) return { result: 'error: customer not found for this tenant' };

  await setMatchedCustomer(session.retellCallId, customer.id);
  const properties = await getPropertiesByIds(customer.propertyIds);
  const primary = pickPrimaryAddress(customer, properties);
  return {
    result: JSON.stringify({
      status: 'confirmed',
      customer: {
        id: customer.id,
        name: customer.name,
        address: primary.address,
        addressSource: primary.addressSource,
      },
      property_count: properties.length,
      ...(properties.length === 1 ? { property_id: properties[0].id } : {}),
    }),
  };
}

export async function handleGetProperties(
  session: InboundCallRow,
): Promise<RetellFunctionResult> {
  if (!session.matchedCustomerId) {
    return { result: 'error: no customer confirmed yet — call confirm_customer first' };
  }

  const customer = await getCustomerById(session.tenantId, session.matchedCustomerId);
  if (!customer) return { result: 'error: customer session invalid' };

  const properties = await getPropertiesByIds(customer.propertyIds);
  if (properties.length === 0) {
    return {
      result: JSON.stringify({
        status: 'no_properties',
        message: 'No service locations found for this customer.',
      }),
    };
  }

  return {
    result: JSON.stringify({
      status: 'ok',
      properties: properties.map((p: PropertyRow) => ({
        id: p.id,
        name: p.name,
        address: p.address,
      })),
    }),
  };
}

// ── Match spoken address to one of the customer's properties ──────────────────

const MATCH_CONFIDENT = 0.60;
const MATCH_AMBIG_GAP = 0.15;

function scoreProperty(spoken: string, prop: PropertyRow): number {
  const addr = prop.address;
  const line1Score = addr.line1
    ? tokenSetRatio(normalizeAddress(spoken), normalizeAddress(addr.line1))
    : 0;
  const cityBonus = addr.city && spoken.toLowerCase().includes(addr.city.toLowerCase()) ? 0.1 : 0;
  const zipBonus  = addr.zip  && spoken.includes(addr.zip) ? 0.1 : 0;
  return Math.min(line1Score + cityBonus + zipBonus, 1);
}

export async function handleMatchProperty(
  session: InboundCallRow,
  args: Record<string, unknown>,
): Promise<RetellFunctionResult> {
  if (!session.matchedCustomerId) {
    return { result: 'error: no confirmed customer — call confirm_customer first' };
  }

  const spokenAddress = (args.spoken_address as string | undefined)?.trim();
  if (!spokenAddress) return { result: 'error: spoken_address is required' };

  const customer = await getCustomerById(session.tenantId, session.matchedCustomerId);
  if (!customer) return { result: 'error: customer session invalid' };

  const properties = await getPropertiesByIds(customer.propertyIds);
  if (properties.length === 0) {
    return { result: JSON.stringify({ status: 'no_properties' }) };
  }

  const scored = properties
    .map((p: PropertyRow) => ({ property: p, score: scoreProperty(spokenAddress, p) }))
    .sort((a: { score: number }, b: { score: number }) => b.score - a.score);

  const best   = scored[0];
  const second = scored[1];

  if (best.score < MATCH_CONFIDENT) {
    await setCallStatus(session.retellCallId, 'handed_off');
    return {
      result: JSON.stringify({
        status: 'not_found',
        identified: false,
        message: 'address_not_matched',
      }),
    };
  }

  if (second && best.score - second.score < MATCH_AMBIG_GAP) {
    return {
      result: JSON.stringify({
        status: 'ambiguous',
        candidates: scored.slice(0, 3).map((s: { property: PropertyRow }) => ({
          id: s.property.id,
          address: s.property.address,
        })),
      }),
    };
  }

  return {
    result: JSON.stringify({
      status: 'matched',
      property_id: best.property.id,
      address: best.property.address,
    }),
  };
}
