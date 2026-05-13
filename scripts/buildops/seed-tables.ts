/**
 * Seed buildops_customers, buildops_properties, and buildops_representatives
 * from the live BuildOps API into Supabase.
 *
 * Prerequisites:
 *   1. Apply the migration:
 *      migrations/buildops/20260512_001_buildops_core_tables.sql
 *
 *   2. .env must contain:
 *      SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *      CLIENT_ID, CLIENT_SECRET, TENANT_ID   (BuildOps OAuth creds)
 *      INBOUND_PHONE                          (E.164 inbound line, e.g. +18041234567 — PK for buildops_tenants)
 *
 * Run:
 *   npx tsx scripts/buildops/seed-tables.ts
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// ─── env ──────────────────────────────────────────────────────────────────────

for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'CLIENT_ID', 'CLIENT_SECRET', 'TENANT_ID', 'INBOUND_PHONE'] as const) {
  if (!process.env[k]) { console.error(`Missing env var: ${k}`); process.exit(1); }
}

const SUPABASE_URL       = process.env.SUPABASE_URL!;
const SERVICE_ROLE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const CLIENT_ID          = process.env.CLIENT_ID!;
const CLIENT_SECRET      = process.env.CLIENT_SECRET!;
const TENANT_ID          = process.env.TENANT_ID!;       // BuildOps tenant UUID — tenant_id in all rows
const INBOUND_PHONE      = process.env.INBOUND_PHONE!;   // E.164 phone — PK for buildops_tenants

const BASE_URL   = 'https://public-api.live.buildops.com/v1';
const PAGE_SIZE  = 100;
const BATCH_SIZE = 200;

// ─── API types ────────────────────────────────────────────────────────────────

interface AuditInfo {
  createdDate?: string | null;
  createdDateTime?: number | null;
  lastUpdatedDate?: string | null;
  lastUpdatedDateTime?: number | null;
}

interface ApiAddress {
  id?: string;
  addressType?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  zipcode?: string | null;
  country?: string | null;
  latitude?: string | number | null;
  longitude?: string | number | null;
  status?: string | null;
  isActive?: boolean | null;
}

interface ApiCustomer {
  id: string;
  name: string;
  accountNumber?: string | null;
  customerType?: string | null;
  isActive?: boolean | null;
  email?: string | null;
  customerNumber?: string | null;
  creditLimit?: number | null;
  isTaxable?: boolean | null;
  taxRateValue?: string | null;
  status?: string | null;
  phonePrimary?: string | null;
  phoneAlternate?: string | null;
  receiveSMS?: boolean | null;
  invoiceDeliveryPref?: string | null;
  priceBookId?: string | null;
  paymentTermId?: string | null;
  invoicePresetId?: string | null;
  logoUrl?: string | null;
  websiteUrl?: string | null;
  version?: number | null;
  amountNotToExceed?: number | null;
  addresses?: { items?: ApiAddress[] } | ApiAddress[] | null;
  audit?: AuditInfo | null;
}

interface ApiProperty {
  id: string;
  companyName?: string | null;
  phonePrimary?: string | null;
  phoneAlternate?: string | null;
  customerId?: string | null;
  priceBookId?: string | null;
  isTaxable?: boolean | null;
  version?: number | null;
  audit?: AuditInfo | null;
  addresses?: ApiAddress[] | { items?: ApiAddress[] } | null;
}

interface ApiRep {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  cellPhone?: string | null;
  landlinePhone?: string | null;
  email?: string | null;
  isActive?: boolean | null;
  isDoNotCall?: boolean | null;
  isEmailOptOut?: boolean | null;
  isSmsOptOut?: boolean | null;
  version?: number | null;
  propertyId?: string | null;
  companyId?: string | null;
  audit?: AuditInfo | null;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function normalize(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '').slice(-10);
  return digits.length === 10 ? digits : null;
}

function addressList(raw: ApiCustomer['addresses'] | ApiProperty['addresses']): ApiAddress[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  return raw.items ?? [];
}

function primaryAddress(addrs: ApiAddress[]) {
  const a = addrs.find(x => x.addressType === 'propertyAddress') ?? addrs[0];
  return {
    line1:  a?.addressLine1 ?? null,
    line2:  a?.addressLine2 ?? null,
    city:   a?.city  ?? null,
    state:  a?.state ?? null,
    zip:    a?.zipcode ?? null,
  };
}

// ─── BuildOps API ─────────────────────────────────────────────────────────────

async function getAccessToken(): Promise<string> {
  const res = await fetch(`${BASE_URL}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, tenantId: TENANT_ID }),
  });
  if (!res.ok) throw new Error(`Auth failed (${res.status}): ${await res.text()}`);
  return (await res.json() as { access_token: string }).access_token;
}

function headers(token: string) {
  return { Authorization: `Bearer ${token}`, tenantId: TENANT_ID, Accept: 'application/json' };
}

async function fetchAllCustomers(token: string): Promise<ApiCustomer[]> {
  const all: ApiCustomer[] = [];
  let page = 0, total = Infinity;
  while (all.length < total) {
    const res = await fetch(`${BASE_URL}/customers?limit=${PAGE_SIZE}&page=${page}&include_inactive=true`, { headers: headers(token) });
    if (!res.ok) throw new Error(`Customers page ${page}: ${res.status}`);
    const data = await res.json() as { totalCount?: number; items?: ApiCustomer[] };
    if (page === 0) total = data.totalCount ?? 0;
    const items = data.items ?? [];
    all.push(...items);
    process.stdout.write(`\r  customers: ${all.length}/${total}`);
    if (items.length < PAGE_SIZE) break;
    page++;
  }
  console.log();
  return all;
}

async function fetchAllProperties(token: string): Promise<ApiProperty[]> {
  const all: ApiProperty[] = [];
  let page = 0, total = Infinity;
  while (all.length < total) {
    const res = await fetch(`${BASE_URL}/properties?include_addresses=true&page=${page}&page_size=${PAGE_SIZE}`, { headers: headers(token) });
    if (!res.ok) throw new Error(`Properties page ${page}: ${res.status}`);
    const data = await res.json() as { totalCount?: number; items?: ApiProperty[] };
    if (page === 0) total = data.totalCount ?? 0;
    const items = data.items ?? [];
    all.push(...items);
    process.stdout.write(`\r  properties: ${all.length}/${total}`);
    if (items.length < PAGE_SIZE) break;
    page++;
  }
  console.log();
  return all;
}

async function fetchReps(token: string, customerId: string): Promise<ApiRep[]> {
  const all: ApiRep[] = [];
  let page = 0;
  while (true) {
    const res = await fetch(`${BASE_URL}/customers/${customerId}/our-representatives?page=${page}&page_size=${PAGE_SIZE}`, { headers: headers(token) });
    if (!res.ok) break;
    const items = ((await res.json()) as { items?: ApiRep[] }).items ?? [];
    all.push(...items);
    if (items.length < PAGE_SIZE) break;
    page++;
  }
  return all;
}

// ─── Supabase upsert ──────────────────────────────────────────────────────────

async function upsert(supabase: SupabaseClient, table: string, rows: object[], onConflict: string) {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from(table).upsert(batch as never[], { onConflict });
    if (error) throw new Error(`[${table}] batch ${Math.floor(i / BATCH_SIZE) + 1}: ${error.message}`);
    process.stdout.write(`\r  ${table}: ${Math.min(i + BATCH_SIZE, rows.length)}/${rows.length}`);
  }
  process.stdout.write('\n');
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  console.log(`BuildOps → Supabase seed  (tenant: ${TENANT_ID})\n`);

  console.log('Authenticating …');
  const token = await getAccessToken();
  console.log('Token acquired.\n');

  // 0. Tenant row — credentials come from env, access_token from the auth call above
  const { error: tenantErr } = await supabase
    .from('buildops_tenants')
    .upsert(
      { no: INBOUND_PHONE, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, access_token: token, buildops_tenant_id: TENANT_ID },
      { onConflict: 'no' },
    );
  if (tenantErr) throw new Error(`buildops_tenants: ${tenantErr.message}`);
  console.log(`Tenant upserted  (no: ${INBOUND_PHONE})\n`);

  // 1. Properties — fetch first so we can enrich customers
  console.log('Fetching properties …');
  const properties = await fetchAllProperties(token);

  // Build maps keyed by BuildOps customer UUID
  const propsByCustomer = new Map<string, ApiProperty[]>();
  const propPhonesByCustomer = new Map<string, Array<{ phone: string; source: string }>>();

  for (const p of properties) {
    if (!p.customerId) continue;
    const cid = p.customerId;

    const list = propsByCustomer.get(cid) ?? [];
    list.push(p);
    propsByCustomer.set(cid, list);

    const phones = propPhonesByCustomer.get(cid) ?? [];
    const ph1 = normalize(p.phonePrimary);
    const ph2 = normalize(p.phoneAlternate);
    if (ph1) phones.push({ phone: ph1, source: `property:phonePrimary:${p.id}` });
    if (ph2) phones.push({ phone: ph2, source: `property:phoneAlternate:${p.id}` });
    propPhonesByCustomer.set(cid, phones);
  }

  // Seed buildops_properties
  const propertyRows = properties
    .filter(p => p.customerId)
    .map(p => ({
      id:            p.id,
      name:          p.companyName ?? null,
      phone_primary: p.phonePrimary ?? null,
      customer_id:   p.customerId!,
      address:       primaryAddress(addressList(p.addresses)),
    }));

  console.log(`\nUpserting ${propertyRows.length} properties …`);
  await upsert(supabase, 'buildops_properties', propertyRows, 'id');

  // 2. Customers + reps (reps require a per-customer API call)
  console.log('\nFetching customers …');
  const customers = await fetchAllCustomers(token);

  const customerRows: object[] = [];
  const repRows: object[] = [];

  console.log(`\nFetching representatives for ${customers.length} customers …`);
  for (let i = 0; i < customers.length; i++) {
    const c = customers[i];
    process.stdout.write(`\r  ${i + 1}/${customers.length}  (${c.name.slice(0, 40)})`);

    const reps = await fetchReps(token, c.id);

    // Build all_numbers (customer phones → rep phones → property phones, first source wins)
    type PhoneEntry = { phone: string; source: string };
    const entries: PhoneEntry[] = [];
    const push = (phone: string | null | undefined, source: string) => {
      const n = normalize(phone);
      if (n) entries.push({ phone: n, source });
    };
    push(c.phonePrimary,   'customer:phonePrimary');
    push(c.phoneAlternate, 'customer:phoneAlternate');
    for (const r of reps) {
      const name = [r.firstName, r.lastName].filter(Boolean).join(' ') || 'Unknown';
      push(r.cellPhone,    `rep:cellPhone:${name}`);
      push(r.landlinePhone, `rep:landlinePhone:${name}`);
    }
    for (const e of propPhonesByCustomer.get(c.id) ?? []) entries.push(e);

    const seen = new Set<string>();
    const allNumbers: string[] = [], allSources: string[] = [];
    for (const e of entries) {
      if (!seen.has(e.phone)) { seen.add(e.phone); allNumbers.push(e.phone); allSources.push(e.source); }
    }

    // Addresses embedded in customer API response
    const custAddrs = addressList(c.addresses).map(a => ({
      id:           a.id,
      addressLine1: a.addressLine1 ?? null,
      addressLine2: a.addressLine2 ?? null,
      city:         a.city ?? null,
      state:        a.state ?? null,
      zipcode:      a.zipcode ?? null,
      addressType:  a.addressType ?? null,
    }));

    // Properties summary embedded in customer row
    const propsSummary = (propsByCustomer.get(c.id) ?? []).map(p => ({
      id:           p.id,
      companyName:  p.companyName ?? null,
      phonePrimary: p.phonePrimary ?? null,
      priceBookId:  p.priceBookId ?? null,
      isTaxable:    p.isTaxable ?? false,
      version:      p.version ?? 0,
      addresses:    addressList(p.addresses).map(a => ({
        addressLine1: a.addressLine1 ?? null,
        addressLine2: a.addressLine2 ?? null,
        city:         a.city ?? null,
        state:        a.state ?? null,
        zipcode:      a.zipcode ?? null,
        addressType:  a.addressType ?? null,
      })),
    }));

    // Reps summary embedded in customer row
    const repsSummary = reps.map(r => ({
      id:            r.id,
      firstName:     r.firstName ?? null,
      lastName:      r.lastName  ?? null,
      cellPhone:     r.cellPhone ?? null,
      landlinePhone: r.landlinePhone ?? null,
      email:         r.email ?? null,
      propertyId:    r.propertyId ?? r.companyId ?? null,
      isActive:      r.isActive ?? true,
      isDoNotCall:   r.isDoNotCall ?? false,
      version:       r.version ?? 0,
    }));

    customerRows.push({
      buildops_customer_id:       c.id,
      tenant_id:                  TENANT_ID,
      name:                       c.name,
      account_number:             c.accountNumber ?? null,
      customer_type:              c.customerType ?? null,
      is_active:                  c.isActive ?? true,
      email:                      c.email ?? null,
      customer_number:            c.customerNumber ?? null,
      credit_limit:               c.creditLimit ?? null,
      is_taxable:                 c.isTaxable ?? null,
      tax_rate_value:             c.taxRateValue != null ? parseFloat(c.taxRateValue) : null,
      status:                     c.status ?? null,
      phone_primary:              c.phonePrimary ?? null,
      normalized_phone_primary:   normalize(c.phonePrimary),
      phone_secondary:            c.phoneAlternate ?? null,
      normalized_phone_secondary: normalize(c.phoneAlternate),
      receive_sms:                c.receiveSMS ?? null,
      invoice_delivery_pref:      c.invoiceDeliveryPref ?? null,
      price_book_id:              c.priceBookId ?? null,
      payment_term_id:            c.paymentTermId ?? null,
      invoice_preset_id:          c.invoicePresetId ?? null,
      logo_url:                   c.logoUrl ?? null,
      website_url:                c.websiteUrl ?? null,
      version:                    c.version ?? null,
      amount_not_to_exceed:       c.amountNotToExceed ?? null,
      buildops_last_updated_at:   c.audit?.lastUpdatedDateTime ?? null,
      buildops_created_at:        c.audit?.createdDateTime ?? null,
      all_numbers:                allNumbers,
      all_numbers_sources:        allSources,
      addresses:                  custAddrs,
      representatives:            repsSummary,
      properties:                 propsSummary,
    });

    for (const r of reps) {
      repRows.push({
        tenant_id:                  TENANT_ID,
        customer_id:                c.id,
        property_id:                r.propertyId ?? r.companyId ?? '',
        first_name:                 r.firstName ?? '',
        last_name:                  r.lastName  ?? '',
        cell_phone:                 r.cellPhone  ?? null,
        landline_phone:             r.landlinePhone ?? null,
        normalized_cell_phone:      normalize(r.cellPhone),
        normalized_landline_phone:  normalize(r.landlinePhone),
        email:                      r.email ?? null,
        is_active:                  r.isActive ?? true,
        is_do_not_call:             r.isDoNotCall ?? false,
        is_email_opt_out:           r.isEmailOptOut ?? false,
        is_sms_opt_out:             r.isSmsOptOut ?? false,
        version:                    r.version ?? 0,
        created_at:                 r.audit?.createdDate ?? null,
        updated_at:                 r.audit?.lastUpdatedDate ?? null,
      });
    }
  }
  console.log();

  console.log(`\nUpserting ${customerRows.length} customers …`);
  await upsert(supabase, 'buildops_customers', customerRows, 'tenant_id,buildops_customer_id');

  // Representatives have no unique constraint — clear for this tenant then re-insert
  console.log(`\nUpserting ${repRows.length} representatives …`);
  const { error: delErr } = await supabase
    .from('buildops_representatives')
    .delete()
    .eq('tenant_id', TENANT_ID);
  if (delErr) throw new Error(`Clear reps: ${delErr.message}`);
  if (repRows.length > 0) {
    for (let i = 0; i < repRows.length; i += BATCH_SIZE) {
      const batch = repRows.slice(i, i + BATCH_SIZE);
      const { error } = await supabase.from('buildops_representatives').insert(batch as never[]);
      if (error) throw new Error(`[buildops_representatives] batch ${Math.floor(i / BATCH_SIZE) + 1}: ${error.message}`);
      process.stdout.write(`\r  buildops_representatives: ${Math.min(i + BATCH_SIZE, repRows.length)}/${repRows.length}`);
    }
    console.log();
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error('\nFailed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
