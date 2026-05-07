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

// Primary lookup: inbound phone → representative (covers both cell and landline)
export async function findRepsByPhone(
  tenantId: string,
  phoneLast10: string,
): Promise<RepresentativeRow[]> {
  const { data, error } = await supabase
    .from('representatives')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .or(
      `normalized_cell_phone.eq.${phoneLast10},normalized_landline_phone.eq.${phoneLast10}`,
    );

  if (error || !data) return [];
  return (data as Record<string, unknown>[]).map(mapRow);
}

export async function getRepsByCustomer(
  tenantId: string,
  customerId: string,
): Promise<RepresentativeRow[]> {
  const { data, error } = await supabase
    .from('representatives')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('customer_id', customerId)
    .eq('is_active', true);

  if (error || !data) return [];
  return (data as Record<string, unknown>[]).map(mapRow);
}

export async function getRepsByProperty(
  tenantId: string,
  propertyId: string,
): Promise<RepresentativeRow[]> {
  const { data, error } = await supabase
    .from('representatives')
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
  propertyId: string;
  firstName: string;
  lastName: string;
  cellPhone?: string | null;
  landlinePhone?: string | null;
  email?: string | null;
}

export async function createRepresentative(
  input: CreateRepInput,
): Promise<RepresentativeRow | null> {
  if (!input.cellPhone && !input.landlinePhone) {
    throw new Error('At least one of cellPhone or landlinePhone is required.');
  }

  const normalize = (phone: string) => phone.replace(/\D/g, '').slice(-10);

  const { data, error } = await supabase
    .from('representatives')
    .insert({
      tenant_id: input.tenantId,
      customer_id: input.customerId,
      property_id: input.propertyId,
      first_name: input.firstName,
      last_name: input.lastName,
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
