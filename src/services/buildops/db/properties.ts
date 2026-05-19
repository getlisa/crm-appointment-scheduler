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
 * Appends a BuildOps rep UUID to the property's representative_ids array (best-effort).
 * No-ops if the rep ID is already present. Called after add_representative succeeds
 * so future call_inbound lookups can identify the caller's associated property.
 *
 * @param propertyId    - BuildOps property UUID (TEXT primary key)
 * @param buildopsRepId - BuildOps representative UUID to append
 */
export async function appendToPropertyRepresentativeIds(
  propertyId: string,
  buildopsRepId: string,
): Promise<void> {
  const { data } = await supabase
    .from('buildops_properties')
    .select('representative_ids')
    .eq('id', propertyId)
    .single();

  const current: string[] = (data as { representative_ids: string[] } | null)?.representative_ids ?? [];
  if (current.includes(buildopsRepId)) return;

  await supabase
    .from('buildops_properties')
    .update({ representative_ids: [...current, buildopsRepId] })
    .eq('id', propertyId);
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
