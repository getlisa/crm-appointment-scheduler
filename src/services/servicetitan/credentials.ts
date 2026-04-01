import { supabaseAdmin } from '../../lib/supabase.js';
import type { ServiceTitanAuthCredentials } from './types.js';

export async function saveTenantCredentials(params: {
  tenantId: number;
  clientId: string;
  clientSecret: string;
  appKey: string;
  timezone: string;
}) {
  const { error } = await supabaseAdmin.from('servicetitan_tenants').upsert(
    {
      tenant_id: params.tenantId,
      client_id: params.clientId,
      client_secret: params.clientSecret,
      app_key: params.appKey,
      timezone: params.timezone,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'tenant_id' }
  );

  if (error) {
    throw new Error(`Failed to save ServiceTitan credentials: ${error.message}`);
  }
}

export async function loadTenantCredentials(tenantId: number): Promise<{
  credentials: ServiceTitanAuthCredentials;
  timezone: string;
}> {
  const { data, error } = await supabaseAdmin
    .from('servicetitan_tenants')
    .select('tenant_id,client_id,client_secret,app_key,timezone')
    .eq('tenant_id', tenantId)
    .single();

  if (error || !data) {
    throw new Error(`ServiceTitan tenant not configured for tenantId=${tenantId}`);
  }

  return {
    credentials: {
      tenantId: data.tenant_id,
      clientId: data.client_id,
      clientSecret: data.client_secret,
      appKey: data.app_key,
    },
    timezone: data.timezone,
  };
}

export async function loadDefaultTenantCredentials(): Promise<{
  credentials: ServiceTitanAuthCredentials;
  timezone: string;
}> {
  const { data, error } = await supabaseAdmin
    .from('servicetitan_tenants')
    .select('tenant_id,client_id,client_secret,app_key,timezone')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    throw new Error('ServiceTitan tenant not configured. Connect ServiceTitan first.');
  }

  return {
    credentials: {
      tenantId: data.tenant_id,
      clientId: data.client_id,
      clientSecret: data.client_secret,
      appKey: data.app_key,
    },
    timezone: data.timezone,
  };
}
