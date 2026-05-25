// @ts-nocheck — Deno runtime file; npm: imports won't resolve in Node TS.
/**
 * Supabase Edge Function — BuildOps data sync (deployed as buildops_cron).
 * Triggered by pg_cron on a schedule. For each configured tenant it runs:
 *   1. fullSeed()         — on first run (buildops_customers empty): fetches all customers,
 *                           properties, and representatives, upserts to Supabase.
 *   2. incrementalSync()  — on subsequent runs: dirty-detection via rep/property/timestamp
 *                           changes, only rebuilds changed customers. Early-stop optimization.
 *   3. jobsSync()         — every run: watermark-based incremental fetch of updated jobs.
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

async function fetchAllCustomers(token: string, tenantId: string): Promise<ApiCustomer[]> {
  const all: ApiCustomer[] = [];
  let page = 1; // customers API is 1-based; page=0 returns the same items as page=1
  while (true) {
    const res = await fetchWithRetry(`${BASE_URL}/customers?limit=${PAGE_SIZE}&page=${page}&include_inactive=true`, { headers: apiHeaders(token, tenantId) });
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
    push(r.cellPhone,    `rep:cellPhone:${name}${propSuffix}`);
    push(r.landlinePhone, `rep:landlinePhone:${name}${propSuffix}`);
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

      const [tenantResult, jobsResult] = await Promise.all([
        (count ?? 0) === 0
          ? fullSeed(supabase, token, tenantId)
          : incrementalSync(supabase, token, tenantId),
        jobsSync(supabase, token, tenantId),
      ]);

      results.push({ tenant: inboundPhone, ...tenantResult, jobs: jobsResult });
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

// ─── Full seed ────────────────────────────────────────────────────────────────

async function fullSeed(supabase: SupabaseClient, token: string, tenantId: string): Promise<Record<string, unknown>> {
  // Fetch properties and customers in parallel — fully independent API calls.
  // Properties are upserted AFTER customers to satisfy the FK constraint.
  const [{ properties, propMap, propPhoneMap }, customers] = await Promise.all([
    fetchAllProperties(token, tenantId),
    fetchAllCustomers(token, tenantId),
  ]);

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

  // Customers first — properties and reps have FK references to buildops_customers
  await batchUpsert(supabase, 'buildops_customers', dedupedCustomerRows, 'tenant_id,buildops_customer_id');

  const propertyRows = properties.filter(p => p.customerId).map(buildPropertyRow);
  if (propertyRows.length > 0) await batchUpsert(supabase, 'buildops_properties', propertyRows, 'id');

  // No dedup needed — we clear all reps before re-inserting, so no conflicts possible
  const { error: delErr } = await supabase.from('buildops_representatives').delete().eq('tenant_id', tenantId);
  if (delErr) throw new Error(`clear reps: ${delErr.message}`);
  if (repRows.length > 0) await batchInsert(supabase, 'buildops_representatives', repRows);

  await updateRepresentativeIds(supabase, tenantId, customers.map(c => c.id));

  // Refresh representative_ids on ALL properties — full delete means every property's array is stale
  const allPropIds = propertyRows.map((p: any) => p.id as string);
  await updatePropertyRepresentativeIds(supabase, tenantId, allPropIds);

  return { mode: 'full', properties: propertyRows.length, customers: dedupedCustomerRows.length, representatives: repRows.length };
}

// ─── Incremental sync ─────────────────────────────────────────────────────────

async function incrementalSync(supabase: SupabaseClient, token: string, tenantId: string): Promise<Record<string, unknown>> {
  // Load per-customer watermarks and versions from DB (Fix 1)
  const REP_SWEEP_INTERVAL_MS = 2 * 60 * 60 * 1000;
  const { data: tenantMeta } = await supabase
    .from('buildops_tenants')
    .select('last_rep_sweep_at')
    .eq('buildops_tenant_id', tenantId)
    .maybeSingle();
  const lastSweep = tenantMeta?.last_rep_sweep_at
    ? new Date(tenantMeta.last_rep_sweep_at as string).getTime() : 0;
  const doRepSweep = Date.now() - lastSweep > REP_SWEEP_INTERVAL_MS;

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
    const res = await fetchWithRetry(
      `${BASE_URL}/customers?limit=100&page=${page}&include_inactive=true`,
      { headers: apiHeaders(token, tenantId) },
    );
    if (!res.ok) throw new Error(`customers page ${page}: ${res.status}`);
    const data = await res.json() as { items?: ApiCustomer[] };
    const items = data.items ?? [];
    if (items.length === 0) break;

    const deletedCustomerIds: string[] = [];
    const liveItems = items.filter(c => {
      if (c.audit?.deletedDateTime) { deletedCustomerIds.push(c.id); return false; }
      return true;
    });
    if (deletedCustomerIds.length > 0) {
      await supabase.from('buildops_customers').delete()
        .eq('tenant_id', tenantId)
        .in('buildops_customer_id', deletedCustomerIds);
    }

    // Dirty if: in dirtySet, own timestamp > per-customer watermark, version advanced, new customer, or no reps synced yet
    const dirtyItems = liveItems.filter(c => {
      const db = dbCustomerMap.get(c.id);
      const dbRepIds: string[] = db?.repIds ?? [];
      return dirtySet.has(c.id)
        || (c.audit?.lastUpdatedDateTime ?? 0) > (db?.ts ?? 0)
        || (c.version ?? 0) > (db?.version ?? 0)
        || !db
        || dbRepIds.length === 0;
    });
    skipped += liveItems.length - dirtyItems.length;

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

  // Capture old property IDs before deleting — needed to zero out arrays for properties that lose all reps
  let oldPropIdsIncremental: string[] = [];
  if (rebuiltCustomerIds.size > 0) {
    const { data: oldRepProps } = await supabase
      .from('buildops_representatives')
      .select('property_id')
      .eq('tenant_id', tenantId)
      .in('customer_id', [...rebuiltCustomerIds]);
    oldPropIdsIncremental = [...new Set(
      (oldRepProps ?? []).map((r: { property_id: string | null }) => r.property_id).filter(Boolean) as string[],
    )];
  }

  for (const customerId of rebuiltCustomerIds) {
    const { error: delErr } = await supabase.from('buildops_representatives').delete().eq('tenant_id', tenantId).eq('customer_id', customerId);
    if (delErr) throw new Error(`clear reps for ${customerId}: ${delErr.message}`);
  }
  const relevantRepRows = repRows.filter(r => rebuiltCustomerIds.has((r as { customer_id: string }).customer_id));
  if (relevantRepRows.length > 0) await batchInsert(supabase, 'buildops_representatives', relevantRepRows);

  if (rebuiltCustomerIds.size > 0) {
    await updateRepresentativeIds(supabase, tenantId, [...rebuiltCustomerIds]);
    const newPropIds = [...new Set((relevantRepRows as any[]).map(r => r.property_id).filter(Boolean) as string[])];
    const allAffectedPropIds = [...new Set([...oldPropIdsIncremental, ...newPropIds])];
    await updatePropertyRepresentativeIds(supabase, tenantId, allAffectedPropIds);
  }

  // Upsert all properties and delete any that no longer exist in the API (Fix 6)
  const allPropertyRows = properties.filter(p => p.customerId).map(buildPropertyRow);
  if (allPropertyRows.length > 0) await batchUpsert(supabase, 'buildops_properties', allPropertyRows, 'id');
  const apiPropIds = properties.map(p => p.id);
  const tenantCustomerIds = [...new Set(properties.map(p => p.customerId).filter(Boolean))] as string[];
  if (tenantCustomerIds.length > 0) {
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
      const apiPropIdSet = new Set(apiPropIds);
      const toDelete = existingPropIds.filter(id => !apiPropIdSet.has(id));
      if (toDelete.length > 0) {
        const { error: propDelErr } = await supabase.from('buildops_properties').delete().in('id', toDelete);
        if (propDelErr) console.warn(`property cleanup: ${propDelErr.message}`);
      }
    }
  }

  let sweptCount: number | 'skipped' = 'skipped';
  if (doRepSweep) {
    const toSweep = [...dbCustomerMap.keys()].filter(id => !rebuiltCustomerIds.has(id));
    const { swept } = await sweepAllReps(supabase, token, tenantId, toSweep);
    sweptCount = swept;
    await supabase.from('buildops_tenants')
      .update({ last_rep_sweep_at: new Date().toISOString() })
      .eq('buildops_tenant_id', tenantId);
  }

  return { mode: 'incremental', rebuilt, skipped, properties_synced: allPropertyRows.length, representatives_replaced: relevantRepRows.length, rep_sweep: sweptCount };
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

// ─── Rep sweep ────────────────────────────────────────────────────────────────

async function sweepAllReps(
  supabase: SupabaseClient,
  token: string,
  tenantId: string,
  customerIds: string[],
): Promise<{ swept: number }> {
  if (customerIds.length === 0) return { swept: 0 };

  const { data: dbRepRows } = await supabase
    .from('buildops_customers')
    .select('buildops_customer_id, representative_ids')
    .eq('tenant_id', tenantId)
    .in('buildops_customer_id', customerIds);

  const dbRepCountMap = new Map(
    (dbRepRows ?? []).map(r => {
      const raw = r.representative_ids;
      const ids = Array.isArray(raw) ? raw as string[] : JSON.parse(typeof raw === 'string' ? raw : '[]') as string[];
      return [r.buildops_customer_id as string, ids.length];
    })
  );

  const apiRepsMap = await fetchRepsForAll(token, tenantId, customerIds);

  // Compare rep COUNT — API rep IDs and DB representative_ids are in different namespaces
  // (BuildOps UUIDs vs Supabase row UUIDs), so count is the correct signal here.
  // Existing-rep updates (phone changes) are caught by the DB-side rep.updated_at dirty check.
  const changedIds: string[] = [];
  for (const [customerId, apiReps] of apiRepsMap) {
    const dbCount = dbRepCountMap.get(customerId) ?? 0;
    if (apiReps.length !== dbCount) {
      changedIds.push(customerId);
    }
  }

  if (changedIds.length === 0) return { swept: 0 };

  // Capture old property IDs before deleting — properties that lose all reps need their array zeroed
  const { data: oldRepProps } = await supabase
    .from('buildops_representatives')
    .select('property_id')
    .eq('tenant_id', tenantId)
    .in('customer_id', changedIds);
  const oldPropIds = [...new Set(
    (oldRepProps ?? []).map((r: { property_id: string | null }) => r.property_id).filter(Boolean) as string[],
  )];

  const repRows: object[] = [];
  for (const customerId of changedIds) {
    for (const r of apiRepsMap.get(customerId) ?? []) {
      repRows.push(buildRepRow(r, customerId, tenantId));
    }
    await supabase.from('buildops_representatives').delete()
      .eq('tenant_id', tenantId).eq('customer_id', customerId);
  }
  if (repRows.length > 0) await batchInsert(supabase, 'buildops_representatives', repRows);
  await updateRepresentativeIds(supabase, tenantId, changedIds);

  const newPropIds = [...new Set((repRows as any[]).map(r => r.property_id).filter(Boolean) as string[])];
  await updatePropertyRepresentativeIds(supabase, tenantId, [...new Set([...oldPropIds, ...newPropIds])]);

  return { swept: changedIds.length };
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
