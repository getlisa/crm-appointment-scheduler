/**
 * Supabase queries for the buildops_departments table.
 * Departments are not queried during live calls — the job department is set via
 * the hardcoded DEFAULT_DEPARTMENT_ID constant in handlers/job.ts.
 * This module is available for admin tooling and config verification.
 */

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

/**
 * Returns all active departments for a tenant, ordered by tag_name.
 *
 * @param tenantId - BuildOps tenant UUID
 * @returns Array of DepartmentRow (empty if none found)
 */
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
