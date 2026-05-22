/**
 * Supabase queries for the buildops_representatives table.
 * Representatives are customer contacts whose phone numbers feed into the customer's
 * all_numbers array during sync. New reps can be created mid-call when a new number
 * is detected and the caller provides their name.
 */

import { supabaseAdmin as supabase } from '../../../lib/supabase.js';
import type { RepresentativeRow } from '../types.js';

function mapRow(row: Record<string, unknown>): RepresentativeRow {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    customerId: row.customer_id as string,
    propertyId: row.property_id as string,
    firstName: row.first_name as string,
    lastName: row.last_name as string,
    cellPhone: row.cell_phone as string | null,
    landlinePhone: row.landline_phone as string | null,
    normalizedCellPhone: row.normalized_cell_phone as string | null,
    normalizedLandlinePhone: row.normalized_landline_phone as string | null,
    email: row.email as string | null,
    isActive: row.is_active as boolean,
    isDoNotCall: row.is_do_not_call as boolean,
    isEmailOptOut: row.is_email_opt_out as boolean,
    isSmsOptOut: row.is_sms_opt_out as boolean,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    version: row.version as number,
  };
}

/**
 * Finds active representatives whose normalized cell or landline phone matches.
 *
 * @param tenantId    - BuildOps tenant UUID
 * @param phoneLast10 - Normalized 10-digit phone
 * @returns Matching representatives (may belong to different customers)
 */
export async function findRepsByPhone(
  tenantId: string,
  phoneLast10: string,
): Promise<RepresentativeRow[]> {
  const { data, error } = await supabase
    .from('buildops_representatives')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .or(
      `normalized_cell_phone.eq.${phoneLast10},normalized_landline_phone.eq.${phoneLast10}`,
    );

  if (error || !data) return [];
  return (data as Record<string, unknown>[]).map(mapRow);
}

/**
 * Returns all active representatives for a customer.
 *
 * @param tenantId   - BuildOps tenant UUID
 * @param customerId - Our buildops_customers.id (UUID)
 * @returns Array of RepresentativeRow
 */
export async function getRepsByCustomer(
  tenantId: string,
  customerId: string,
): Promise<RepresentativeRow[]> {
  const { data, error } = await supabase
    .from('buildops_representatives')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('customer_id', customerId)
    .eq('is_active', true);

  if (error || !data) return [];
  return (data as Record<string, unknown>[]).map(mapRow);
}

/**
 * Returns all active representatives associated with a specific property.
 *
 * @param tenantId   - BuildOps tenant UUID
 * @param propertyId - BuildOps property UUID
 * @returns Array of RepresentativeRow
 */
export async function getRepsByProperty(
  tenantId: string,
  propertyId: string,
): Promise<RepresentativeRow[]> {
  const { data, error } = await supabase
    .from('buildops_representatives')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('property_id', propertyId)
    .eq('is_active', true);

  if (error || !data) return [];
  return (data as Record<string, unknown>[]).map(mapRow);
}

export interface CreateRepInput {
  tenantId: string;
  customerId: string;
  propertyId?: string | null;
  firstName: string;
  lastName: string;
  cellPhone?: string | null;
  landlinePhone?: string | null;
  email?: string | null;
}

async function resolveUniqueName(
  customerId: string,
  firstName: string,
  lastName: string,
): Promise<{ firstName: string; lastName: string }> {
  const baseLast = lastName.trim();

  const { data } = await supabase
    .from('buildops_representatives')
    .select('first_name, last_name')
    .eq('customer_id', customerId)
    .ilike('first_name', firstName.trim())
    .ilike('last_name', `${baseLast}%`);

  if (!data || data.length === 0) return { firstName: firstName.trim(), lastName: baseLast };

  // Collect existing numeric suffixes for this base last name
  const suffixRe = new RegExp(`^${baseLast}(\\d*)$`, 'i');
  const usedNumbers = new Set<number>();
  for (const row of data as { first_name: string; last_name: string }[]) {
    const match = row.last_name.match(suffixRe);
    if (match) usedNumbers.add(match[1] === '' ? 1 : parseInt(match[1], 10));
  }

  if (!usedNumbers.has(1)) return { firstName: firstName.trim(), lastName: baseLast };

  let n = 2;
  while (usedNumbers.has(n)) n++;
  return { firstName: firstName.trim(), lastName: `${baseLast}${n}` };
}

/**
 * Inserts a new representative row into buildops_representatives.
 * If a rep with the same first+last name already exists for this customer, the
 * last name is auto-suffixed with an incrementing number to keep source tags unique
 * (e.g. "Smith" → "Smith2" → "Smith3").
 *
 * @param input - New rep data including tenantId, customerId, name, and at least one phone
 * @returns The inserted RepresentativeRow, or null if the insert failed
 * @throws If neither cellPhone nor landlinePhone is provided
 */
export async function createRepresentative(
  input: CreateRepInput,
): Promise<RepresentativeRow | null> {
  if (!input.cellPhone && !input.landlinePhone) {
    throw new Error('At least one of cellPhone or landlinePhone is required.');
  }

  const normalize = (phone: string) => phone.replace(/\D/g, '').slice(-10);

  const { firstName, lastName } = await resolveUniqueName(
    input.customerId,
    input.firstName,
    input.lastName,
  );

  const { data, error } = await supabase
    .from('buildops_representatives')
    .insert({
      tenant_id: input.tenantId,
      customer_id: input.customerId,
      property_id: input.propertyId ?? null,
      first_name: firstName,
      last_name: lastName,
      cell_phone: input.cellPhone ?? null,
      landline_phone: input.landlinePhone ?? null,
      normalized_cell_phone: input.cellPhone ? normalize(input.cellPhone) : null,
      normalized_landline_phone: input.landlinePhone ? normalize(input.landlinePhone) : null,
      email: input.email ?? null,
    })
    .select()
    .single();

  if (error || !data) return null;
  return mapRow(data as Record<string, unknown>);
}
