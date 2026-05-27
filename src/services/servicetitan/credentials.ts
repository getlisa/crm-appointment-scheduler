import { supabaseAdmin } from '../../lib/supabase.js';
import type { ServiceTitanAuthCredentials } from './types.js';

export async function saveTenantCredentials(params: {
  tenantId: number;
  clientId: string;
  clientSecret: string;
  appKey: string;
  timezone: string;
  campaignId?: string;
  fallbackTechnicianId?: number;
}) {
  const row: Record<string, unknown> = {
    tenant_id: params.tenantId,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    app_key: params.appKey,
    timezone: params.timezone,
    updated_at: new Date().toISOString(),
  };
  if (params.campaignId !== undefined) row.campaign_id = params.campaignId;
  if (params.fallbackTechnicianId !== undefined) row.fallback_technician_id = params.fallbackTechnicianId;

  const { error } = await supabaseAdmin
    .from('servicetitan_tenants')
    .upsert(row, { onConflict: 'tenant_id' });

  if (error) {
    throw new Error(`Failed to save ServiceTitan credentials: ${error.message}`);
  }
}

export type TenantConfig = {
  credentials: ServiceTitanAuthCredentials;
  timezone: string;
  campaignId: string | null;
  fallbackTechnicianId: number | null;
  lastSyncAt: string | null;
  contactsSyncedAt: string | null;
};

export async function loadTenantCredentials(tenantId: number): Promise<TenantConfig> {
  const { data, error } = await supabaseAdmin
    .from('servicetitan_tenants')
    .select('tenant_id,client_id,client_secret,app_key,timezone,campaign_id,fallback_technician_id,last_sync_at,contacts_synced_at')
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
    campaignId: data.campaign_id ?? null,
    fallbackTechnicianId: data.fallback_technician_id ?? null,
    lastSyncAt: data.last_sync_at ?? null,
    contactsSyncedAt: data.contacts_synced_at ?? null,
  };
}

export async function updateContactsSyncedAt(tenantId: number, syncedAt: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('servicetitan_tenants')
    .update({ contacts_synced_at: syncedAt })
    .eq('tenant_id', tenantId);

  if (error) throw new Error(`Failed to update contacts_synced_at: ${error.message}`);
}

export async function updateLastSyncAt(tenantId: number, syncedAt: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('servicetitan_tenants')
    .update({ last_sync_at: syncedAt })
    .eq('tenant_id', tenantId);

  if (error) throw new Error(`Failed to update last_sync_at: ${error.message}`);
}
