import { getCustomerById } from '../db/customers.js';
import { getPropertiesForCustomer } from '../db/properties.js';
import { setMatchedCustomer } from '../db/inbound-calls.js';
import type { InboundCallRow, RetellFunctionResult } from '../types.js';

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
