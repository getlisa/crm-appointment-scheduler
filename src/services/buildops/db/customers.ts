import { supabaseAdmin as supabase } from '../../../lib/supabase.js';
import type { CustomerRow, FuzzyQuery, AddressObj } from '../types.js';

function mapRow(row: Record<string, unknown>): CustomerRow {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    buildopsCustomerId: row.buildops_customer_id as string,
    name: row.name as string,
    phonePrimary: row.phone_primary as string | null,
    phoneSecondary: row.phone_secondary as string | null,
    isActive: row.is_active as boolean,
    addresses: (row.addresses as AddressObj[]) ?? [],
    normalizedPhonePrimary: row.normalized_phone_primary as string | null,
    normalizedPhoneSecondary: row.normalized_phone_secondary as string | null,
  };
}

export async function findCustomersByPhone(
  tenantId: string,
  phoneLast10: string,
): Promise<CustomerRow[]> {
  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .or(
      `normalized_phone_primary.eq.${phoneLast10},normalized_phone_secondary.eq.${phoneLast10}`,
    );

  if (error || !data) return [];
  return (data as Record<string, unknown>[]).map(mapRow);
}

export async function getFuzzyCandidates(
  tenantId: string,
  query: FuzzyQuery,
): Promise<CustomerRow[]> {
  if (!query.name && !query.zip) return [];

  let q = supabase
    .from('customers')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .limit(200);

  if (query.name && query.zip) {
    // Both: name ilike AND zip match via JSONB addresses array
    q = q.ilike('name', `%${query.name}%`).filter(
      'addresses',
      'cs',
      JSON.stringify([{ zip: query.zip }]),
    );
  } else if (query.name) {
    q = q.ilike('name', `%${query.name}%`);
  } else if (query.zip) {
    q = q.filter('addresses', 'cs', JSON.stringify([{ zip: query.zip }]));
  }

  const { data, error } = await q;
  if (error || !data) return [];
  return (data as Record<string, unknown>[]).map(mapRow);
}

export async function getCustomerById(
  tenantId: string,
  customerId: string,
): Promise<CustomerRow | null> {
  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('id', customerId)
    .single();

  if (error || !data) return null;
  return mapRow(data as Record<string, unknown>);
}
