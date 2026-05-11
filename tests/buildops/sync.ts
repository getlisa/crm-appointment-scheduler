import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const CLIENT_ID     = process.env.CLIENT_ID!;
const CLIENT_SECRET = process.env.CLIENT_SECRET!;
const TENANT_ID     = process.env.TENANT_ID!;
const BASE_URL      = 'https://public-api.live.buildops.com/v1';
const LIMIT         = 100;

const PROPERTY_FIELDS = [
  'id', 'companyName', 'accountNumber', 'customerPropertyTypeValue', 'status',
  'email', 'phonePrimary', 'phoneAlternate', 'customerId', 'billingCustomerId',
  'priceBookId', 'isTaxable', 'taxRateValue', 'taxRateName', 'taxRateId',
  'amountNotToExceed', 'receiveSMS', 'sameAddress', 'version', 'tenantId', 'tenantCompanyId',
];

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
type SyncState  = {
  lastRunAt:       string | null;
  lastSyncedMs:    number;
  versions:        Record<string, number>;
  propertyVersions: Record<string, number>;
};

function normalize(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '').slice(-10);
  return digits.length === 10 ? digits : null;
}

function escape(val: unknown): string {
  const str = val == null ? '' : String(val);
  return str.includes(',') || str.includes('"') || str.includes('\n')
    ? `"${str.replace(/"/g, '""')}"`
    : str;
}

function toCSVRow(item: Record<string, unknown>): string {
  return CSV_FIELDS.map(f => escape(item[f])).join(',');
}

// Handles RFC 4180 quoting (including escaped double-quotes inside quoted fields)
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      let field = '';
      i++;
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') { field += '"'; i += 2; }
        else if (line[i] === '"') { i++; break; }
        else { field += line[i++]; }
      }
      fields.push(field);
      if (line[i] === ',') i++;
    } else {
      const end = line.indexOf(',', i);
      if (end === -1) { fields.push(line.slice(i)); break; }
      fields.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return fields;
}

async function getAccessToken(): Promise<string> {
  const res = await fetch(`${BASE_URL}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, tenantId: TENANT_ID }),
  });
  if (!res.ok) throw new Error(`Auth failed (${res.status})`);
  return (await res.json()).access_token;
}

async function fetchPage(token: string, page: number): Promise<{ totalCount: number; items: Record<string, unknown>[] }> {
  const params = new URLSearchParams({ limit: String(LIMIT), page: String(page), include_inactive: 'true' });
  const res = await fetch(`${BASE_URL}/customers?${params}`, {
    headers: { Authorization: `Bearer ${token}`, tenantId: TENANT_ID, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Page ${page} failed (${res.status})`);
  return res.json();
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

const EMPTY_STATE: SyncState = { lastRunAt: null, lastSyncedMs: 0, versions: {}, propertyVersions: {} };

function loadSyncState(outDir: string): SyncState {
  const p = path.resolve(outDir, 'sync_state.json');
  if (!fs.existsSync(p)) return { ...EMPTY_STATE };
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as Partial<SyncState>;
    return { ...EMPTY_STATE, ...parsed };
  }
  catch { return { ...EMPTY_STATE }; }
}

function loadExistingRows(outDir: string): Map<string, Record<string, unknown>> {
  const csvPath = path.resolve(outDir, 'customers.csv');
  if (!fs.existsSync(csvPath)) return new Map();
  const lines = fs.readFileSync(csvPath, 'utf-8').trim().split('\n');
  const headers = parseCSVLine(lines[0]);
  const idIdx = headers.indexOf('id');
  if (idIdx === -1) return new Map();
  const map = new Map<string, Record<string, unknown>>();
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const id = cols[idIdx]?.trim();
    if (!id) continue;
    const row: Record<string, unknown> = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = cols[j] ?? '';
    map.set(id, row);
  }
  return map;
}

async function syncProperties(
  token: string,
  syncState: SyncState,
  outDir: string,
): Promise<Record<string, number>> {
  const csvPath = path.resolve(outDir, 'properties.csv');

  // Load stored property rows for version comparison
  const storedProps = new Map<string, Record<string, unknown>>();
  if (fs.existsSync(csvPath)) {
    const lines = fs.readFileSync(csvPath, 'utf-8').trim().split('\n');
    const headers = lines[0].split(',');
    const idIdx = headers.indexOf('id');
    if (idIdx !== -1) {
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',');
        const id = cols[idIdx]?.trim();
        if (id) {
          const row: Record<string, unknown> = {};
          for (let j = 0; j < headers.length; j++) row[headers[j]] = cols[j] ?? '';
          storedProps.set(id, row);
        }
      }
    }
  }

  // Fetch all properties from BuildOps API
  process.stdout.write('Syncing properties... ');
  const allProps: Record<string, unknown>[] = [];
  let page = 0;
  while (true) {
    const res = await fetch(`${BASE_URL}/properties?include_addresses=false&page=${page}&page_size=100`, {
      headers: { Authorization: `Bearer ${token}`, tenantId: TENANT_ID, Accept: 'application/json' },
    });
    if (!res.ok) { console.warn(`page ${page} failed (${res.status})`); break; }
    const data = await res.json();
    const items: Record<string, unknown>[] = data.items ?? [];
    allProps.push(...items);
    if (items.length < 100) break;
    page++;
  }

  let propUpdated = 0;
  const newPropertyVersions: Record<string, number> = {};

  for (const p of allProps) {
    const pid    = p['id'] as string;
    const apiVer = p['version'] as number;
    newPropertyVersions[pid] = apiVer;

    if (apiVer === syncState.propertyVersions[pid] && storedProps.has(pid)) continue;

    // Property changed — mark parent customer dirty so customer loop re-fetches their reps
    const cid = p['customerId'] as string | undefined;
    if (cid) syncState.versions[cid] = -1;
    propUpdated++;
  }

  if (propUpdated > 0) {
    const rows = allProps.map(p => PROPERTY_FIELDS.map(f => escape(p[f])).join(','));
    fs.writeFileSync(csvPath, [PROPERTY_FIELDS.join(','), ...rows].join('\n'), 'utf-8');
  }
  console.log(`${propUpdated} updated, ${allProps.length - propUpdated} unchanged`);

  return newPropertyVersions;
}

