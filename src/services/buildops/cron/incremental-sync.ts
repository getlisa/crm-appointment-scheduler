import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';
import {
  BASE_URL, CSV_FIELDS, getAccessToken, normalize, toCSVRow,
  loadExistingRows, saveSyncState,
  PhoneEntry, PropertySummary, RepSummary, SyncState,
} from '../lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

const CLIENT_ID    = process.env.CLIENT_ID!;
const CLIENT_SECRET = process.env.CLIENT_SECRET!;
const TENANT_ID    = process.env.TENANT_ID!;
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!CLIENT_ID || !CLIENT_SECRET || !TENANT_ID || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing required env vars: CLIENT_ID, CLIENT_SECRET, TENANT_ID, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

async function fetchAllProperties(token: string): Promise<{
  allProps: { customerId: string; lastUpdatedMs: number }[];
  propMap: Map<string, PropertySummary[]>;
  propPhoneMap: Map<string, PhoneEntry[]>;
}> {
  const allProps: { customerId: string; lastUpdatedMs: number }[] = [];
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

      const audit = p['audit'] as Record<string, unknown> | undefined;
      allProps.push({ customerId: cid, lastUpdatedMs: (audit?.['lastUpdatedDateTime'] as number) ?? 0 });

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
  return { allProps, propMap, propPhoneMap };
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

// Rebuilds a row using existing CSV scalars + fresh reps + current propMap.
// Used for customers dirtied by rep/property changes that were missed by the customer timestamp check.
async function rebuildFromExisting(
  token: string,
  cid: string,
  existing: Record<string, unknown>,
  propPhoneMap: Map<string, PhoneEntry[]>,
  propMap: Map<string, PropertySummary[]>,
): Promise<Record<string, unknown>> {
  const reps = await fetchReps(token, cid);
  const c = { ...existing };

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

  c['all_numbers']     = JSON.stringify(allNumbers);
  c['all_numbers_sources'] = JSON.stringify(allSources);
  c['representatives'] = JSON.stringify(reps);
  c['properties']      = JSON.stringify(propMap.get(cid) ?? []);
  return c;
}

async function runIncrementalSync() {
  const token = await getAccessToken(CLIENT_ID, CLIENT_SECRET, TENANT_ID);
  console.log('Token acquired.');

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

  const outDir = path.resolve(__dirname, '../../../../scripts/buildops/output');
  const existingRows = loadExistingRows(outDir);

  if (existingRows.size === 0) {
    console.error('No existing customers.csv found — run full-sync.ts first');
    process.exit(1);
  }
  console.log(`Loaded ${existingRows.size} existing rows.`);

  // Use min(last_updated) as the conservative sync boundary for the Supabase rep query
  const lastSyncedMs = Math.min(...[...existingRows.values()].map(r => Number(r['last_updated'] ?? 0)));
  console.log(`Sync boundary (min last_updated): ${new Date(lastSyncedMs).toISOString()}`);

  const dirtySet = new Set<string>();

  // 1. Rep-triggered dirtying: customers with recently changed reps in Supabase
  const { data: recentReps, error: repsError } = await supabase
    .from('representatives')
    .select('customer_id')
    .gt('updated_at', new Date(lastSyncedMs).toISOString());

  if (repsError) {
    console.warn('Supabase rep query failed:', repsError.message);
  } else {
    (recentReps as { customer_id: string }[] | null)?.forEach(r => dirtySet.add(r.customer_id));
    console.log(`Rep-triggered dirty: ${dirtySet.size} customers`);
  }

  // 2. Property fetch + property-triggered dirtying
  const { allProps, propMap, propPhoneMap } = await fetchAllProperties(token);
  for (const { customerId, lastUpdatedMs } of allProps) {
    const existing = existingRows.get(customerId);
    if (!existing || lastUpdatedMs > Number(existing['last_updated'] ?? 0)) {
      dirtySet.add(customerId);
    }
  }
  console.log(`Dirty after property check: ${dirtySet.size} customers`);

  // 3. Fetch all customers; rebuild dirty rows, reuse clean rows
  const merged = new Map<string, Record<string, unknown>>(existingRows);
  const processedIds = new Set<string>();

  let page = 0;
  let totalCount = 0;
  let rebuilt = 0;
  let reused = 0;

  console.log('Fetching customers...');
  while (true) {
    const res = await fetch(`${BASE_URL}/customers?limit=100&page=${page}&include_inactive=true`, {
      headers: { Authorization: `Bearer ${token}`, tenantId: TENANT_ID, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Customers page ${page} failed (${res.status})`);
    const data = await res.json() as { totalCount?: number; items?: Record<string, unknown>[] };
    const items = data.items ?? [];
    if (page === 0) totalCount = data.totalCount ?? 0;

    for (const c of items) {
      const cid = c['id'] as string;
      processedIds.add(cid);

      const existingRow = existingRows.get(cid);
      const apiLastUpdatedMs = ((c['audit'] as Record<string, unknown> | undefined)?.['lastUpdatedDateTime'] as number) ?? 0;
      const isDirty = dirtySet.has(cid) || !existingRow || apiLastUpdatedMs > Number(existingRow['last_updated'] ?? 0);

      if (isDirty) {
        const reps = await fetchReps(token, cid);
        buildRow(c, reps, propPhoneMap, propMap);
        merged.set(cid, c);
        rebuilt++;
      } else {
        reused++;
      }

      process.stdout.write(`\r  processed ${rebuilt + reused}/${totalCount} (rebuilt: ${rebuilt})`);
    }

    if (items.length < 100) break;

    // Early-stop: if all items on this page are below the sync boundary, pages after are also stale
    const allStale = items.every(c => {
      const ms = ((c['audit'] as Record<string, unknown> | undefined)?.['lastUpdatedDateTime'] as number) ?? 0;
      return ms <= lastSyncedMs;
    });
    if (allStale) {
      console.log(`\n  Early stop after page ${page} — remaining pages are below sync boundary`);
      break;
    }

    page++;
  }
  console.log();

  // 4. Handle dirtySet customers skipped by early-stop (in CSV but not fetched from API)
  const skippedDirty = [...dirtySet].filter(cid => !processedIds.has(cid) && existingRows.has(cid));
  if (skippedDirty.length > 0) {
    console.log(`Rebuilding ${skippedDirty.length} dirty customers missed by early-stop...`);
    for (let i = 0; i < skippedDirty.length; i++) {
      process.stdout.write(`\r  ${i + 1}/${skippedDirty.length}`);
      const rebuilt_row = await rebuildFromExisting(token, skippedDirty[i], existingRows.get(skippedDirty[i])!, propPhoneMap, propMap);
      merged.set(skippedDirty[i], rebuilt_row);
      rebuilt++;
    }
    console.log();
  }

  // 5. Write updated CSV
  const allRows = [...merged.values()];
  const csvPath = path.resolve(outDir, 'customers.csv');
  const csvLines = [(CSV_FIELDS as readonly string[]).join(','), ...allRows.map(toCSVRow)];
  fs.writeFileSync(csvPath, csvLines.join('\n'), 'utf-8');
  console.log(`CSV written: ${csvPath} (${allRows.length} rows)`);

  const maxLastUpdatedMs = Math.max(...allRows.map(r => Number(r['last_updated'] ?? 0)));
  const state: SyncState = {
    lastRunAt: new Date().toISOString(),
    lastSyncedMs: maxLastUpdatedMs,
    versions: {},
    propertyVersions: {},
  };
  saveSyncState(outDir, state);

  const carried = Math.max(0, merged.size - processedIds.size - skippedDirty.length);
  console.log(`\nSync complete — rebuilt: ${rebuilt}, reused: ${reused}, carried from CSV: ${carried}`);
}

runIncrementalSync().catch(console.error);
