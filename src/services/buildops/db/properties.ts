/**
 * Supabase queries for the buildops_properties table (service locations).
 * Properties are the "where is the job" entity — each customer has one or more.
 * The property UUID is required when creating a job in BuildOps.
 */

import { supabaseAdmin as supabase } from '../../../lib/supabase.js';
import type { PropertyRow, AddressObj } from '../types.js';

function mapRow(row: Record<string, unknown>): PropertyRow {
  return {
    id: row.id as string,
    name: row.name as string | null,
    phonePrimary: row.phone_primary as string | null,
    customerId: row.customer_id as string,
    address: (row.address as AddressObj) ?? {},
    representativeIds: (row.representative_ids as string[]) ?? [],
  };
}

/**
 * Returns all service location properties for a given customer.
 * Used to determine property_count (skip match_property if exactly 1) and
 * to populate the candidate list when the agent needs to disambiguate.
 *
 * @param customerId - Our buildops_customers.id (UUID)
 * @returns Array of PropertyRow (empty if none found)
 */
export async function getPropertiesForCustomer(customerId: string): Promise<PropertyRow[]> {
  const { data, error } = await supabase
    .from('buildops_properties')
    .select('*')
    .eq('customer_id', customerId);

  if (error || !data) return [];
  return (data as Record<string, unknown>[]).map(mapRow);
}

/**
 * Fetches properties by their BuildOps property UUIDs (from customer.propertyIds).
 * Use this instead of getPropertiesForCustomer — the customer_id FK points to
 * buildops_customer_id, but callers only have the internal UUID.
 */
export async function getPropertiesByIds(ids: string[]): Promise<PropertyRow[]> {
  if (ids.length === 0) return [];
  const { data, error } = await supabase
    .from('buildops_properties')
    .select('*')
    .in('id', ids);
  if (error || !data) return [];
  return (data as Record<string, unknown>[]).map(mapRow);
}

/**
 * Appends a Supabase rep UUID to the property's representative_ids array (best-effort).
 * No-ops if the rep ID is already present. Called after a local createRepresentative
 * succeeds so the property's array reflects the new rep immediately without waiting
 * for the next cron sync.
 *
 * @param propertyId   - BuildOps property UUID (TEXT primary key)
 * @param supabaseRepId - Supabase UUID from buildops_representatives.id
 */
export async function appendToPropertyRepresentativeIds(
  propertyId: string,
  supabaseRepId: string,
): Promise<void> {
  const { data } = await supabase
    .from('buildops_properties')
    .select('representative_ids')
    .eq('id', propertyId)
    .single();

  const current: string[] = (data as { representative_ids: string[] } | null)?.representative_ids ?? [];
  if (current.includes(supabaseRepId)) return;

  await supabase
    .from('buildops_properties')
    .update({ representative_ids: [...current, supabaseRepId] })
    .eq('id', propertyId);
}

/**
 * Rebuilds representative_ids for a set of properties from the current DB state.
 * Writes [] for any property in the list that currently has no reps — this clears
 * stale arrays when reps are removed during cron sync.
 *
 * @param tenantId    - BuildOps tenant UUID
 * @param propertyIds - BuildOps property UUIDs to update (include both old and new to handle moves)
 */
export async function updatePropertyRepresentativeIds(
  tenantId: string,
  propertyIds: string[],
): Promise<void> {
  if (propertyIds.length === 0) return;

  const allRows: { id: string; property_id: string }[] = [];
  const SELECT_CHUNK = 50;
  for (let i = 0; i < propertyIds.length; i += SELECT_CHUNK) {
    const { data, error } = await supabase
      .from('buildops_representatives')
      .select('id, property_id')
      .eq('tenant_id', tenantId)
      .in('property_id', propertyIds.slice(i, i + SELECT_CHUNK));
    if (error) throw new Error(`property rep IDs query: ${error.message}`);
    allRows.push(...(data ?? []) as { id: string; property_id: string }[]);
  }

  const byProperty = new Map<string, string[]>();
  for (const r of allRows) {
    const list = byProperty.get(r.property_id) ?? [];
    list.push(r.id);
    byProperty.set(r.property_id, list);
  }

  const PARALLEL = 50;
  for (let i = 0; i < propertyIds.length; i += PARALLEL) {
    const results = await Promise.all(
      propertyIds.slice(i, i + PARALLEL).map(propertyId =>
        supabase
          .from('buildops_properties')
          .update({ representative_ids: byProperty.get(propertyId) ?? [] })
          .eq('id', propertyId),
      ),
    );
    const failed = results.find(r => r.error);
    if (failed?.error) throw new Error(`update property rep IDs: ${failed.error.message}`);
  }
}

/**
 * Fetches a single property by BuildOps property UUID.
 * Used in handlePrepareJob to verify the property exists and belongs to the confirmed customer.
 *
 * @param propertyId - BuildOps property UUID (stored as TEXT primary key)
 * @returns The PropertyRow, or null if not found
 */
export async function getPropertyById(propertyId: string): Promise<PropertyRow | null> {
  const { data, error } = await supabase
    .from('buildops_properties')
    .select('*')
    .eq('id', propertyId)
    .single();

  if (error || !data) return null;
  return mapRow(data as Record<string, unknown>);
}
