// @ts-nocheck — Deno runtime file; npm: imports won't resolve in Node TS.
// Supabase Edge Function — BuildOps sync (single-file, paste into browser editor)
// Auto-injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

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
interface AuditInfo { createdDate?: string | null; createdDateTime?: number | null; lastUpdatedDate?: string | null; lastUpdatedDateTime?: number | null }

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

interface TenantRow {
  no: string;
  client_id: string;
  client_secret: string;
  buildops_tenant_id: string;
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

async function fetchAllCustomers(token: string, tenantId: string): Promise<ApiCustomer[]> {
  const all: ApiCustomer[] = [];
  let page = 1; // customers API is 1-based; page=0 returns the same items as page=1
  while (true) {
    const res = await fetch(`${BASE_URL}/customers?limit=${PAGE_SIZE}&page=${page}&include_inactive=true`, { headers: apiHeaders(token, tenantId) });
    if (!res.ok) throw new Error(`Customers page ${page}: ${res.status}`);
    const items = ((await res.json()) as { items?: ApiCustomer[] }).items ?? [];
    if (items.length === 0) break;
    all.push(...items);
    if (items.length < PAGE_SIZE) break;
    page++;
  }
  const seenIds = new Set<string>();
  return all.filter(c => seenIds.has(c.id) ? false : (seenIds.add(c.id), true));
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
    const res = await fetch(`${BASE_URL}/properties?include_addresses=true&page=${page}&page_size=${PAGE_SIZE}`, { headers: apiHeaders(token, tenantId) });
    if (!res.ok) throw new Error(`Properties page ${page}: ${res.status}`);
    const data = await res.json() as { totalCount?: number; items?: ApiProperty[] };
    if (page === 0) total = data.totalCount ?? 0;
    const items = data.items ?? [];
    properties.push(...items);

    for (const p of items) {
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
    const res = await fetch(`${BASE_URL}/customers/${customerId}/our-representatives?page=${page}&page_size=${PAGE_SIZE}`, { headers: apiHeaders(token, tenantId) });
    if (!res.ok) break;
    const items = ((await res.json()) as { items?: ApiRep[] }).items ?? [];
    all.push(...items);
    if (items.length < PAGE_SIZE) break;
    page++;
  }
  return all;
}

// ─── Row builders ─────────────────────────────────────────────────────────────

function buildCustomerRow(c: ApiCustomer, reps: ApiRep[], propMap: Map<string, ApiProperty[]>, propPhoneMap: Map<string, PhoneEntry[]>, tenantId: string): Record<string, unknown> {
  const entries: PhoneEntry[] = [];
  const push = (phone: string | null | undefined, source: string) => { const n = normalize(phone); if (n) entries.push({ phone: n, source }); };
  push(c.phonePrimary, 'customer:phonePrimary');
  push(c.phoneAlternate, 'customer:phoneAlternate');
  for (const r of reps) {
    const name = [r.firstName, r.lastName].filter(Boolean).join(' ') || 'Unknown';
    push(r.cellPhone, `rep:cellPhone:${name}`);
    push(r.landlinePhone, `rep:landlinePhone:${name}`);
  }
  for (const e of propPhoneMap.get(c.id) ?? []) entries.push(e);
  const seen = new Set<string>();
  const allNumbers: string[] = [], allSources: string[] = [];
  for (const e of entries) { if (!seen.has(e.phone)) { seen.add(e.phone); allNumbers.push(e.phone); allSources.push(e.source); } }

  const propsSummary = (propMap.get(c.id) ?? []).map(p => ({
    id: p.id, companyName: p.companyName ?? null, phonePrimary: p.phonePrimary ?? null,
    priceBookId: p.priceBookId ?? null, isTaxable: p.isTaxable ?? false, version: p.version ?? 0,
    addresses: addressList(p.addresses).map(a => ({ addressLine1: a.addressLine1 ?? null, addressLine2: a.addressLine2 ?? null, city: a.city ?? null, state: a.state ?? null, zipcode: a.zipcode ?? null, addressType: a.addressType ?? null })),
  }));
  const repsSummary = reps.map(r => ({
    id: r.id, firstName: r.firstName ?? null, lastName: r.lastName ?? null,
    cellPhone: r.cellPhone ?? null, landlinePhone: r.landlinePhone ?? null,
    email: r.email ?? null, propertyId: r.propertyId ?? r.companyId ?? null,
    isActive: r.isActive ?? true, isDoNotCall: r.isDoNotCall ?? false, version: r.version ?? 0,
  }));

  const repMaxTs = reps.reduce((max, r) => {
    const t = r.audit?.lastUpdatedDate ? new Date(r.audit.lastUpdatedDate).getTime() : 0;
    return Math.max(max, isNaN(t) ? 0 : t);
  }, 0);
  const propMaxTs = (propMap.get(c.id) ?? []).reduce((max, p) =>
    Math.max(max, p.audit?.lastUpdatedDateTime ?? 0), 0);
  const effectiveTs = Math.max(c.audit?.lastUpdatedDateTime ?? 0, repMaxTs, propMaxTs) || null;

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
    representatives: repsSummary, properties: propsSummary,
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
    property_id: r.propertyId ?? r.companyId ?? '',
    first_name: r.firstName ?? '', last_name: r.lastName ?? '',
    cell_phone: r.cellPhone ?? null, landline_phone: r.landlinePhone ?? null,
    normalized_cell_phone: normalize(r.cellPhone), normalized_landline_phone: normalize(r.landlinePhone),
    email: r.email ?? null, is_active: r.isActive ?? true, is_do_not_call: r.isDoNotCall ?? false,
    is_email_opt_out: r.isEmailOptOut ?? false, is_sms_opt_out: r.isSmsOptOut ?? false,
    version: r.version ?? 0, created_at: r.audit?.createdDate ?? null, updated_at: r.audit?.lastUpdatedDate ?? null,
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
      .select('no, client_id, client_secret, buildops_tenant_id');
    if (tenantsErr) throw new Error(`buildops_tenants load: ${tenantsErr.message}`);
    if (!tenants || (tenants as TenantRow[]).length === 0) {
      throw new Error('No rows in buildops_tenants — insert a row first.');
    }

    const results: Record<string, unknown>[] = [];

    for (const t of tenants as TenantRow[]) {
      const { no: inboundPhone, client_id: clientId, client_secret: clientSecret, buildops_tenant_id: tenantId } = t;

      const token = await getAccessToken(clientId, clientSecret, tenantId);
      const { error: tokenErr } = await supabase.from('buildops_tenants').update({ access_token: token }).eq('no', inboundPhone);
      if (tokenErr) throw new Error(`token update for ${inboundPhone}: ${tokenErr.message}`);

      const { count, error: countErr } = await supabase
        .from('buildops_customers').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId);
      if (countErr) throw new Error(`count check for ${tenantId}: ${countErr.message}`);

      const tenantResult = (count ?? 0) === 0
        ? await fullSeed(supabase, token, tenantId)
        : await incrementalSync(supabase, token, tenantId);

      results.push({ tenant: inboundPhone, ...tenantResult });
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
  concurrency = 15,
): Promise<Map<string, ApiRep[]>> {
  const result = new Map<string, ApiRep[]>();
  for (let i = 0; i < customerIds.length; i += concurrency) {
    const batch = customerIds.slice(i, i + concurrency);
    const repsArray = await Promise.all(batch.map(id => fetchReps(token, tenantId, id)));
    batch.forEach((id, idx) => result.set(id, repsArray[idx]));
  }
  return result;
}

// ─── Full seed ────────────────────────────────────────────────────────────────

async function fullSeed(supabase: SupabaseClient, token: string, tenantId: string): Promise<Record<string, unknown>> {
  const { properties, propMap, propPhoneMap } = await fetchAllProperties(token, tenantId);
  const propertyRows = properties.filter(p => p.customerId).map(buildPropertyRow);
  await batchUpsert(supabase, 'buildops_properties', propertyRows, 'id');

  const customers = await fetchAllCustomers(token, tenantId);

  // Fetch all reps in parallel batches (15 concurrent) instead of sequentially
  const repsMap = await fetchRepsForAll(token, tenantId, customers.map(c => c.id));

  const customerRows: object[] = [];
  const repRows: object[] = [];

  for (const c of customers) {
    const reps = repsMap.get(c.id) ?? [];
    customerRows.push(buildCustomerRow(c, reps, propMap, propPhoneMap, tenantId));
    for (const r of reps) repRows.push(buildRepRow(r, c.id, tenantId));
  }

  const dedupedCustomerRows = [...new Map(customerRows.map(r => [(r as any).buildops_customer_id, r])).values()];
  const dedupedRepRows = [...new Map(repRows.map(r => [`${(r as any).customer_id}:${(r as any).id}`, r])).values()];

  await batchUpsert(supabase, 'buildops_customers', dedupedCustomerRows, 'tenant_id,buildops_customer_id');

  const { error: delErr } = await supabase.from('buildops_representatives').delete().eq('tenant_id', tenantId);
  if (delErr) throw new Error(`clear reps: ${delErr.message}`);
  if (dedupedRepRows.length > 0) await batchInsert(supabase, 'buildops_representatives', dedupedRepRows);

  return { mode: 'full', properties: propertyRows.length, customers: dedupedCustomerRows.length, representatives: dedupedRepRows.length };
}

// ─── Incremental sync ─────────────────────────────────────────────────────────

async function incrementalSync(supabase: SupabaseClient, token: string, tenantId: string): Promise<Record<string, unknown>> {
  // Load per-customer watermarks and versions from DB (Fix 1)
  const { data: dbRows, error: dbErr } = await supabase
    .from('buildops_customers')
    .select('buildops_customer_id, buildops_last_updated_at, version')
    .eq('tenant_id', tenantId);
  if (dbErr) throw new Error(`dbCustomerMap query: ${dbErr.message}`);

  const dbCustomerMap = new Map(
    (dbRows ?? []).map(r => [r.buildops_customer_id as string, {
      ts: (r.buildops_last_updated_at as number) ?? 0,
      version: (r.version as number) ?? 0,
    }])
  );

  const dirtySet = new Set<string>();

  // Fetch all properties; detect dirty via per-customer timestamp (Fix 2)
  const { properties, propMap, propPhoneMap } = await fetchAllProperties(token, tenantId);
  for (const p of properties) {
    if (!p.customerId) continue;
    const customerTs = dbCustomerMap.get(p.customerId)?.ts ?? 0;
    if ((p.audit?.lastUpdatedDateTime ?? 0) > customerTs) dirtySet.add(p.customerId);
  }

  // Rep dirty detection: compare each rep's updated_at against its customer's watermark (Fix 3)
  const { data: allRepTs, error: repsErr } = await supabase
    .from('buildops_representatives')
    .select('customer_id, updated_at')
    .eq('tenant_id', tenantId);
  if (repsErr) console.warn(`rep dirty query failed: ${repsErr.message}`);
  for (const r of (allRepTs as { customer_id: string; updated_at: string | null }[] | null) ?? []) {
    const repTs = r.updated_at ? new Date(r.updated_at).getTime() : 0;
    const customerTs = dbCustomerMap.get(r.customer_id)?.ts ?? 0;
    if (repTs > customerTs) dirtySet.add(r.customer_id);
  }

  const customerRows: object[] = [];
  const repRows: object[] = [];
  const rebuiltCustomerIds = new Set<string>();
  let rebuilt = 0, skipped = 0;
  let page = 1; // 1-based

  while (true) {
    const res = await fetch(
      `${BASE_URL}/customers?limit=100&page=${page}&include_inactive=true`,
      { headers: apiHeaders(token, tenantId) },
    );
    if (!res.ok) throw new Error(`customers page ${page}: ${res.status}`);
    const data = await res.json() as { items?: ApiCustomer[] };
    const items = data.items ?? [];
    if (items.length === 0) break;

    // Dirty if: in dirtySet, own timestamp > per-customer watermark, version advanced, or new customer (Fix 4)
    const dirtyItems = items.filter(c => {
      const db = dbCustomerMap.get(c.id);
      return dirtySet.has(c.id)
        || (c.audit?.lastUpdatedDateTime ?? 0) > (db?.ts ?? 0)
        || (c.version ?? 0) > (db?.version ?? 0)
        || !db;
    });
    skipped += items.length - dirtyItems.length;

    const dirtyRepsMap = await fetchRepsForAll(token, tenantId, dirtyItems.map(c => c.id));
    for (const c of dirtyItems) {
      const reps = dirtyRepsMap.get(c.id) ?? [];
      customerRows.push(buildCustomerRow(c, reps, propMap, propPhoneMap, tenantId));
      for (const r of reps) repRows.push(buildRepRow(r, c.id, tenantId));
      rebuiltCustomerIds.add(c.id);
      rebuilt++;
    }

    if (items.length < 100) break;
    page++;
  }

  if (customerRows.length > 0) await batchUpsert(supabase, 'buildops_customers', customerRows, 'tenant_id,buildops_customer_id');

  for (const customerId of rebuiltCustomerIds) {
    const { error: delErr } = await supabase.from('buildops_representatives').delete().eq('tenant_id', tenantId).eq('customer_id', customerId);
    if (delErr) throw new Error(`clear reps for ${customerId}: ${delErr.message}`);
  }
  const relevantRepRows = repRows.filter(r => rebuiltCustomerIds.has((r as { customer_id: string }).customer_id));
  if (relevantRepRows.length > 0) await batchInsert(supabase, 'buildops_representatives', relevantRepRows);

  // Upsert all properties and delete any that no longer exist in the API (Fix 6)
  const allPropertyRows = properties.filter(p => p.customerId).map(buildPropertyRow);
  if (allPropertyRows.length > 0) await batchUpsert(supabase, 'buildops_properties', allPropertyRows, 'id');
  const apiPropIds = properties.map(p => p.id);
  const tenantCustomerIds = [...new Set(properties.map(p => p.customerId).filter(Boolean))] as string[];
  if (tenantCustomerIds.length > 0 && apiPropIds.length > 0) {
    const { error: propDelErr } = await supabase
      .from('buildops_properties')
      .delete()
      .in('customer_id', tenantCustomerIds)
      .not('id', 'in', `(${apiPropIds.map(id => `'${id}'`).join(',')})`);
    if (propDelErr) console.warn(`property cleanup: ${propDelErr.message}`);
  }

  return { mode: 'incremental', rebuilt, skipped, properties_synced: allPropertyRows.length, representatives_replaced: relevantRepRows.length };
}
