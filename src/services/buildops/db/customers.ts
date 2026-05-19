/**
 * Supabase queries for the buildops_customers table.
 * Customers are the primary lookup entity for inbound calls. The all_numbers GIN
 * array enables O(1) phone lookup across customer, rep, and property phones.
 */

import { supabaseAdmin as supabase } from '../../../lib/supabase.js';
import type { CustomerRow, FuzzyQuery, AddressObj } from '../types.js';

function mapRow(row: Record<string, unknown>): CustomerRow {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    buildopsCustomerId: row.buildops_customer_id as string,
    name: row.name as string,
    phonePrimary: row.phone_primary as string | null,
    phoneSecondary: row.phone_secondary as string | null,
    isActive: row.is_active as boolean,
    normalizedPhonePrimary: row.normalized_phone_primary as string | null,
    normalizedPhoneSecondary: row.normalized_phone_secondary as string | null,
    priceBookId: (row.price_book_id as string | null) ?? null,
    allNumbers: (row.all_numbers as string[]) ?? [],
    allNumbersSources: (row.all_numbers_sources as string[]) ?? [],
    propertyIds: (row.property_ids as string[]) ?? [],
    representativeIds: (row.representative_ids as string[]) ?? [],
    billingAddress: (row.billing_address as string | null) ?? null,
    businessAddress: (row.business_address as string | null) ?? null,
  };
}

/**
 * Looks up active customers whose all_numbers array contains the given phone.
 * Uses the GIN index for O(1) array-contains lookup. Falls back to normalized
 * primary/secondary phone columns if all_numbers is not yet populated.
 *
 * @param tenantId    - BuildOps tenant UUID to scope the query
 * @param phoneLast10 - Normalized 10-digit phone number
 * @returns Matching CustomerRow array (0, 1, or multiple)
 */
export async function findCustomersByPhone(
  tenantId: string,
  phoneLast10: string,
): Promise<CustomerRow[]> {
  // Primary: all_numbers covers customer + rep + property phones
  const { data: primary } = await supabase
    .from('buildops_customers')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .contains('all_numbers', [phoneLast10]);

  if (primary && primary.length > 0) {
    return (primary as Record<string, unknown>[]).map(mapRow);
  }

  // Fallback: direct normalized columns (when all_numbers not yet populated)
  const { data: fallback } = await supabase
    .from('buildops_customers')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .or(`normalized_phone_primary.eq.${phoneLast10},normalized_phone_secondary.eq.${phoneLast10}`);

  if (!fallback) return [];
  return (fallback as Record<string, unknown>[]).map(mapRow);
}

/**
 * Appends a new phone number and source tag to the customer's all_numbers array.
 * No-ops if the normalized phone is already present. Ensures future calls from
 * this number are identified via the GIN phone lookup without waiting for a sync.
 *
 * @param tenantId   - BuildOps tenant UUID
 * @param customerId - Our buildops_customers.id (UUID)
 * @param phone      - Raw phone string (will be normalized to last 10 digits)
 * @param source     - Source tag, e.g. `rep:cellPhone:John Smith`
 */
export async function appendToCustomerAllNumbers(
  tenantId: string,
  customerId: string,
  phone: string,
  source: string,
): Promise<void> {
  const normalized = phone.replace(/\D/g, '').slice(-10);
  if (normalized.length !== 10) return;

  const { data } = await supabase
    .from('buildops_customers')
    .select('all_numbers, all_numbers_sources')
    .eq('tenant_id', tenantId)
    .eq('id', customerId)
    .single();

  const current = (data?.all_numbers as string[] | null) ?? [];
  if (current.includes(normalized)) return;

  const currentSources = (data?.all_numbers_sources as string[] | null) ?? [];

  await supabase
    .from('buildops_customers')
    .update({
      all_numbers: [...current, normalized],
      all_numbers_sources: [...currentSources, source],
    })
    .eq('tenant_id', tenantId)
    .eq('id', customerId);
}

