// @ts-nocheck — Deno runtime file; npm: imports won't resolve in Node TS.
/**
 * Supabase Edge Function — BuildOps paginated sync (deployed as buildops_cron).
 * Triggered by pg_cron on a schedule. Each invocation processes ONE page of
 * customers (~100) to stay within the edge-function time budget.
 *
 * State is stored in buildops_tenants.sync_customer_page (INT, default 1):
 *   page ≥ 1 → syncCustomerPage(): dirty-detect + upsert customers/reps for that page
 *   page = 0 → finalizeSync(): rebuild all representative_ids arrays + run jobs sync
 *
 * Properties are always upserted first (fast, no rep fetches), so they stay fresh
 * even if a later step fails. Property-reps are fetched inline per page (not deferred
 * to a separate sweep), so both our_rep and property_rep types are always populated.
 *
 * Auto-injected Supabase env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2';

// ─── Supabase client ──────────────────────────────────────────────────────────

function makeSupabase(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface PhoneEntry { phone: string; source: string }
interface AuditInfo { createdDate?: string | null; createdDateTime?: number | null; lastUpdatedDate?: string | null; lastUpdatedDateTime?: number | null; deletedDateTime?: number | null }

interface ApiAddress {
  id?: string; addressType?: string | null;
  addressLine1?: string | null; addressLine2?: string | null;
  city?: string | null; state?: string | null; zipcode?: string | null;
}

interface ApiCustomer {
  id: string; name: string;
  accountNumber?: string | null; customerType?: string | null;
  isActive?: boolean | null; email?: string | null;
  customerNumber?: string | null; creditLimit?: number | null;
  isTaxable?: boolean | null; taxRateValue?: string | null;
  status?: string | null;
  phonePrimary?: string | null; phoneAlternate?: string | null;
  receiveSMS?: boolean | null; invoiceDeliveryPref?: string | null;
  priceBookId?: string | null; paymentTermId?: string | null;
  invoicePresetId?: string | null; logoUrl?: string | null; websiteUrl?: string | null;
  version?: number | null; amountNotToExceed?: number | null;
  addresses?: { items?: ApiAddress[] } | ApiAddress[] | null;
  audit?: AuditInfo | null;
}

interface ApiProperty {
  id: string; companyName?: string | null;
  phonePrimary?: string | null; phoneAlternate?: string | null;
  customerId?: string | null; priceBookId?: string | null;
  isTaxable?: boolean | null; version?: number | null;
  audit?: AuditInfo | null;
  addresses?: ApiAddress[] | { items?: ApiAddress[] } | null;
}

interface ApiRep {
  id: string;
  firstName?: string | null; lastName?: string | null;
  cellPhone?: string | null; landlinePhone?: string | null;
  email?: string | null;
  isActive?: boolean | null; isDoNotCall?: boolean | null;
  isEmailOptOut?: boolean | null; isSmsOptOut?: boolean | null;
  version?: number | null;
  propertyId?: string | null; companyId?: string | null;
  audit?: AuditInfo | null;
}

type TaggedRep = ApiRep & { _repSource: 'our_rep' | 'property_rep' };

interface ApiJob {
  id: string;
  jobNumber?: string | null;
  status?: string | null;
  customerPropertyId?: string | null;
  customerId?: string | null;
  jobTypeId?: string | null;
  priceBookId?: string | null;
  isUseTaxable?: boolean | null;
  issueDescription?: string | null;
  billingCustomer?: { id?: string | null; name?: string | null } | null;
  invoiceStatus?: string | null;
  serviceAgreementId?: string | null;
  completedDate?: number | null;
  audit?: { createdDateTime?: number | null; lastUpdatedDateTime?: number | null; deletedDateTime?: number | null } | null;
}

interface TenantRow {
  no: string;
  client_id: string;
  client_secret: string;
  buildops_tenant_id: string;
  sync_customer_page?: number;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function normalize(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '').slice(-10);
  return digits.length === 10 ? digits : null;
}

function addressList(raw: ApiProperty['addresses'] | ApiCustomer['addresses']): ApiAddress[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  return (raw as { items?: ApiAddress[] }).items ?? [];
}

function pickPrimaryAddress(addrs: ApiAddress[]) {
  const a = addrs.find(x => x.addressType === 'propertyAddress') ?? addrs[0];
  return { line1: a?.addressLine1 ?? null, line2: a?.addressLine2 ?? null, city: a?.city ?? null, state: a?.state ?? null, zip: a?.zipcode ?? null };
}

// ─── BuildOps API ─────────────────────────────────────────────────────────────

const BASE_URL  = 'https://public-api.live.buildops.com/v1';
const PAGE_SIZE = 100;

async function getAccessToken(clientId: string, clientSecret: string, tenantId: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret, tenantId }),
  });
  if (!res.ok) throw new Error(`Auth failed (${res.status}): ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

function apiHeaders(token: string, tenantId: string) {
  return { Authorization: `Bearer ${token}`, tenantId, Accept: 'application/json' };
}

async function fetchWithRetry(url: string, options: RequestInit, retries = 3, delayMs = 1500): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, options);
    if (res.ok || res.status < 500) return res;  // success or 4xx (don't retry client errors)
    if (attempt < retries) await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
  }
  return fetch(url, options); // final attempt, let caller handle the error
}


async function fetchAllProperties(token: string, tenantId: string): Promise<{
  properties: ApiProperty[];
  propMap: Map<string, ApiProperty[]>;
  propPhoneMap: Map<string, PhoneEntry[]>;
}> {
  const properties: ApiProperty[] = [];
  const propMap = new Map<string, ApiProperty[]>();
  const propPhoneMap = new Map<string, PhoneEntry[]>();
  let page = 0, total = Infinity;

  while (properties.length < total) {
    const res = await fetchWithRetry(`${BASE_URL}/properties?include_addresses=true&page=${page}&page_size=${PAGE_SIZE}`, { headers: apiHeaders(token, tenantId) });
    if (!res.ok) throw new Error(`Properties page ${page}: ${res.status}`);
    const data = await res.json() as { totalCount?: number; items?: ApiProperty[] };
    if (page === 0) total = data.totalCount ?? 0;
    const items = data.items ?? [];
    const liveProps = items.filter(p => !p.audit?.deletedDateTime);
    properties.push(...liveProps);

    for (const p of liveProps) {
      const cid = p.customerId;
      if (!cid) continue;
      const list = propMap.get(cid) ?? [];
      list.push(p);
      propMap.set(cid, list);
      const phones = propPhoneMap.get(cid) ?? [];
      const p1 = normalize(p.phonePrimary);
      const p2 = normalize(p.phoneAlternate);
      if (p1) phones.push({ phone: p1, source: `property:phonePrimary:${p.id}` });
      if (p2) phones.push({ phone: p2, source: `property:phoneAlternate:${p.id}` });
      propPhoneMap.set(cid, phones);
    }

    if (items.length < PAGE_SIZE) break;
    page++;
  }
  return { properties, propMap, propPhoneMap };
}

async function fetchReps(token: string, tenantId: string, customerId: string): Promise<ApiRep[]> {
  const all: ApiRep[] = [];
  let page = 0;
  while (true) {
    const res = await fetchWithRetry(`${BASE_URL}/customers/${customerId}/our-representatives?page=${page}&page_size=${PAGE_SIZE}`, { headers: apiHeaders(token, tenantId) });
    if (!res.ok) break;
    const items = ((await res.json()) as { items?: ApiRep[] }).items ?? [];
    all.push(...items);
    if (items.length < PAGE_SIZE) break;
    page++;
  }
  return all;
}

async function fetchPropertyReps(token: string, tenantId: string, propertyId: string): Promise<ApiRep[]> {
  const all: ApiRep[] = [];
  let page = 0;
  while (true) {
    const res = await fetchWithRetry(`${BASE_URL}/properties/${propertyId}/representatives?page=${page}&page_size=${PAGE_SIZE}`, { headers: apiHeaders(token, tenantId) });
    if (!res.ok) break;
    const items = ((await res.json()) as { items?: ApiRep[] }).items ?? [];
    all.push(...items);
    if (items.length < PAGE_SIZE) break;
    page++;
  }
  return all;
}

async function fetchJobsSince(token: string, tenantId: string, since: number): Promise<ApiJob[]> {
  const all: ApiJob[] = [];
  let page = 0;
  while (true) {
    const qs = new URLSearchParams({
      page: String(page),
      page_size: String(PAGE_SIZE),
      ...(since > 0 ? { lastUpdatedDateStart: new Date(since).toISOString() } : {}),
    });
    const res = await fetchWithRetry(`${BASE_URL}/jobs?${qs}`, { headers: apiHeaders(token, tenantId) });
    if (!res.ok) throw new Error(`Jobs page ${page}: ${res.status}`);
    const items = ((await res.json()) as { items?: ApiJob[] }).items ?? [];
    all.push(...items);
    if (items.length < PAGE_SIZE) break;
    page++;
  }
  return all;
}

// ─── Row builders ─────────────────────────────────────────────────────────────

function formatAddress(a: ApiAddress | undefined): string | null {
  if (!a) return null;
  return [a.addressLine1, a.addressLine2, a.city, a.state, a.zipcode].filter(Boolean).join(', ') || null;
}

function buildCustomerRow(c: ApiCustomer, reps: ApiRep[], propMap: Map<string, ApiProperty[]>, propPhoneMap: Map<string, PhoneEntry[]>, tenantId: string): Record<string, unknown> {
  const entries: PhoneEntry[] = [];
  const push = (phone: string | null | undefined, source: string) => { const n = normalize(phone); if (n) entries.push({ phone: n, source }); };
  push(c.phonePrimary, 'customer:phonePrimary');
  push(c.phoneAlternate, 'customer:phoneAlternate');
  // Property-linked reps come first so their `:prop:` tag wins the phone dedup
  const sortedReps = [...reps].sort((a, b) => (b.propertyId ? 1 : 0) - (a.propertyId ? 1 : 0));
  for (const r of sortedReps) {
    const name = [r.firstName, r.lastName].filter(Boolean).join(' ') || 'Unknown';
    const propSuffix = r.propertyId ? `:prop:${r.propertyId}` : '';
    const repType = (r as TaggedRep)._repSource ?? 'our_rep';
    push(r.cellPhone,    `${repType}:cellPhone:${name}${propSuffix}`);
    push(r.landlinePhone, `${repType}:landlinePhone:${name}${propSuffix}`);
  }
  for (const e of propPhoneMap.get(c.id) ?? []) entries.push(e);
  const seen = new Set<string>();
  const allNumbers: string[] = [], allSources: string[] = [];
  for (const e of entries) { if (!seen.has(e.phone)) { seen.add(e.phone); allNumbers.push(e.phone); allSources.push(e.source); } }

  const repMaxTs = reps.reduce((max, r) => {
    const t = r.audit?.lastUpdatedDate ? new Date(r.audit.lastUpdatedDate).getTime() : 0;
    return Math.max(max, isNaN(t) ? 0 : t);
  }, 0);
  const propMaxTs = (propMap.get(c.id) ?? []).reduce((max, p) =>
    Math.max(max, p.audit?.lastUpdatedDateTime ?? 0), 0);
  const effectiveTs = Math.max(c.audit?.lastUpdatedDateTime ?? 0, repMaxTs, propMaxTs) || null;

  const addrItems = addressList(c.addresses);
  const billingAddr = formatAddress(addrItems.find(a => a.addressType === 'billingAddress'));
  const businessAddr = formatAddress(addrItems.find(a => a.addressType !== 'billingAddress') ?? addrItems[0]);

  return {
    buildops_customer_id: c.id, tenant_id: tenantId, name: c.name,
    account_number: c.accountNumber ?? null, customer_type: c.customerType ?? null,
    is_active: c.isActive ?? true, email: c.email ?? null, customer_number: c.customerNumber ?? null,
    status: c.status ?? null, phone_primary: c.phonePrimary ?? null,
    phone_secondary: c.phoneAlternate ?? null,
    price_book_id: c.priceBookId ?? null, version: c.version ?? null,
    buildops_last_updated_at: effectiveTs,
    buildops_created_at: c.audit?.createdDateTime ?? null,
    all_numbers: allNumbers, all_numbers_sources: allSources,
    property_ids: (propMap.get(c.id) ?? []).map(p => p.id),
    billing_address: billingAddr,
    business_address: businessAddr,
  };
}

function buildPropertyRow(p: ApiProperty): Record<string, unknown> {
  return {
    id: p.id, name: p.companyName ?? null, phone_primary: p.phonePrimary ?? null,
    customer_id: p.customerId!, address: pickPrimaryAddress(addressList(p.addresses)),
  };
}

function buildRepRow(r: ApiRep, customerId: string, tenantId: string): Record<string, unknown> {
  return {
    tenant_id: tenantId, customer_id: customerId,
    // propertyId null = customer-level rep; do not fall back to companyId (that's a tenant UUID, not a property)
    property_id: r.propertyId ?? null,
    buildops_rep_id: r.id ?? null,
    first_name: r.firstName ?? '', last_name: r.lastName ?? '',
    cell_phone: r.cellPhone ?? null, landline_phone: r.landlinePhone ?? null,
    normalized_cell_phone: normalize(r.cellPhone), normalized_landline_phone: normalize(r.landlinePhone),
    email: r.email ?? null, is_active: r.isActive ?? true, is_do_not_call: r.isDoNotCall ?? false,
    is_email_opt_out: r.isEmailOptOut ?? false, is_sms_opt_out: r.isSmsOptOut ?? false,
    version: r.version ?? 0, created_at: r.audit?.createdDate ?? null, updated_at: r.audit?.lastUpdatedDate ?? null,
    rep_source: (r as TaggedRep)._repSource ?? 'our_rep',
  };
}

// ─── Supabase batch helpers ───────────────────────────────────────────────────

const BATCH_SIZE = 200;

async function batchUpsert(supabase: SupabaseClient, table: string, rows: object[], onConflict: string): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const { error } = await supabase.from(table).upsert(rows.slice(i, i + BATCH_SIZE) as never[], { onConflict });
    if (error) throw new Error(`[${table}] upsert batch ${Math.floor(i / BATCH_SIZE) + 1}: ${error.message}`);
  }
}

async function batchInsert(supabase: SupabaseClient, table: string, rows: object[]): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const { error } = await supabase.from(table).insert(rows.slice(i, i + BATCH_SIZE) as never[]);
    if (error) throw new Error(`[${table}] insert batch ${Math.floor(i / BATCH_SIZE) + 1}: ${error.message}`);
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

Deno.serve(async (_req: Request) => {
  try {
    const supabase = makeSupabase();

    const { data: tenants, error: tenantsErr } = await supabase
      .from('buildops_tenants')
      .select('no, client_id, client_secret, buildops_tenant_id, sync_customer_page');
    if (tenantsErr) throw new Error(`buildops_tenants load: ${tenantsErr.message}`);
    if (!tenants || (tenants as TenantRow[]).length === 0) {
      throw new Error('No rows in buildops_tenants — insert a row first.');
    }

    const results: Record<string, unknown>[] = [];

    for (const t of tenants as TenantRow[]) {
      const { no: inboundPhone, client_id: clientId, client_secret: clientSecret, buildops_tenant_id: tenantId } = t;
      // Default to page 1 if column doesn't exist yet (pre-migration)
      const currentPage = t.sync_customer_page ?? 1;

      const token = await getAccessToken(clientId, clientSecret, tenantId);
      const { error: tokenErr } = await supabase.from('buildops_tenants').update({ access_token: token }).eq('no', inboundPhone);
      if (tokenErr) throw new Error(`token update for ${inboundPhone}: ${tokenErr.message}`);

      // Always upsert all properties first — fast, no rep fetches, stays fresh even if later steps fail
      const { properties, propMap, propPhoneMap } = await fetchAllProperties(token, tenantId);
      const allPropertyRows = properties.filter(p => p.customerId).map(buildPropertyRow);
      if (allPropertyRows.length > 0) await batchUpsert(supabase, 'buildops_properties', allPropertyRows, 'id');

      let result: Record<string, unknown>;

      if (currentPage === 0) {
        // End-of-cycle: rebuild all representative_ids arrays + jobs sync
        result = await finalizeSync(supabase, token, tenantId, allPropertyRows);
        await supabase.from('buildops_tenants').update({ sync_customer_page: 1 }).eq('no', inboundPhone);
      } else {
        // Process one page of customers with dirty-detection
        result = await syncCustomerPage(supabase, token, tenantId, currentPage, properties, propMap, propPhoneMap);
        const pageExhausted = result.page_exhausted as boolean;
        await supabase.from('buildops_tenants')
          .update({ sync_customer_page: pageExhausted ? 0 : currentPage + 1 })
          .eq('no', inboundPhone);
      }

      results.push({ tenant: inboundPhone, properties_synced: allPropertyRows.length, ...result });
    }

    return new Response(
      JSON.stringify(results.length === 1 ? results[0] : results),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});

// ─── Parallel rep fetcher ─────────────────────────────────────────────────────

async function fetchRepsForAll(
  token: string,
  tenantId: string,
  customerIds: string[],
  concurrency = 40,
): Promise<Map<string, ApiRep[]>> {
  const result = new Map<string, ApiRep[]>();
  for (let i = 0; i < customerIds.length; i += concurrency) {
    const batch = customerIds.slice(i, i + concurrency);
    const repsArray = await Promise.all(batch.map(id => fetchReps(token, tenantId, id)));
    batch.forEach((id, idx) => result.set(id, repsArray[idx]));
  }
  return result;
}

async function fetchPropertyRepsForAll(
  token: string,
  tenantId: string,
  propertyIds: string[],
  concurrency = 40,
): Promise<Map<string, ApiRep[]>> {
  const result = new Map<string, ApiRep[]>();
  for (let i = 0; i < propertyIds.length; i += concurrency) {
    const batch = propertyIds.slice(i, i + concurrency);
    const repsArray = await Promise.all(batch.map(id => fetchPropertyReps(token, tenantId, id)));
    batch.forEach((id, idx) => result.set(id, repsArray[idx]));
  }
  return result;
}

function buildCustPropRepsMap(propRepsMap: Map<string, ApiRep[]>, properties: ApiProperty[]): Map<string, ApiRep[]> {
  const propCustomerMap = new Map(properties.filter(p => p.customerId).map(p => [p.id, p.customerId!]));
  const result = new Map<string, ApiRep[]>();
  for (const [propertyId, reps] of propRepsMap) {
    const customerId = propCustomerMap.get(propertyId);
    if (!customerId) continue;
    const existing = result.get(customerId) ?? [];
    existing.push(...reps.map(r => ({ ...r, propertyId: r.propertyId ?? propertyId })));
    result.set(customerId, existing);
  }
  return result;
}

// ─── Per-page customer sync ────────────────────────────────────────────────────

async function syncCustomerPage(
  supabase: SupabaseClient,
  token: string,
  tenantId: string,
  page: number,
  properties: ApiProperty[],
  propMap: Map<string, ApiProperty[]>,
  propPhoneMap: Map<string, PhoneEntry[]>,
): Promise<Record<string, unknown>> {
  // Load per-customer watermarks from DB for dirty detection
  const { data: dbRows, error: dbErr } = await supabase
    .from('buildops_customers')
    .select('buildops_customer_id, buildops_last_updated_at, version, representative_ids')
    .eq('tenant_id', tenantId);
  if (dbErr) throw new Error(`dbCustomerMap query: ${dbErr.message}`);

  const dbCustomerMap = new Map(
    (dbRows ?? []).map(r => {
      const raw = r.representative_ids;
      const repIds = Array.isArray(raw) ? raw as string[] : JSON.parse(typeof raw === 'string' ? raw : '[]') as string[];
      return [r.buildops_customer_id as string, {
        ts: (r.buildops_last_updated_at as number) ?? 0,
        version: (r.version as number) ?? 0,
        repIds,
      }];
    })
  );

  const dirtySet = new Set<string>();

  // Property timestamp dirty detection
  for (const p of properties) {
    if (!p.customerId) continue;
    const customerTs = dbCustomerMap.get(p.customerId)?.ts ?? 0;
    if ((p.audit?.lastUpdatedDateTime ?? 0) > customerTs) dirtySet.add(p.customerId);
  }

  // Rep timestamp + count dirty detection
  const { data: allRepTs, error: repsErr } = await supabase
    .from('buildops_representatives')
    .select('customer_id, updated_at')
    .eq('tenant_id', tenantId);
  if (repsErr) console.warn(`rep dirty query failed: ${repsErr.message}`);

  const actualRepCountMap = new Map<string, number>();
  for (const r of (allRepTs as { customer_id: string; updated_at: string | null }[] | null) ?? []) {
    const repTs = r.updated_at ? new Date(r.updated_at).getTime() : 0;
    const customerTs = dbCustomerMap.get(r.customer_id)?.ts ?? 0;
    if (repTs > customerTs) dirtySet.add(r.customer_id);
    actualRepCountMap.set(r.customer_id, (actualRepCountMap.get(r.customer_id) ?? 0) + 1);
  }

  // Fetch exactly this page of customers (1-based)
  const res = await fetchWithRetry(
    `${BASE_URL}/customers?limit=100&page=${page}&include_inactive=true`,
    { headers: apiHeaders(token, tenantId) },
  );
  if (!res.ok) throw new Error(`customers page ${page}: ${res.status}`);
  const data = await res.json() as { items?: ApiCustomer[] };
  const items = data.items ?? [];

  if (items.length === 0) {
    return { mode: 'paginated', page, page_exhausted: true, customers_on_page: 0, rebuilt: 0, skipped: 0, representatives_replaced: 0, changes: false };
  }

  // Delete customers removed from the API
  const deletedCustomerIds = items.filter(c => c.audit?.deletedDateTime).map(c => c.id);
  if (deletedCustomerIds.length > 0) {
    await supabase.from('buildops_customers').delete()
      .eq('tenant_id', tenantId)
      .in('buildops_customer_id', deletedCustomerIds);
  }
  const liveItems = items.filter(c => !c.audit?.deletedDateTime);

  // Dirty if: in dirtySet, timestamp advanced, version advanced, new to DB, or rep count mismatch
  const dirtyItems = liveItems.filter(c => {
    const db = dbCustomerMap.get(c.id);
    return dirtySet.has(c.id)
      || (c.audit?.lastUpdatedDateTime ?? 0) > (db?.ts ?? 0)
      || (c.version ?? 0) > (db?.version ?? 0)
      || !db
      || (db?.repIds?.length ?? 0) === 0
      || (db?.repIds?.length ?? 0) !== (actualRepCountMap.get(c.id) ?? 0);
  });

  const customerRows: object[] = [];
  const repRows: object[] = [];
  const rebuiltCustomerIds = new Set<string>();

  if (dirtyItems.length > 0) {
    // Fetch our-reps and property-reps for dirty customers on this page
    const dirtyRepsMap = await fetchRepsForAll(token, tenantId, dirtyItems.map(c => c.id));
    const dirtyPropIds = dirtyItems.flatMap(c => (propMap.get(c.id) ?? []).map(p => p.id));
    const dirtyPropRepsRawMap = await fetchPropertyRepsForAll(token, tenantId, dirtyPropIds);
    const dirtyCustPropRepsMap = buildCustPropRepsMap(dirtyPropRepsRawMap, properties);

    for (const c of dirtyItems) {
      const ourReps = dirtyRepsMap.get(c.id) ?? [];
      const propReps = dirtyCustPropRepsMap.get(c.id) ?? [];
      const allReps = [
        ...ourReps.map(r => ({ ...r, _repSource: 'our_rep' as const })),
        ...propReps.map(r => ({ ...r, _repSource: 'property_rep' as const })),
      ];
      customerRows.push(buildCustomerRow(c, allReps, propMap, propPhoneMap, tenantId));
      for (const r of allReps) repRows.push(buildRepRow(r, c.id, tenantId));
      rebuiltCustomerIds.add(c.id);
    }

    await batchUpsert(supabase, 'buildops_customers', customerRows, 'tenant_id,buildops_customer_id');

    // Capture old property IDs before deleting reps (to zero out arrays for properties that lose all reps)
    const { data: oldRepProps } = await supabase
      .from('buildops_representatives')
      .select('property_id')
      .eq('tenant_id', tenantId)
      .in('customer_id', [...rebuiltCustomerIds]);
    const oldPropIds = [...new Set(
      (oldRepProps ?? []).map((r: { property_id: string | null }) => r.property_id).filter(Boolean) as string[],
    )];

    for (const customerId of rebuiltCustomerIds) {
      const { error: delErr } = await supabase.from('buildops_representatives').delete()
        .eq('tenant_id', tenantId).eq('customer_id', customerId);
      if (delErr) throw new Error(`clear reps for ${customerId}: ${delErr.message}`);
    }
    const relevantRepRows = repRows.filter(r => rebuiltCustomerIds.has((r as { customer_id: string }).customer_id));
    if (relevantRepRows.length > 0) await batchInsert(supabase, 'buildops_representatives', relevantRepRows);

    await updateRepresentativeIds(supabase, tenantId, [...rebuiltCustomerIds]);
    const newPropIds = [...new Set((relevantRepRows as any[]).map(r => r.property_id).filter(Boolean) as string[])];
    await updatePropertyRepresentativeIds(supabase, tenantId, [...new Set([...oldPropIds, ...newPropIds])]);
  }

  return {
    mode: 'paginated',
    page,
    page_exhausted: items.length < 100,
    customers_on_page: liveItems.length,
    rebuilt: rebuiltCustomerIds.size,
    skipped: liveItems.length - rebuiltCustomerIds.size,
    representatives_replaced: repRows.length,
    changes: rebuiltCustomerIds.size > 0,
  };
}

// ─── Representative IDs sync helper ──────────────────────────────────────────

async function updateRepresentativeIds(
  supabase: SupabaseClient,
  tenantId: string,
  customerIds: string[],
): Promise<void> {
  if (customerIds.length === 0) return;

  const allRows: { id: string; customer_id: string }[] = [];
  const SELECT_CHUNK = 50;
  for (let i = 0; i < customerIds.length; i += SELECT_CHUNK) {
    const { data, error } = await supabase
      .from('buildops_representatives')
      .select('id, customer_id')
      .eq('tenant_id', tenantId)
      .in('customer_id', customerIds.slice(i, i + SELECT_CHUNK));
    if (error) throw new Error(`rep IDs query: ${error.message}`);
    allRows.push(...(data ?? []) as { id: string; customer_id: string }[]);
  }
  const rows = allRows;

  const byCustomer = new Map<string, string[]>();
  for (const r of (rows ?? []) as { id: string; customer_id: string }[]) {
    const list = byCustomer.get(r.customer_id) ?? [];
    list.push(r.id);
    byCustomer.set(r.customer_id, list);
  }

  const PARALLEL = 50;
  for (let i = 0; i < customerIds.length; i += PARALLEL) {
    const results = await Promise.all(
      customerIds.slice(i, i + PARALLEL).map(customerId =>
        supabase
          .from('buildops_customers')
          .update({ representative_ids: byCustomer.get(customerId) ?? [] })
          .eq('tenant_id', tenantId)
          .eq('buildops_customer_id', customerId),
      ),
    );
    const failed = results.find(r => r.error);
    if (failed?.error) throw new Error(`update rep IDs: ${failed.error.message}`);
  }
}

// ─── Property representative_ids sync helper ──────────────────────────────────

async function updatePropertyRepresentativeIds(
  supabase: SupabaseClient,
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

// ─── End-of-cycle finalize ────────────────────────────────────────────────────

async function finalizeSync(
  supabase: SupabaseClient,
  token: string,
  tenantId: string,
  allPropertyRows: object[],
): Promise<Record<string, unknown>> {
  // Rebuild representative_ids for every customer in DB
  const { data: allCustomers } = await supabase
    .from('buildops_customers')
    .select('buildops_customer_id')
    .eq('tenant_id', tenantId);
  const allCustomerIds = (allCustomers ?? []).map((r: { buildops_customer_id: string }) => r.buildops_customer_id);
  if (allCustomerIds.length > 0) await updateRepresentativeIds(supabase, tenantId, allCustomerIds);

  // Rebuild representative_ids for every property
  const allPropIds = (allPropertyRows as any[]).map(r => r.id as string);
  if (allPropIds.length > 0) await updatePropertyRepresentativeIds(supabase, tenantId, allPropIds);

  // Delete properties that no longer exist in the API
  const tenantCustomerIds = [...new Set((allPropertyRows as any[]).map(r => r.customer_id).filter(Boolean))] as string[];
  if (tenantCustomerIds.length > 0) {
    const apiPropIdSet = new Set(allPropIds);
    const CHUNK = 50;
    const existingPropIds: string[] = [];
    let fetchFailed = false;
    for (let i = 0; i < tenantCustomerIds.length; i += CHUNK) {
      const { data, error } = await supabase
        .from('buildops_properties')
        .select('id')
        .in('customer_id', tenantCustomerIds.slice(i, i + CHUNK));
      if (error) { console.warn(`property cleanup fetch: ${error.message}`); fetchFailed = true; break; }
      existingPropIds.push(...(data ?? []).map((p: { id: string }) => p.id));
    }
    if (!fetchFailed) {
      const toDelete = existingPropIds.filter(id => !apiPropIdSet.has(id));
      if (toDelete.length > 0) {
        const { error: propDelErr } = await supabase.from('buildops_properties').delete().in('id', toDelete);
        if (propDelErr) console.warn(`property cleanup: ${propDelErr.message}`);
      }
    }
  }

  const jobsResult = await jobsSync(supabase, token, tenantId);

  return {
    mode: 'paginated_finalize',
    customers_ids_updated: allCustomerIds.length,
    properties_ids_updated: allPropIds.length,
    jobs: jobsResult,
    changes: (jobsResult as any).synced > 0,
  };
}

// ─── Jobs incremental sync ────────────────────────────────────────────────────

async function jobsSync(supabase: SupabaseClient, token: string, tenantId: string): Promise<Record<string, unknown>> {
  const { data: wmRow } = await supabase
    .from('buildops_jobs')
    .select('last_updated_at')
    .eq('tenant_id', tenantId)
    .order('last_updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const watermark = (wmRow as { last_updated_at: number | null } | null)?.last_updated_at ?? 0;

  const jobs = await fetchJobsSince(token, tenantId, watermark);
  if (jobs.length === 0) return { mode: 'jobs_incremental', synced: 0, watermark };

  const rows = jobs.map(j => ({
    tenant_id: tenantId,
    job_id: j.id,
    job_number: j.jobNumber ?? null,
    status: j.status ?? null,
    customer_property_id: j.customerPropertyId ?? null,
    customer_id: j.customerId ?? null,
    job_type_id: j.jobTypeId ?? null,
    price_book_id: j.priceBookId ?? null,
    is_use_taxable: j.isUseTaxable ?? false,
    issue_description: j.issueDescription ?? null,
    billing_customer_id: j.billingCustomer?.id ?? null,
    billing_customer_name: j.billingCustomer?.name ?? null,
    invoice_status: j.invoiceStatus ?? null,
    service_agreement_id: j.serviceAgreementId ?? null,
    completed_date: j.completedDate ?? null,
    created_at: j.audit?.createdDateTime ?? null,
    last_updated_at: j.audit?.lastUpdatedDateTime ?? null,
    is_deleted: j.audit?.deletedDateTime != null,
  }));

  await batchUpsert(supabase, 'buildops_jobs', rows, 'tenant_id,job_id');

  const newMax = rows.reduce((max, r) => Math.max(max, (r.last_updated_at as number) ?? 0), watermark);
  return { mode: 'jobs_incremental', synced: jobs.length, watermark: newMax };
}
