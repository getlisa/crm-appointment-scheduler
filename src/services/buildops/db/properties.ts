import { supabaseAdmin as supabase } from '../../../lib/supabase.js';
import type { PropertyRow, AddressObj } from '../types.js';

function mapRow(row: Record<string, unknown>): PropertyRow {
  return {
    id: row.id as string,
    name: row.name as string | null,
    phonePrimary: row.phone_primary as string | null,
    customerId: row.customer_id as string,
    address: (row.address as AddressObj) ?? {},
  };
}

export async function getPropertiesForCustomer(customerId: string): Promise<PropertyRow[]> {
  const { data, error } = await supabase
    .from('property')
    .select('*')
    .eq('customer_id', customerId);

  if (error || !data) return [];
  return (data as Record<string, unknown>[]).map(mapRow);
}

export async function getPropertyById(propertyId: string): Promise<PropertyRow | null> {
  const { data, error } = await supabase
    .from('property')
    .select('*')
    .eq('id', propertyId)
    .single();

  if (error || !data) return null;
  return mapRow(data as Record<string, unknown>);
}
