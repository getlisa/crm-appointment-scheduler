import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const CLIENT_ID     = process.env.CLIENT_ID!;
const CLIENT_SECRET = process.env.CLIENT_SECRET!;
const TENANT_ID     = process.env.TENANT_ID!;
const BASE_URL      = 'https://public-api.live.buildops.com/v1';
const LIMIT         = 100;

const CSV_FIELDS = [
  'id', 'name', 'accountNumber', 'customerType', 'isActive', 'email',
  'customerNumber', 'creditLimit', 'isTaxable', 'taxRateValue', 'status',
  'phonePrimary', 'phoneAlternate', 'receiveSMS', 'invoiceDeliveryPref',
  'priceBookId', 'paymentTermId', 'invoicePresetId',
  'logoUrl', 'websiteUrl', 'version', 'tenantId', 'tenantCompanyId', 'amountNotToExceed',
  'all_numbers',
  'all_numbers_sources',
  'addresses_all',
  'properties_all',
];

type PhoneEntry = { phone: string; source: string };

function normalize(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '').slice(-10);
  return digits.length === 10 ? digits : null;
}

function toCSVRows(items: Record<string, unknown>[]): string[] {
  const escape = (val: unknown) => {
    const str = val == null ? '' : String(val);
    return str.includes(',') || str.includes('"') || str.includes('\n')
      ? `"${str.replace(/"/g, '""')}"`
      : str;
  };
  return items.map(item => CSV_FIELDS.map(f => escape(item[f])).join(','));
}

async function getAccessToken(): Promise<string> {
  const response = await fetch(`${BASE_URL}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, tenantId: TENANT_ID }),
  });
  if (!response.ok) throw new Error(`Auth failed (${response.status})`);
  return (await response.json()).access_token;
}

async function fetchPage(token: string, page: number): Promise<{ totalCount: number; items: Record<string, unknown>[] }> {
  const params = new URLSearchParams({ limit: String(LIMIT), page: String(page), include_inactive: 'true' });
  const response = await fetch(`${BASE_URL}/customers?${params}`, {
    headers: { Authorization: `Bearer ${token}`, tenantId: TENANT_ID, Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Page ${page} failed (${response.status})`);
  return response.json();
}

async function fetchRepresentativePhones(token: string, customerId: string): Promise<PhoneEntry[]> {
  const entries: PhoneEntry[] = [];
  let page = 0;
  while (true) {
    const res = await fetch(`${BASE_URL}/customers/${customerId}/our-representatives?page=${page}&page_size=100`, {
      headers: { Authorization: `Bearer ${token}`, tenantId: TENANT_ID, Accept: 'application/json' },
    });
    if (!res.ok) break;
    const data = await res.json();
    const items: Record<string, unknown>[] = data.items ?? [];
    for (const rep of items) {
      const repName = [rep['firstName'], rep['lastName']].filter(Boolean).join(' ') || 'Unknown';
      const cell = normalize(rep['cellPhone'] as string);
      const land = normalize(rep['landlinePhone'] as string);
      if (cell) entries.push({ phone: cell, source: `rep:cellPhone:${repName}` });
      if (land) entries.push({ phone: land, source: `rep:landlinePhone:${repName}` });
    }
    if (items.length < 100) break;
    page++;
  }
  return entries;
}

function loadPropertyPhoneMap(outDir: string): Map<string, PhoneEntry[]> {
  const csvPath = path.resolve(outDir, 'properties.csv');
  if (!fs.existsSync(csvPath)) {
    console.warn('Warning: properties.csv not found — property phones will be omitted. Run get_all_properties.ts first.');
    return new Map();
  }
  const lines = fs.readFileSync(csvPath, 'utf-8').trim().split('\n');
  const headers = lines[0].split(',');
  const idIdx       = headers.indexOf('id');
  const cidIdx      = headers.indexOf('customerId');
  const phoneIdx    = headers.indexOf('phonePrimary');
  const phoneAltIdx = headers.indexOf('phoneAlternate');

  const map = new Map<string, PhoneEntry[]>();
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const cid = cols[cidIdx]?.trim();
    if (!cid) continue;
    const propertyId = cols[idIdx]?.trim() || 'unknown';
    const entries = map.get(cid) ?? [];
    const p1 = normalize(cols[phoneIdx]);
    const p2 = normalize(cols[phoneAltIdx]);
    if (p1) entries.push({ phone: p1, source: `property:phonePrimary:${propertyId}` });
    if (p2) entries.push({ phone: p2, source: `property:phoneAlternate:${propertyId}` });
    map.set(cid, entries);
  }
  return map;
}

