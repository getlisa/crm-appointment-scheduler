import { supabaseAdmin as supabase } from '../../../lib/supabase.js';
import type { ResolutionRow } from '../types.js';

export async function resolveByInboundNumber(e164: string): Promise<ResolutionRow | null> {
  const { data, error } = await supabase
    .from('inbound_no_to_tenant_resolution')
    .select('no, client_id, client_secret, access_token, buildops_tenant_id')
    .eq('no', e164)
    .single();

  if (error || !data) return null;

  return {
    no: data.no,
    client_id: data.client_id,
    client_secret: data.client_secret,
    access_token: data.access_token,
    buildops_tenant_id: data.buildops_tenant_id,
  };
}
