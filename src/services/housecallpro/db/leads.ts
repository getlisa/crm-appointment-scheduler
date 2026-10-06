/**
 * Supabase queries for the housecallpro_leads cache.
 * A row is written immediately after a lead is created in HCP (via create_lead).
 */

import { supabaseAdmin as supabase } from '../../../lib/supabase.js';

export interface InsertLeadInput {
  housecallproLeadId: string;
  leadNumber?: number | null;
  housecallproCustomerId: string;
  addressId?: string | null;
  jobTypeUuid?: string | null;
  sessionId?: string | null;
  /** The caller's requested timeframe — our record only, never sent to HCP. */
  requestedStart?: string | null;
  requestedEnd?: string | null;
}

/**
 * Inserts (upserts on tenant_id + housecallpro_lead_id) a created lead into housecallpro_leads.
 *
 * @param tenantId - HCP tenant UUID
 * @param lead     - Created lead fields
 */
export async function insertLead(tenantId: string, lead: InsertLeadInput): Promise<void> {
  const { error } = await supabase.from('housecallpro_leads').upsert(
    {
      tenant_id: tenantId,
      housecallpro_lead_id: lead.housecallproLeadId,
      lead_number: lead.leadNumber ?? null,
      housecallpro_customer_id: lead.housecallproCustomerId,
      address_id: lead.addressId ?? null,
      job_type_uuid: lead.jobTypeUuid ?? null,
      session_id: lead.sessionId ?? null,
      requested_start: lead.requestedStart ?? null,
      requested_end: lead.requestedEnd ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'tenant_id,housecallpro_lead_id' },
  );
  if (error) throw new Error(`insertLead: ${error.message}`);
}

/** Fetches a cached lead by HCP lead id, scoped to the tenant. */
export async function getLeadByHcpId(
  tenantId: string,
  housecallproLeadId: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase
    .from('housecallpro_leads')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('housecallpro_lead_id', housecallproLeadId)
    .single();

  if (error || !data) return null;
  return data as Record<string, unknown>;
}
