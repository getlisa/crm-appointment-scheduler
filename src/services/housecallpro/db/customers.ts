/**
 * Supabase queries for the housecallpro_customers cache.
 * Caller identification uses the generated `normalized_mobile` column; the
 * Scenario-A fuzzy lookup gathers candidates by name via trigram ILIKE.
 */

import { supabaseAdmin as supabase } from '../../../lib/supabase.js';
import type { HcpApiCustomer, HcpCustomerRow } from '../types.js';

function normalizeLast10(s: string | null | undefined): string | null {
  if (!s) return null;
  const d = s.replace(/\D/g, '').slice(-10);
  return d.length === 10 ? d : null;
}

function mapRow(row: Record<string, unknown>): HcpCustomerRow {
  const firstName = (row.first_name as string | null) ?? null;
  const lastName = (row.last_name as string | null) ?? null;
  const normalizedMobile =
    (row.normalized_mobile as string | null) ?? normalizeLast10(row.mobile_number as string | null);
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    housecallproCustomerId: row.housecallpro_customer_id as string,
    firstName,
    lastName,
    name: [firstName, lastName].filter(Boolean).join(' ').trim(),
    companyName: (row.company_name as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    mobileNumber: (row.mobile_number as string | null) ?? null,
    normalizedMobile,
    allNumbers: normalizedMobile ? [normalizedMobile] : [],
    notificationsEnabled: (row.notifications_enabled as boolean | null) ?? false,
    leadSource: (row.lead_source as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    tags: (row.tags as string[] | null) ?? [],
    doNotService: (row.do_not_service as boolean | null) ?? null,
    addressIds: (row.address_ids as string[] | null) ?? [],
    housecallproCreatedAt: (row.housecallpro_created_at as string | null) ?? null,
    housecallproUpdatedAt: (row.housecallpro_updated_at as string | null) ?? null,
    addresses: [],
  };
}

/**
 * Finds customers whose normalized_mobile matches the caller's last-10 digits.
 *
 * @param tenantId    - HCP tenant UUID
 * @param phoneLast10 - Normalized 10-digit caller number
 */
export async function findCustomersByPhone(
  tenantId: string,
  phoneLast10: string,
): Promise<HcpCustomerRow[]> {
  const { data } = await supabase
    .from('housecallpro_customers')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('normalized_mobile', phoneLast10);

  if (!data) return [];
  return (data as Record<string, unknown>[]).map(mapRow);
}

/** Sanitizes a token for use inside a PostgREST .or() filter. */
function sanitize(token: string): string {
  return token.replace(/[%,()*]/g, ' ').trim();
}

/**
 * Gathers up to 200 fuzzy-match candidates by name (first/last/company).
 * The cache stores no address text, so Scenario-A matching is name-driven; the
 * tier scorer re-ranks the returned set. Returns [] if no name/zip provided.
 */
export async function getFuzzyCandidates(
  tenantId: string,
  query: { name?: string; zip?: string },
): Promise<HcpCustomerRow[]> {
  if (!query.name) return [];

  const tokens = query.name.split(/\s+/).map(sanitize).filter(Boolean);
  if (tokens.length === 0) return [];

  const clauses: string[] = [];
  for (const t of tokens) {
    clauses.push(`first_name.ilike.%${t}%`, `last_name.ilike.%${t}%`, `company_name.ilike.%${t}%`);
  }

  const { data } = await supabase
    .from('housecallpro_customers')
    .select('*')
    .eq('tenant_id', tenantId)
    .or(clauses.join(','))
    .limit(200);

  if (!data) return [];
  return (data as Record<string, unknown>[]).map(mapRow);
}

/** Fetches one customer by HCP customer id (cus_...), scoped to the tenant. */
export async function getCustomerByHcpId(
  tenantId: string,
  housecallproCustomerId: string,
): Promise<HcpCustomerRow | null> {
  const { data, error } = await supabase
    .from('housecallpro_customers')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('housecallpro_customer_id', housecallproCustomerId)
    .single();

  if (error || !data) return null;
  return mapRow(data as Record<string, unknown>);
}

/** Builds a housecallpro_customers row from an HCP API customer object. */
export function buildCustomerRow(tenantId: string, c: HcpApiCustomer): Record<string, unknown> {
  return {
    tenant_id: tenantId,
    housecallpro_customer_id: c.id,
    first_name: c.first_name ?? null,
    last_name: c.last_name ?? null,
    company_name: c.company_name ?? c.company ?? '',
    email: c.email ?? null,
    mobile_number: c.mobile_number ?? null,
    notifications_enabled: c.notifications_enabled ?? false,
    lead_source: c.lead_source ?? null,
    notes: c.notes ?? null,
    tags: c.tags ?? [],
    housecallpro_created_at: c.created_at ?? null,
    housecallpro_updated_at: c.updated_at ?? null,
    address_ids: (c.addresses ?? []).map(a => a.id),
    updated_at: new Date().toISOString(),
  };
}

/**
 * Upserts a customer (from an HCP API object) into the cache and returns the row.
 * Used by create_customer so the new customer is immediately identifiable.
 */
export async function upsertCustomer(
  tenantId: string,
  c: HcpApiCustomer,
): Promise<HcpCustomerRow | null> {
  const { data, error } = await supabase
    .from('housecallpro_customers')
    .upsert(buildCustomerRow(tenantId, c), { onConflict: 'tenant_id,housecallpro_customer_id' })
    .select('*')
    .single();

  if (error || !data) return null;
  return mapRow(data as Record<string, unknown>);
}

/** Appends an address id to the cached customer's address_ids (dedup). */
export async function appendAddressId(
  tenantId: string,
  housecallproCustomerId: string,
  addressId: string,
): Promise<void> {
  const { data } = await supabase
    .from('housecallpro_customers')
    .select('address_ids')
    .eq('tenant_id', tenantId)
    .eq('housecallpro_customer_id', housecallproCustomerId)
    .single();

  const current = (data?.address_ids as string[] | null) ?? [];
  if (current.includes(addressId)) return;

  await supabase
    .from('housecallpro_customers')
    .update({ address_ids: [...current, addressId], updated_at: new Date().toISOString() })
    .eq('tenant_id', tenantId)
    .eq('housecallpro_customer_id', housecallproCustomerId);
}