/**
 * Returns a deduplicated set of customer candidates for fuzzy matching.
 * Runs two sub-queries: one by name/zip against buildops_customers, one by
 * address keyword against buildops_properties (joining back to the owning customer).
 * Property addresses are hydrated onto matching customers as `propertyAddresses`.
 *
 * @param tenantId - BuildOps tenant UUID
 * @param query    - FuzzyQuery with at least one of: name, zip, address, propertyAddress
 * @returns Up to 200 CustomerRow candidates (deduped by customer ID)
 */
export async function getFuzzyCandidates(
  tenantId: string,
  query: FuzzyQuery,
): Promise<CustomerRow[]> {
  if (!query.name && !query.zip && !query.address && !query.propertyAddress) return [];

  const customerMap = new Map<string, CustomerRow>();

  // ── Search customers by name / zip ────────────────────────────────────────
  if (query.name || query.zip) {
    let q = supabase
      .from('buildops_customers')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .limit(200);

    if (query.name) {
      q = q.ilike('name', `%${query.name}%`);
    }
    if (query.zip) {
      q = q.ilike('business_address', `%${query.zip}%`);
    }

    const { data } = await q;
    if (data) {
      for (const row of data as Record<string, unknown>[]) {
        const customer = mapRow(row);
        customerMap.set(customer.id, customer);
      }
    }
  }

  // ── Search property table by address line, bring in owning customers ──────
  const spokenAddress = query.propertyAddress ?? query.address;
  if (spokenAddress) {
    const addressKeyword = spokenAddress.split(' ').slice(0, 4).join(' ');
    const { data: propData } = await supabase
      .from('buildops_properties')
      .select('customer_id, address')
      .ilike('address->>line1', `%${addressKeyword}%`)
      .limit(50);

    if (propData && propData.length > 0) {
      // buildops_properties.customer_id references buildops_customers.buildops_customer_id
      const buildopsCustomerIds = [...new Set((propData as Record<string, unknown>[]).map(r => r['customer_id'] as string))];

      // Build property address map: buildopsCustomerId → AddressObj[]
      const propAddressMap = new Map<string, AddressObj[]>();
      for (const r of propData as Record<string, unknown>[]) {
        const cid = r['customer_id'] as string;
        const addr = r['address'] as AddressObj;
        const existing = propAddressMap.get(cid) ?? [];
        existing.push(addr);
        propAddressMap.set(cid, existing);
      }

      // Fetch customers not already in the map (join by buildops_customer_id, not id)
      const alreadyHaveIds = new Set([...customerMap.values()].map(c => c.buildopsCustomerId));
      const missing = buildopsCustomerIds.filter(id => !alreadyHaveIds.has(id));
      if (missing.length > 0) {
        const { data: custData } = await supabase
          .from('buildops_customers')
          .select('*')
          .eq('tenant_id', tenantId)
          .eq('is_active', true)
          .in('buildops_customer_id', missing);

        if (custData) {
          for (const row of custData as Record<string, unknown>[]) {
            customerMap.set(row['id'] as string, mapRow(row));
          }
        }
      }

      // Hydrate customers with their property addresses
      for (const [buildopsCid, propAddrs] of propAddressMap) {
        for (const customer of customerMap.values()) {
          if (customer.buildopsCustomerId === buildopsCid) {
            customer.propertyAddresses = [...(customer.propertyAddresses ?? []), ...propAddrs];
            break;
          }
        }
      }
    }
  }

  return [...customerMap.values()];
}

/**
 * Fetches a single customer by our internal UUID, scoped to the tenant.
 *
 * @param tenantId   - BuildOps tenant UUID
 * @param customerId - Our buildops_customers.id (UUID)
 * @returns The CustomerRow, or null if not found
 */
export async function getCustomerById(
  tenantId: string,
  customerId: string,
): Promise<CustomerRow | null> {
  const { data, error } = await supabase
    .from('buildops_customers')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('id', customerId)
    .single();

  if (error || !data) return null;
  return mapRow(data as Record<string, unknown>);
}