function loadPropertyIdMap(outDir: string): Map<string, string[]> {
  const csvPath = path.resolve(outDir, 'properties.csv');
  if (!fs.existsSync(csvPath)) return new Map();
  const lines = fs.readFileSync(csvPath, 'utf-8').trim().split('\n');
  const headers = lines[0].split(',');
  const idIdx  = headers.indexOf('id');
  const cidIdx = headers.indexOf('customerId');
  const map = new Map<string, string[]>();
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const cid = cols[cidIdx]?.trim();
    const pid = cols[idIdx]?.trim();
    if (!cid || !pid) continue;
    const ids = map.get(cid) ?? [];
    ids.push(pid);
    map.set(cid, ids);
  }
  return map;
}

async function getAllCustomers() {
  const token = await getAccessToken();
  console.log('Token acquired.');

  const first = await fetchPage(token, 1);
  const totalCount: number = first.totalCount;
  const totalPages = Math.ceil(totalCount / LIMIT);
  console.log(`Total customers: ${totalCount} — fetching ${totalPages} page(s)...`);

  const allItems: Record<string, unknown>[] = [...first.items];
  for (let page = 2; page <= totalPages; page++) {
    const { items } = await fetchPage(token, page);
    if (items.length === 0) break;
    allItems.push(...items);
    process.stdout.write(`\rFetched ${allItems.length}/${totalCount}`);
  }
  if (totalPages > 1) console.log();

  const outDir = path.resolve(__dirname, '../output');
  fs.mkdirSync(outDir, { recursive: true });

  const propPhoneMap = loadPropertyPhoneMap(outDir);
  const propIdMap    = loadPropertyIdMap(outDir);

  // Build all_numbers, addresses_all, properties_all per customer
  console.log('\nFetching representative phones (this may take a while)...');

  for (let i = 0; i < allItems.length; i++) {
    const c = allItems[i];
    const cid = c['id'] as string;

    process.stdout.write(`\r  Representatives: ${i + 1}/${allItems.length}`);

    const repEntries = await fetchRepresentativePhones(token, cid);
    const propEntries = propPhoneMap.get(cid) ?? [];

    const rawEntries: PhoneEntry[] = [
      { phone: normalize(c['phonePrimary'] as string) ?? '', source: 'customer:phonePrimary' },
      { phone: normalize(c['phoneAlternate'] as string) ?? '', source: 'customer:phoneAlternate' },
      ...repEntries,
      ...propEntries,
    ].filter(e => e.phone !== '');

    // Deduplicate: first source wins (customer > rep > property)
    const seen = new Set<string>();
    const allNumbers: string[] = [];
    const allSources: string[] = [];
    for (const e of rawEntries) {
      if (!seen.has(e.phone)) {
        seen.add(e.phone);
        allNumbers.push(e.phone);
        allSources.push(e.source);
      }
    }

    c['all_numbers'] = JSON.stringify(allNumbers);
    c['all_numbers_sources'] = JSON.stringify(allSources);

    // addresses_all — from the inline addresses object returned by the list endpoint
    const addrObj = c['addresses'] as { items?: Record<string, unknown>[] } | null;
    const addrItems = addrObj?.items ?? [];
    const addressesAll = addrItems.map(a => ({
      id: a['id'],
      addressLine1: a['addressLine1'],
      addressLine2: a['addressLine2'],
      city: a['city'],
      state: a['state'],
      zipcode: a['zipcode'],
      addressType: a['addressType'],
    }));
    c['addresses_all'] = JSON.stringify(addressesAll);

    // properties_all — IDs of BuildOps properties linked to this customer
    c['properties_all'] = JSON.stringify(propIdMap.get(cid) ?? []);
  }
  console.log();

  // Write CSV
  const lines = [CSV_FIELDS.join(','), ...toCSVRows(allItems)];
  const outPath = path.resolve(outDir, 'customers.csv');
  fs.writeFileSync(outPath, lines.join('\n'), 'utf-8');
  console.log(`\nCSV written: ${outPath} (${allItems.length} rows)`);
}

getAllCustomers().catch(console.error);
