/**
 * Supabase lookup for HCP job types (housecallpro_job_types).
 *
 * The Retell agent picks a job type by NAME from a fixed enum on create_lead —
 * it never handles a uuid. This resolves that name to the tenant's `jbt_…` id,
 * which is sent to HCP verbatim as the top-level `job_type_uuid` on POST /leads.
 */

import { supabaseAdmin as supabase } from '../../../lib/supabase.js';

/**
 * Resolves an HCP job-type name to its uuid for a tenant.
 *
 * Match is exact but case-insensitive, and the incoming name is trimmed — the
 * agent's casing can drift from the seeded row. Seed rows with trimmed names:
 * some HCP accounts store job types with a trailing space (e.g. "Inspection ")
 * and that space is not matched here.
 *
 * @param tenantId - HCP tenant UUID
 * @param name     - job-type name as the agent sent it
 * @returns the `jbt_…` id, or null when the name is empty or unknown
 */
export async function resolveJobTypeUuid(
  tenantId: string,
  name: string | null | undefined,
): Promise<string | null> {
  const trimmed = name?.trim();
  if (!trimmed) return null;

  // `%` and `_` are ilike wildcards — escape so a name can only match itself.
  const pattern = trimmed.replace(/[\\%_]/g, c => `\\${c}`);

  const { data, error } = await supabase
    .from('housecallpro_job_types')
    .select('housecallpro_job_type_id')
    .eq('tenant_id', tenantId)
    .ilike('name', pattern)
    .limit(1);

  if (error || !data || data.length === 0) return null;
  return ((data[0] as Record<string, unknown>).housecallpro_job_type_id as string | null) ?? null;
}

/**
 * Reverse lookup: the job-type name for a stored uuid.
 * Used for the notification email, so Laura sees "Repair" and not a `jbt_…`.
 */
export async function resolveJobTypeName(
  tenantId: string,
  uuid: string | null | undefined,
): Promise<string | null> {
  const trimmed = uuid?.trim();
  if (!trimmed) return null;

  const { data, error } = await supabase
    .from('housecallpro_job_types')
    .select('name')
    .eq('tenant_id', tenantId)
    .eq('housecallpro_job_type_id', trimmed)
    .maybeSingle();

  if (error || !data) return null;
  return ((data as Record<string, unknown>).name as string | null) ?? null;
}
