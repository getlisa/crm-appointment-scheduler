import { supabaseAdmin as supabase } from '../../../lib/supabase.js';
import type { PricebookRow } from '../types.js';

function mapRow(row: Record<string, unknown>): PricebookRow {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    productId: row.product_id as string,
    name: row.name as string,
    description: row.description as string | null,
    unitPrice: row.unit_price as number | null,
    taxable: row.taxable as boolean,
    isActive: row.is_active as boolean,
  };
}

export async function searchPricebook(
  tenantId: string,
  searchTerm: string,
  limit = 10,
): Promise<PricebookRow[]> {
  const { data, error } = await supabase
    .from('pricebook_items')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .or(`name.ilike.%${searchTerm}%,description.ilike.%${searchTerm}%`)
    .limit(limit);

  if (error || !data) return [];
  return (data as Record<string, unknown>[]).map(mapRow);
}

export async function getPricebookItem(
  tenantId: string,
  productId: string,
): Promise<PricebookRow | null> {
  const { data, error } = await supabase
    .from('pricebook_items')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('product_id', productId)
    .single();

  if (error || !data) return null;
  return mapRow(data as Record<string, unknown>);
}
