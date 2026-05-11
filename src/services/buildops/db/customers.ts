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
    addresses: (row.addresses as AddressObj[]) ?? [],
    normalizedPhonePrimary: row.normalized_phone_primary as string | null,
    normalizedPhoneSecondary: row.normalized_phone_secondary as string | null,
    priceBookId: (row.price_book_id as string | null) ?? null,
    allNumbers: (row.all_numbers as string[]) ?? [],
  };
}

export async function findCustomersByPhone(
  tenantId: string,
  phoneLast10: string,
): Promise<CustomerRow[]> {
  // Primary: all_numbers covers customer + rep + property phones
  const { data: primary } = await supabase
    .from('customers')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .contains('all_numbers', [phoneLast10]);

  if (primary && primary.length > 0) {
    return (primary as Record<string, unknown>[]).map(mapRow);
  }

  // Fallback: direct normalized columns (when all_numbers not yet populated)
  const { data: fallback } = await supabase
    .from('customers')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .or(`normalized_phone_primary.eq.${phoneLast10},normalized_phone_secondary.eq.${phoneLast10}`);

  if (!fallback) return [];
  return (fallback as Record<string, unknown>[]).map(mapRow);
}

export async function appendToCustomerAllNumbers(
  tenantId: string,
  customerId: string,
  phone: string,
  source: string,
): Promise<void> {
  const normalized = phone.replace(/\D/g, '').slice(-10);
  if (normalized.length !== 10) return;

  const { data } = await supabase
    .from('customers')
    .select('all_numbers, all_numbers_sources')
    .eq('tenant_id', tenantId)
    .eq('id', customerId)
    .single();

  const current = (data?.all_numbers as string[] | null) ?? [];
  if (current.includes(normalized)) return;

  const currentSources = (data?.all_numbers_sources as string[] | null) ?? [];

  await supabase
    .from('customers')
    .update({
      all_numbers: [...current, normalized],
      all_numbers_sources: [...currentSources, source],
    })
    .eq('tenant_id', tenantId)
    .eq('id', customerId);
}

export async function getFuzzyCandidates(
  tenantId: string,
  query: FuzzyQuery,
): Promise<CustomerRow[]> {
  if (!query.name && !query.zip && !query.address && !query.propertyAddress) return [];

  const customerMap = new Map<string, CustomerRow>();

  // ── Search customers by name / zip ────────────────────────────────────────
  if (query.name || query.zip) {
    let q = supabase
      .from('customers')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .limit(200);

    if (query.name && query.zip) {
      q = q.ilike('name', `%${query.name}%`).filter(
        'addresses',
        'cs',
        JSON.stringify([{ zip: query.zip }]),
      );
    } else if (query.name) {
      q = q.ilike('name', `%${query.name}%`);
    } else if (query.zip) {
      q = q.filter('addresses', 'cs', JSON.stringify([{ zip: query.zip }]));
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
      .from('property')
      .select('customer_id, address')
      .ilike('address->>line1', `%${addressKeyword}%`)
      .limit(50);

    if (propData && propData.length > 0) {
      const customerIds = [...new Set((propData as Record<string, unknown>[]).map(r => r['customer_id'] as string))];

      // Build property address map: customerId → AddressObj[]
      const propAddressMap = new Map<string, AddressObj[]>();
      for (const r of propData as Record<string, unknown>[]) {
        const cid = r['customer_id'] as string;
        const addr = r['address'] as AddressObj;
        const existing = propAddressMap.get(cid) ?? [];
        existing.push(addr);
        propAddressMap.set(cid, existing);
      }

      // Fetch any customers not already in the map
      const missing = customerIds.filter(id => !customerMap.has(id));
      if (missing.length > 0) {
        const { data: custData } = await supabase
          .from('customers')
          .select('*')
          .eq('tenant_id', tenantId)
          .eq('is_active', true)
          .in('id', missing);

        if (custData) {
          for (const row of custData as Record<string, unknown>[]) {
            customerMap.set(row['id'] as string, mapRow(row));
          }
        }
      }

      // Hydrate all matched customers with their property addresses
      for (const [cid, propAddrs] of propAddressMap) {
        const customer = customerMap.get(cid);
        if (customer) {
          customer.propertyAddresses = [
            ...(customer.propertyAddresses ?? []),
            ...propAddrs,
          ];
        }
      }
    }
  }

  return [...customerMap.values()];
}

export async function getCustomerById(
  tenantId: string,
  customerId: string,
): Promise<CustomerRow | null> {
  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('id', customerId)
    .single();

  if (error || !data) return null;
  return mapRow(data as Record<string, unknown>);
}
