import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const CLIENT_ID = process.env.CLIENT_ID!;
const CLIENT_SECRET = process.env.CLIENT_SECRET!;
const TENANT_ID = process.env.TENANT_ID!;
const BASE_URL = 'https://public-api.live.buildops.com/v1';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const PROPERTY_FIELDS = [
  'id', 'companyName', 'accountNumber', 'customerPropertyTypeValue', 'status',
  'email', 'phonePrimary', 'phoneAlternate', 'customerId', 'billingCustomerId',
  'priceBookId', 'isTaxable', 'taxRateValue', 'taxRateName', 'taxRateId',
  'amountNotToExceed', 'receiveSMS', 'sameAddress', 'version',
  'tenantId', 'tenantCompanyId',
];

const ADDRESS_FIELDS = [
  'customerId', 'customerName',
  'propertyId', 'propertyCompanyName', 'propertyStatus',
  'addressId', 'addressType', 'addressLine1', 'addressLine2',
  'city', 'state', 'zipcode', 'country',
  'latitude', 'longitude', 'status', 'isActive',
];

function escape(val: unknown): string {
  const str = val == null ? '' : String(val);
  return str.includes(',') || str.includes('"') || str.includes('\n')
    ? `"${str.replace(/"/g, '""')}"`
    : str;
}

async function getAccessToken(): Promise<string> {
  const res = await fetch(`${BASE_URL}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, tenantId: TENANT_ID }),
  });
  if (!res.ok) throw new Error(`Auth failed: ${res.status}`);
  const data = await res.json();
  return data.access_token;
}

async function getAllProperties(token: string): Promise<Record<string, unknown>[]> {
  const PAGE_SIZE = 100;
  const results: Record<string, unknown>[] = [];
  let page = 0;

  while (true) {
    const url = `${BASE_URL}/properties?include_addresses=true&page=${page}&page_size=${PAGE_SIZE}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        tenantId: TENANT_ID,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`Failed to fetch properties (page ${page}, status ${res.status}): ${err}`);
    }

    const data = await res.json();
    const items: Record<string, unknown>[] = data.items ?? [];
    const totalCount: number = data.totalCount ?? 0;

    results.push(...items);
    process.stdout.write(`\r  Page ${page}: fetched ${results.length} / ${totalCount}`);

    if (results.length >= totalCount || items.length < PAGE_SIZE) break;
    page++;
  }
  console.log();

  return results;
}

async function loadCustomerMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('buildops_customers')
      .select('buildops_customer_id, name')
      .eq('tenant_id', TENANT_ID)
      .range(from, from + pageSize - 1);
    if (error || !data || data.length === 0) break;
    for (const row of data) {
      map.set(row.buildops_customer_id as string, row.name as string);
    }
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return map;
}

async function main() {
  if (!CLIENT_ID || !CLIENT_SECRET || !TENANT_ID) {
    console.error('Missing CLIENT_ID, CLIENT_SECRET, or TENANT_ID in .env');
    process.exit(1);
  }

  console.log(`Fetching all properties for tenant: ${TENANT_ID}\n`);

  const token = await getAccessToken();
  console.log('Token acquired.\n');

  const properties = await getAllProperties(token);
  console.log(`\nTotal properties fetched: ${properties.length}`);

  const outDir = path.resolve(__dirname, '../output');
  fs.mkdirSync(outDir, { recursive: true });

  const customerMap = await loadCustomerMap();

  // properties.csv
  const propRows = properties.map(p => PROPERTY_FIELDS.map(f => escape(p[f])).join(','));
  const propPath = path.resolve(outDir, 'properties.csv');
  fs.writeFileSync(propPath, [PROPERTY_FIELDS.join(','), ...propRows].join('\n'), 'utf-8');
  console.log(`CSV written: ${propPath} (${properties.length} rows)`);

  // property_addresses.csv — one row per address, with property context
  const addrRows: string[] = [];
  for (const p of properties) {
    const addresses = (p['addresses'] as Record<string, unknown>[] | undefined) ?? [];
    for (const a of addresses) {
      const cid = p['customerId'] as string | undefined;
      const row: Record<string, unknown> = {
        customerId:          cid ?? '',
        customerName:        cid ? (customerMap.get(cid) ?? '') : '',
        propertyId:          p['id'],
        propertyCompanyName: p['companyName'],
        propertyStatus:      p['status'],
        addressId:           a['id'],
        addressType:         a['addressType'],
        addressLine1:        a['addressLine1'],
        addressLine2:        a['addressLine2'],
        city:                a['city'],
        state:               a['state'],
        zipcode:             a['zipcode'],
        country:             a['country'],
        latitude:            a['latitude'],
        longitude:           a['longitude'],
        status:              a['status'],
        isActive:            a['isActive'],
      };
      addrRows.push(ADDRESS_FIELDS.map(f => escape(row[f])).join(','));
    }
  }
  const addrPath = path.resolve(outDir, 'property_addresses.csv');
  fs.writeFileSync(addrPath, [ADDRESS_FIELDS.join(','), ...addrRows].join('\n'), 'utf-8');
  console.log(`CSV written: ${addrPath} (${addrRows.length} rows)`);
}

main().catch(console.error);
