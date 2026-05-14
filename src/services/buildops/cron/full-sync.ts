/**
 * BuildOps full data sync script.
 * Fetches all customers, properties, and representatives from the BuildOps API,
 * aggregates phone numbers from all three sources into a single all_numbers array
 * per customer, and writes the result to scripts/buildops/output/customers.csv.
 * Also saves a sync_state.json with the highest lastUpdatedDateTime watermark.
 *
 * Run this script once before using the incremental sync.
 * Required env vars: CLIENT_ID, CLIENT_SECRET, TENANT_ID
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import {
  BASE_URL, CSV_FIELDS, getAccessToken, normalize, toCSVRow, saveSyncState,
  PhoneEntry, PropertySummary, RepSummary, SyncState,
} from '../lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

const CLIENT_ID     = process.env.CLIENT_ID!;
const CLIENT_SECRET = process.env.CLIENT_SECRET!;
const TENANT_ID     = process.env.TENANT_ID!;

if (!CLIENT_ID || !CLIENT_SECRET || !TENANT_ID) {
  console.error('Missing CLIENT_ID, CLIENT_SECRET, or TENANT_ID in .env');
  process.exit(1);
}

async function fetchAllProperties(token: string): Promise<{
  propMap: Map<string, PropertySummary[]>;
  propPhoneMap: Map<string, PhoneEntry[]>;
}> {
  const propMap = new Map<string, PropertySummary[]>();
  const propPhoneMap = new Map<string, PhoneEntry[]>();
  let page = 0;
  let total = 0;

  process.stdout.write('Fetching properties...');
  while (true) {
    const res = await fetch(`${BASE_URL}/properties?include_addresses=true&page=${page}&page_size=100`, {
      headers: { Authorization: `Bearer ${token}`, tenantId: TENANT_ID, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Properties page ${page} failed (${res.status})`);
    const data = await res.json() as { items?: Record<string, unknown>[] };
    const items = data.items ?? [];
    total += items.length;

    for (const p of items) {
      const cid = p['customerId'] as string | undefined;
      if (!cid) continue;

      const addrItems = ((p['addresses'] as { items?: Record<string, unknown>[] } | null)?.items ?? []);
      const addresses = addrItems.map((a: Record<string, unknown>) => ({
        addressLine1: (a['addressLine1'] as string) ?? '',
        addressLine2: (a['addressLine2'] as string | null) ?? null,
        city: (a['city'] as string) ?? '',
        state: (a['state'] as string) ?? '',
        zipcode: (a['zipcode'] as string) ?? '',
        addressType: (a['addressType'] as string) ?? '',
      }));

      const summary: PropertySummary = {
        id: p['id'] as string,
        companyName: (p['companyName'] as string | null) ?? null,
        phonePrimary: (p['phonePrimary'] as string | null) ?? null,
        phoneAlternate: (p['phoneAlternate'] as string | null) ?? null,
        priceBookId: (p['priceBookId'] as string | null) ?? null,
        isTaxable: (p['isTaxable'] as boolean) ?? false,
        version: (p['version'] as number) ?? 0,
        addresses,
      };

      const props = propMap.get(cid) ?? [];
      props.push(summary);
      propMap.set(cid, props);

      const phones = propPhoneMap.get(cid) ?? [];
      const p1 = normalize(p['phonePrimary'] as string);
      const p2 = normalize(p['phoneAlternate'] as string);
      if (p1) phones.push({ phone: p1, source: `property:phonePrimary:${p['id']}` });
      if (p2) phones.push({ phone: p2, source: `property:phoneAlternate:${p['id']}` });
      propPhoneMap.set(cid, phones);
    }

    if (items.length < 100) break;
    page++;
  }
  console.log(` ${total} loaded`);
  return { propMap, propPhoneMap };
}

async function fetchAllCustomers(token: string): Promise<Record<string, unknown>[]> {
  const allItems: Record<string, unknown>[] = [];
  let page = 0;
  let totalCount = 0;

  while (true) {
    const res = await fetch(`${BASE_URL}/customers?limit=100&page=${page}&include_inactive=true`, {
      headers: { Authorization: `Bearer ${token}`, tenantId: TENANT_ID, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Customers page ${page} failed (${res.status})`);
    const data = await res.json() as { totalCount?: number; items?: Record<string, unknown>[] };
    const items = data.items ?? [];
    if (page === 0) {
      totalCount = data.totalCount ?? 0;
      process.stdout.write(`Fetching customers (${totalCount} total)...`);
    }
    allItems.push(...items);
    process.stdout.write(`\r  ${allItems.length}/${totalCount}`);
    if (items.length < 100) break;
    page++;
  }
  console.log();
  return allItems;
}

async function fetchReps(token: string, customerId: string): Promise<RepSummary[]> {
  const reps: RepSummary[] = [];
  let page = 0;
  while (true) {
    const res = await fetch(`${BASE_URL}/customers/${customerId}/our-representatives?page=${page}&page_size=100`, {
      headers: { Authorization: `Bearer ${token}`, tenantId: TENANT_ID, Accept: 'application/json' },
    });
    if (!res.ok) break;
    const data = await res.json() as { items?: Record<string, unknown>[] };
    const items = data.items ?? [];
    for (const rep of items) {
      reps.push({
        id: rep['id'] as string,
        firstName: (rep['firstName'] as string | null) ?? null,
        lastName: (rep['lastName'] as string | null) ?? null,
        cellPhone: (rep['cellPhone'] as string | null) ?? null,
        landlinePhone: (rep['landlinePhone'] as string | null) ?? null,
        email: (rep['email'] as string | null) ?? null,
        propertyId: (rep['propertyId'] as string | null) ?? null,
        isActive: (rep['isActive'] as boolean) ?? true,
        isDoNotCall: (rep['isDoNotCall'] as boolean) ?? false,
        version: (rep['version'] as number) ?? 0,
      });
    }
    if (items.length < 100) break;
    page++;
  }
  return reps;
}

function buildRow(
  c: Record<string, unknown>,
  reps: RepSummary[],
  propPhoneMap: Map<string, PhoneEntry[]>,
  propMap: Map<string, PropertySummary[]>,
): void {
  const cid = c['id'] as string;

  const repPhoneEntries: PhoneEntry[] = [];
  for (const rep of reps) {
    const repName = [rep.firstName, rep.lastName].filter(Boolean).join(' ') || 'Unknown';
    const cell = normalize(rep.cellPhone);
    const land = normalize(rep.landlinePhone);
    if (cell) repPhoneEntries.push({ phone: cell, source: `rep:cellPhone:${repName}` });
    if (land) repPhoneEntries.push({ phone: land, source: `rep:landlinePhone:${repName}` });
  }

  const rawEntries: PhoneEntry[] = [
    { phone: normalize(c['phonePrimary'] as string) ?? '', source: 'customer:phonePrimary' },
    { phone: normalize(c['phoneAlternate'] as string) ?? '', source: 'customer:phoneAlternate' },
    ...repPhoneEntries,
    ...(propPhoneMap.get(cid) ?? []),
  ].filter(e => e.phone !== '');

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

  const addrObj = c['addresses'] as { items?: Record<string, unknown>[] } | null;
  const addrItems = addrObj?.items ?? [];

  const audit = c['audit'] as Record<string, unknown> | undefined;
  c['last_updated'] = (audit?.['lastUpdatedDateTime'] as number) ?? 0;
  c['last_added']   = (audit?.['createdDateTime'] as number) ?? 0;
  c['all_numbers']         = JSON.stringify(allNumbers);
  c['all_numbers_sources'] = JSON.stringify(allSources);
  c['addresses_all']       = JSON.stringify(addrItems.map((a: Record<string, unknown>) => ({
    id: a['id'],
    addressLine1: a['addressLine1'],
    addressLine2: a['addressLine2'],
    city: a['city'],
    state: a['state'],
    zipcode: a['zipcode'],
    addressType: a['addressType'],
  })));
  c['representatives'] = JSON.stringify(reps);
  c['properties']      = JSON.stringify(propMap.get(cid) ?? []);
}

async function runFullSync() {
  const token = await getAccessToken(CLIENT_ID, CLIENT_SECRET, TENANT_ID);
  console.log('Token acquired.');

  const outDir = path.resolve(__dirname, '../../../../scripts/buildops/output');
  fs.mkdirSync(outDir, { recursive: true });

  const { propMap, propPhoneMap } = await fetchAllProperties(token);
  const customers = await fetchAllCustomers(token);

  console.log(`\nBuilding ${customers.length} rows (fetching reps for each customer)...`);
  let maxLastUpdatedMs = 0;

  for (let i = 0; i < customers.length; i++) {
    const c = customers[i];
    process.stdout.write(`\r  ${i + 1}/${customers.length}`);
    const reps = await fetchReps(token, c['id'] as string);
    buildRow(c, reps, propPhoneMap, propMap);
    const ms = c['last_updated'] as number;
    if (ms > maxLastUpdatedMs) maxLastUpdatedMs = ms;
  }
  console.log();

  const csvPath = path.resolve(outDir, 'customers.csv');
  const csvLines = [(CSV_FIELDS as readonly string[]).join(','), ...customers.map(toCSVRow)];
  fs.writeFileSync(csvPath, csvLines.join('\n'), 'utf-8');
  console.log(`CSV written: ${csvPath} (${customers.length} rows)`);

  const state: SyncState = {
    lastRunAt: new Date().toISOString(),
    lastSyncedMs: maxLastUpdatedMs,
    versions: {},
    propertyVersions: {},
  };
  saveSyncState(outDir, state);
  console.log(`Sync state saved (lastSyncedMs: ${maxLastUpdatedMs})`);
}

runFullSync().catch(console.error);