async function runSync() {
  const token = await getAccessToken();
  console.log('Token acquired.');

  const outDir = path.resolve(__dirname, 'output');
  fs.mkdirSync(outDir, { recursive: true });

  const syncState    = loadSyncState(outDir);
  const existingRows = loadExistingRows(outDir);

  console.log(`Last sync: ${syncState.lastRunAt ?? 'never (first run)'}`);

  // Sync properties first — updates properties.csv and marks dirty customers in syncState.versions
  const newPropertyVersions = await syncProperties(token, syncState, outDir);

  // Load property maps from the (now-updated) properties.csv
  const propPhoneMap = loadPropertyPhoneMap(outDir);
  const propIdMap    = loadPropertyIdMap(outDir);

  const first = await fetchPage(token, 1);
  const totalCount: number = first.totalCount;
  const totalPages = Math.ceil(totalCount / LIMIT);
  console.log(`\nTotal customers: ${totalCount} — scanning ${totalPages} page(s)...`);

  const allItems: Record<string, unknown>[] = [...first.items];
  for (let page = 2; page <= totalPages; page++) {
    const { items } = await fetchPage(token, page);
    if (items.length === 0) break;
    allItems.push(...items);
    process.stdout.write(`\rFetched ${allItems.length}/${totalCount}`);

    // Early stop: if every item on this page is older than last sync AND version unchanged, no need to continue
    const allStale = items.every(c => {
      const audit = c['audit'] as Record<string, unknown> | undefined;
      const ms = audit?.['lastUpdatedDateTime'] as number | undefined;
      return ms !== undefined
        && ms <= syncState.lastSyncedMs
        && (c['version'] as number) === syncState.versions[c['id'] as string];
    });
    if (allStale) {
      console.log(`\n  Early stop at page ${page} — remaining pages unchanged`);
      break;
    }
  }
  if (totalPages > 1) console.log();

  let updated = 0;
  let skipped = 0;
  const newVersions: Record<string, number> = {};

  console.log('\nProcessing customers...');

  for (let i = 0; i < allItems.length; i++) {
    const c      = allItems[i];
    const cid    = c['id'] as string;
    const apiVer = c['version'] as number;

    newVersions[cid] = apiVer;

    if (apiVer === syncState.versions[cid] && existingRows.has(cid)) {
      allItems[i] = existingRows.get(cid)!;
      skipped++;
      continue;
    }

    process.stdout.write(`\r  Fetching reps: customer ${updated + 1} updated (${i + 1}/${allItems.length} scanned)`);

    const repEntries  = await fetchRepresentativePhones(token, cid);
    const propEntries = propPhoneMap.get(cid) ?? [];

    const rawEntries: PhoneEntry[] = [
      { phone: normalize(c['phonePrimary']  as string) ?? '', source: 'customer:phonePrimary' },
      { phone: normalize(c['phoneAlternate'] as string) ?? '', source: 'customer:phoneAlternate' },
      ...repEntries,
      ...propEntries,
    ].filter(e => e.phone !== '');

    const seen = new Set<string>();
    const allNumbers: string[]  = [];
    const allSources: string[]  = [];
    for (const e of rawEntries) {
      if (!seen.has(e.phone)) {
        seen.add(e.phone);
        allNumbers.push(e.phone);
        allSources.push(e.source);
      }
    }

    c['all_numbers']         = JSON.stringify(allNumbers);
    c['all_numbers_sources'] = JSON.stringify(allSources);

    const addrObj = c['addresses'] as { items?: Record<string, unknown>[] } | null;
    const addrItems = addrObj?.items ?? [];
    c['addresses_all'] = JSON.stringify(addrItems.map(a => ({
      id: a['id'],
      addressLine1: a['addressLine1'],
      addressLine2: a['addressLine2'],
      city: a['city'],
      state: a['state'],
      zipcode: a['zipcode'],
      addressType: a['addressType'],
    })));

    c['properties_all'] = JSON.stringify(propIdMap.get(cid) ?? []);
    updated++;
  }
  if (updated > 0 || skipped > 0) console.log();

  // Write updated customers.csv
  const csvLines = [CSV_FIELDS.join(','), ...allItems.map(toCSVRow)];
  const csvPath  = path.resolve(outDir, 'customers.csv');
  fs.writeFileSync(csvPath, csvLines.join('\n'), 'utf-8');

  // Write sync state
  const lastSyncedMs = allItems.reduce((max, c) => {
    const ms = ((c['audit'] as Record<string, unknown> | undefined)?.['lastUpdatedDateTime'] as number | undefined) ?? 0;
    return Math.max(max, ms);
  }, syncState.lastSyncedMs);

  const newState: SyncState = {
    lastRunAt: new Date().toISOString(),
    lastSyncedMs,
    versions: newVersions,
    propertyVersions: newPropertyVersions,
  };
  fs.writeFileSync(path.resolve(outDir, 'sync_state.json'), JSON.stringify(newState, null, 2), 'utf-8');

  console.log(`\nSync complete — ${allItems.length} total, ${updated} updated, ${skipped} skipped (no change)`);
  console.log(`CSV: ${csvPath}`);
}

runSync().catch(console.error);
