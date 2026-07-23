/**
 * Supabase queries for the housecallpro_tokens table (the HCP tenant anchor).
 * Resolves the tenant's API key + Retell agent from the dialed number (`no`, PK)
 * at call start, or from the tenant UUID during function-call dispatch.
 */

import { supabaseAdmin as supabase } from '../../../lib/supabase.js';
import type { HcpTokenRow } from '../types.js';

const SELECT = 'no, tenant_id, api_key, agent_id, emailto, ccMail';

function mapRow(row: Record<string, unknown>): HcpTokenRow {
  return {
    no: row.no as string,
    tenantId: row.tenant_id as string,
    apiKey: row.api_key as string,
    agentId: (row.agent_id as string | null) ?? null,
    emailTo: (row.emailto as string | null) ?? null,
    ccMail: (row.ccMail as string | null) ?? null,
  };
}

/**
 * Looks up a tenant's HCP credentials by the dialed (inbound) number.
 *
 * @param no - The Retell number that was called (housecallpro_tokens PK)
 */
export async function resolveByInboundNumber(no: string): Promise<HcpTokenRow | null> {
  const { data, error } = await supabase
    .from('housecallpro_tokens')
    .select(SELECT)
    .eq('no', no)
    .single();

  if (error || !data) return null;
  return mapRow(data as Record<string, unknown>);
}

/**
 * Looks up a tenant's HCP credentials by tenant UUID.
 * Used mid-call when the session already carries tenant_id.
 */
export async function resolveByTenantId(tenantId: string): Promise<HcpTokenRow | null> {
  const { data, error } = await supabase
    .from('housecallpro_tokens')
    .select(SELECT)
    .eq('tenant_id', tenantId)
    .single();

  if (error || !data) return null;
  return mapRow(data as Record<string, unknown>);
}
