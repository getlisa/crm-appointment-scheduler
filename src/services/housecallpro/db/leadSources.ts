/**
 * Supabase lookup for HCP lead-source attribution.
 *
 * The number the customer originally dialed (an HCP tracking line, surfaced to
 * the call session as `to_number` / `lead_source_number`) is mapped here to the
 * real HCP lead source. book_job / create_customer use the result to stamp
 * `lead_source` on the job / customer instead of a hardcoded value.
 */

import { supabaseAdmin as supabase } from '../../../lib/supabase.js';
import { normalizePhoneLast10 } from '../fuzzy-search.js';

export interface LeadSource {
  leadSourceId: string | null;
  leadName: string | null;
}

function mapRow(row: Record<string, unknown>): LeadSource {
  return {
    leadSourceId: (row.lead_source_id as string | null) ?? null,
    leadName: (row.lead_name as string | null) ?? null,
  };
}

/**
 * Resolves the lead source for a dialed tracking line.
 *
 * Tries an exact match on `lead_phone_no` first (whatever format the table
 * stores), then falls back to matching the last 10 digits so an E.164 vs local
 * mismatch (e.g. "+17476771558" vs "7476771558") still resolves.
 *
 * @param phone - the dialed line (session.toNumber / lead_source_number)
 * @returns the lead source, or null when phone is empty or nothing matches
 */
export async function resolveLeadSource(phone: string | null | undefined): Promise<LeadSource | null> {
  const trimmed = phone?.trim();
  if (!trimmed) return null;

  const exact = await supabase
    .from('housecallpro_lead_sources')
    .select('lead_source_id, lead_name')
    .eq('lead_phone_no', trimmed)
    .maybeSingle();
  if (exact.data) return mapRow(exact.data as Record<string, unknown>);

  const last10 = normalizePhoneLast10(trimmed);
  if (last10.length < 10) return null;

  const fuzzy = await supabase
    .from('housecallpro_lead_sources')
    .select('lead_source_id, lead_name')
    .ilike('lead_phone_no', `%${last10}`)
    .limit(1);
  if (fuzzy.data && fuzzy.data.length > 0) return mapRow(fuzzy.data[0] as Record<string, unknown>);

  return null;
}
