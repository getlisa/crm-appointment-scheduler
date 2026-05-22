/**
 * Retell function handlers for saving and creating customer representatives.
 * save_caller_number: saves the caller's current phone to the account (best-effort API mirror).
 * add_representative: creates a new named contact in BuildOps and mirrors locally.
 * Both append the new phone to all_numbers immediately so future calls identify correctly.
 */

import { getCustomerById, appendToCustomerAllNumbers, appendToCustomerRepresentativeIds } from '../db/customers.js';
import { createRepresentative } from '../db/representatives.js';
import { appendToPropertyRepresentativeIds } from '../db/properties.js';
import { createCustomerRepresentative, createPropertyRepresentative } from '../client.js';
import type { InboundCallRow, BuildOpsContext, RetellFunctionResult } from '../types.js';

// ── Save caller's current phone number as a representative on the account ─────

/**
 * Saves the caller's phone number as a representative on the confirmed customer account.
 * Creates the rep in local DB (blocking), mirrors to BuildOps API (best-effort),
 * and appends the phone to all_numbers for immediate future-call recognition.
 *
 * @param session - Current call session (matchedCustomerId must be set)
 * @param ctx     - BuildOps API context
 * @param args    - Optional: phone_number (defaults to session.caller), first_name, last_name
 * @returns RetellFunctionResult — status: saved | error
 */
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
      customerId: customer.buildopsCustomerId,
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

/**
 * Creates a new named representative on the BuildOps customer account.
 * BuildOps API call is blocking (must succeed). Local DB write and all_numbers
 * update are best-effort and do not fail the function if they error.
 *
 * @param session - Current call session (matchedCustomerId must be set)
 * @param ctx     - BuildOps API context
 * @param args    - Required: first_name, last_name. Phone is taken from session.caller (from_number). Optional: email, property_id.
 * @returns RetellFunctionResult — status: added (with representative_id) | error
 */
export async function handleAddRepresentative(
  session: InboundCallRow,
  ctx: BuildOpsContext,
  args: Record<string, unknown>,
): Promise<RetellFunctionResult> {
  if (!session.matchedCustomerId) {
    return { result: 'error: no customer confirmed — complete customer lookup first' };
  }

  const firstName = (args.first_name as string | undefined)?.trim();
  const lastName  = (args.last_name  as string | undefined)?.trim();
  const phone = session.caller ?? undefined;
  const email = (args.email as string | undefined)?.trim() || undefined;
  const propertyId = args.property_id as string | undefined;

  if (!firstName || !lastName) {
    return { result: 'error: first_name and last_name are required' };
  }
  if (!propertyId) {
    return { result: 'error: property_id is required — pass the customer_property_id of the job being booked' };
  }

  const customer = await getCustomerById(session.tenantId, session.matchedCustomerId);
  if (!customer) {
    return { result: 'error: could not load customer record' };
  }

  // 1. Create in BuildOps API under the property (blocking — rep must exist in the real account)
  let buildopsRep: { id: string };
  try {
    buildopsRep = await createPropertyRepresentative(ctx, propertyId, {
      firstName,
      lastName,
      cellPhone: phone ?? null,
      email: email ?? null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { result: `error: could not create representative in BuildOps — ${msg}` };
  }

  // 2. Mirror to local Supabase; on success append rep ID to customer.representative_ids (best-effort)
  createRepresentative({
    tenantId: session.tenantId,
    customerId: customer.buildopsCustomerId,
    propertyId: propertyId ?? null,
    firstName,
    lastName,
    cellPhone: phone ?? null,
    email: email ?? null,
  }).then(supabaseRep => {
    if (supabaseRep) {
      appendToCustomerRepresentativeIds(session.tenantId, customer.id, supabaseRep.id)
        .catch(err => console.error('[representative] customer rep_ids append failed:', err));
    }
  }).catch(err => console.error('[representative] local DB write failed:', err));

  // 3. Append phone to all_numbers with property-encoded source (best-effort)
  if (phone) {
    appendToCustomerAllNumbers(
      session.tenantId,
      customer.id,
      phone,
      `rep:cellPhone:${firstName} ${lastName}:prop:${propertyId}`,
    ).catch(err => console.error('[representative] all_numbers append failed:', err));
  }

  // 4. Append rep ID to the property's representative_ids (best-effort)
  appendToPropertyRepresentativeIds(propertyId, buildopsRep.id)
    .catch(err => console.error('[representative] property rep_ids append failed:', err));

  return {
    result: JSON.stringify({
      status: 'added',
      representative_id: buildopsRep.id,
      name: `${firstName} ${lastName}`.trim(),
    }),
  };
}
