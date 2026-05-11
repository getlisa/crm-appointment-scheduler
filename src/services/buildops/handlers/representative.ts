import { getCustomerById, appendToCustomerAllNumbers } from '../db/customers.js';
import { createRepresentative } from '../db/representatives.js';
import { createCustomerRepresentative } from '../client.js';
import type { InboundCallRow, BuildOpsContext, RetellFunctionResult } from '../types.js';

// ── Save caller's current phone number as a representative on the account ─────

export async function handleSaveCallerNumber(
  session: InboundCallRow,
  ctx: BuildOpsContext,
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

  let savedRep;
  try {
    savedRep = await createRepresentative({
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

  // Append to customer's all_numbers so future lookups work immediately
  const resolvedName = savedRep ? `${savedRep.firstName} ${savedRep.lastName}` : `${firstName} ${lastName}`;
  appendToCustomerAllNumbers(
    session.tenantId,
    customer.id,
    phoneToSave,
    `rep:cellPhone:${resolvedName}`,
  ).catch(err => console.error('[representative] all_numbers append failed:', err));

  // Mirror to BuildOps API (best-effort — don't fail the call if this errors)
  createCustomerRepresentative(ctx, customer.buildopsCustomerId, {
    firstName,
    lastName,
    cellPhone: phoneToSave,
  }).catch(err => console.error('[representative] BuildOps API sync failed:', err));

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
  ctx: BuildOpsContext,
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

  // 1. Create in BuildOps API (blocking — rep must exist in the real account)
  let buildopsRep: { id: string };
  try {
    buildopsRep = await createCustomerRepresentative(ctx, customer.buildopsCustomerId, {
      firstName,
      lastName,
      cellPhone: phone ?? null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { result: `error: could not create representative in BuildOps — ${msg}` };
  }

  // 2. Mirror to local Supabase (best-effort)
  createRepresentative({
    tenantId: session.tenantId,
    customerId: customer.id,
    propertyId: propertyId ?? null,
    firstName,
    lastName,
    cellPhone: phone ?? null,
    email: email ?? null,
  }).catch(err => console.error('[representative] local DB write failed:', err));

  // 3. Append phone to all_numbers so future lookups find them immediately (best-effort)
  if (phone) {
    appendToCustomerAllNumbers(
      session.tenantId,
      customer.id,
      phone,
      `rep:cellPhone:${firstName} ${lastName}`,
    ).catch(err => console.error('[representative] all_numbers append failed:', err));
  }

  return {
    result: JSON.stringify({
      status: 'added',
      representative_id: buildopsRep.id,
      name: `${firstName} ${lastName}`.trim(),
    }),
  };
}
