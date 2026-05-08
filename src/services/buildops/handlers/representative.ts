import { getCustomerById } from '../db/customers.js';
import { createRepresentative } from '../db/representatives.js';
import type { InboundCallRow, RetellFunctionResult } from '../types.js';

// ── Save caller's current phone number as a representative on the account ─────

export async function handleSaveCallerNumber(
  session: InboundCallRow,
  args: Record<string, unknown>,
): Promise<RetellFunctionResult> {
  if (!session.matchedCustomerId) {
    return { result: 'error: no customer confirmed — complete customer lookup first' };
  }

  // Allow the caller to specify a different number explicitly; default to their own
  const phoneToSave = (args.phone_number as string | undefined) || session.caller;
  if (!phoneToSave) {
    return { result: 'error: no phone number available to save' };
  }

  const customer = await getCustomerById(session.tenantId, session.matchedCustomerId);
  if (!customer) {
    return { result: 'error: could not load customer record' };
  }

  const firstName = (args.first_name as string | undefined) ?? 'Unknown';
  const lastName = (args.last_name as string | undefined) ?? '';

  try {
    await createRepresentative({
      tenantId: session.tenantId,
      customerId: customer.id,
      firstName,
      lastName,
      cellPhone: phoneToSave,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { result: `error: could not save phone number — ${msg}` };
  }

  return {
    result: JSON.stringify({
      status: 'saved',
      phone: phoneToSave,
      message: 'Phone number saved to your account.',
    }),
  };
}

// ── Add a new named contact/representative to the customer account ────────────

export async function handleAddRepresentative(
  session: InboundCallRow,
  args: Record<string, unknown>,
): Promise<RetellFunctionResult> {
  if (!session.matchedCustomerId) {
    return { result: 'error: no customer confirmed — complete customer lookup first' };
  }

  const firstName = args.first_name as string | undefined;
  const lastName = args.last_name as string | undefined;
  const phone = args.phone as string | undefined;
  const email = args.email as string | undefined;
  const propertyId = args.property_id as string | undefined;

  if (!firstName || !lastName) {
    return { result: 'error: first_name and last_name are required' };
  }
  if (!phone && !email) {
    return { result: 'error: at least one of phone or email is required' };
  }

  const customer = await getCustomerById(session.tenantId, session.matchedCustomerId);
  if (!customer) {
    return { result: 'error: could not load customer record' };
  }

  let rep;
  try {
    rep = await createRepresentative({
      tenantId: session.tenantId,
      customerId: customer.id,
      propertyId: propertyId ?? null,
      firstName,
      lastName,
      cellPhone: phone ?? null,
      email: email ?? null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { result: `error: could not create representative — ${msg}` };
  }

  return {
    result: JSON.stringify({
      status: 'added',
      representative_id: rep?.id ?? null,
      name: `${firstName} ${lastName}`.trim(),
    }),
  };
}
