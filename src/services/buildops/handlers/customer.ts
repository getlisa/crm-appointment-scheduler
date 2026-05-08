import { getCustomerById } from '../db/customers.js';
import { getPropertiesForCustomer } from '../db/properties.js';
import { setMatchedCustomer } from '../db/inbound-calls.js';
import { tokenSetRatio, normalizeAddress } from '../fuzzy-search.js';
import type { InboundCallRow, PropertyRow, RetellFunctionResult } from '../types.js';

export async function handleConfirmCustomer(
  session: InboundCallRow,
  args: Record<string, unknown>,
): Promise<RetellFunctionResult> {
  const candidateId = args.candidate_id as string | undefined;
  if (!candidateId) {
    return { result: 'error: candidate_id is required' };
  }

  const customer = await getCustomerById(session.tenantId, candidateId);
  if (!customer) {
    return { result: 'error: customer not found for this tenant' };
  }

  await setMatchedCustomer(session.retellCallId, customer.id);
  return {
    result: JSON.stringify({
      status: 'confirmed',
      customer: {
        id: customer.id,
        name: customer.name,
        address: customer.addresses?.[0] ?? null,
      },
    }),
  };
}

export async function handleGetProperties(
  session: InboundCallRow,
): Promise<RetellFunctionResult> {
  if (!session.matchedCustomerId) {
    return { result: 'error: no customer confirmed yet — call confirm_customer first' };
  }

  const properties = await getPropertiesForCustomer(session.matchedCustomerId);

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
      properties: properties.map(p => ({
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
  if (!spokenAddress) {
    return { result: 'error: spoken_address is required' };
  }

  const properties = await getPropertiesForCustomer(session.matchedCustomerId);
  if (properties.length === 0) {
    return { result: JSON.stringify({ status: 'no_properties' }) };
  }

  const scored = properties
    .map((p: PropertyRow) => ({ property: p, score: scoreProperty(spokenAddress, p) }))
    .sort((a, b) => b.score - a.score);

  const best   = scored[0];
  const second = scored[1];

  if (best.score < MATCH_CONFIDENT) {
    return {
      result: JSON.stringify({
        status: 'no_match',
        spoken: spokenAddress,
        candidates: scored.slice(0, 3).map(s => ({ id: s.property.id, address: s.property.address })),
      }),
    };
  }

  if (second && best.score - second.score < MATCH_AMBIG_GAP) {
    return {
      result: JSON.stringify({
        status: 'ambiguous',
        candidates: scored.slice(0, 3).map(s => ({ id: s.property.id, address: s.property.address })),
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
