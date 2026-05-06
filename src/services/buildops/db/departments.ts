import { supabaseAdmin as supabase } from '../../../lib/supabase.js';
import type { DepartmentRow } from '../types.js';

function mapRow(row: Record<string, unknown>): DepartmentRow {
  return {
    id: row.id as string,
    tagName: row.tag_name as string,
    tenantId: row.tenant_id as string,
    phonePrimary: row.phone_primary as string | null,
    email: row.email as string | null,
    isActive: row.is_active as boolean,
  };
}

export async function getDepartments(tenantId: string): Promise<DepartmentRow[]> {
  const { data, error } = await supabase
    .from('departments')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .order('tag_name');

  if (error || !data) return [];
  return (data as Record<string, unknown>[]).map(mapRow);
}
