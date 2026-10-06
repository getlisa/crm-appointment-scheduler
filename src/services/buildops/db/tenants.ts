/**
 * Supabase queries for the buildops_tenants table.
 * Resolves tenant credentials (OAuth token, BuildOps tenant ID) from the inbound
 * phone number or the BuildOps tenant UUID — both are needed at call start and
 * during function-call dispatch.
 */

import { supabaseAdmin as supabase } from '../../../lib/supabase.js';
import type { ResolutionRow } from '../types.js';

/**
 * Looks up tenant credentials by the dialed (inbound) E.164 phone number.
 *
 * @param e164 - E.164 number of the inbound Retell line, e.g. `+18041234567`
 * @returns Tenant row with access_token, client credentials, and buildops_tenant_id, or null if the number is not configured
 */
export async function resolveByInboundNumber(e164: string): Promise<ResolutionRow | null> {
  const { data, error } = await supabase
    .from('buildops_tenants')
    .select('no, client_id, client_secret, access_token, buildops_tenant_id, email_to')
    .eq('no', e164)
    .single();

  if (error || !data) return null;

  return {
    no: data.no,
    client_id: data.client_id,
    client_secret: data.client_secret,
    access_token: data.access_token,
    buildops_tenant_id: data.buildops_tenant_id,
    email_to: (data.email_to as string[] | null) ?? [],
  };
}

/**
 * Looks up tenant credentials by the BuildOps tenant UUID.
 * Used during function-call dispatch where the session already has tenantId but needs a fresh token.
 *
 * @param buildopsTenantId - BuildOps internal tenant UUID stored in buildops_inbound_calls.tenant_id
 * @returns Tenant row with access_token and credentials, or null if not found
 */
export async function resolveByTenantId(buildopsTenantId: string): Promise<ResolutionRow | null> {
  const { data, error } = await supabase
    .from('buildops_tenants')
    .select('no, client_id, client_secret, access_token, buildops_tenant_id, email_to')
    .eq('buildops_tenant_id', buildopsTenantId)
    .single();

  if (error || !data) return null;

  return {
    no: data.no,
    client_id: data.client_id,
    client_secret: data.client_secret,
    access_token: data.access_token,
    buildops_tenant_id: data.buildops_tenant_id,
    email_to: (data.email_to as string[] | null) ?? [],
  };
}
