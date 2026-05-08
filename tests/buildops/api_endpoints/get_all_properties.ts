import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const CLIENT_ID = process.env.CLIENT_ID!;
const CLIENT_SECRET = process.env.CLIENT_SECRET!;
const TENANT_ID = process.env.TENANT_ID!;
const BASE_URL = 'https://public-api.live.buildops.com/v1';

const CSV_FIELDS = [
  'id', 'companyName', 'accountNumber', 'customerPropertyTypeValue', 'status',
  'email', 'phonePrimary', 'phoneAlternate', 'customerId', 'billingCustomerId',
  'priceBookId', 'isTaxable', 'taxRateValue', 'taxRateName', 'taxRateId',
  'amountNotToExceed', 'receiveSMS', 'sameAddress', 'version',
  'tenantId', 'tenantCompanyId',
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
  const outPath = path.resolve(outDir, 'properties.csv');

  const rows = properties.map(p => CSV_FIELDS.map(f => escape(p[f])).join(','));
  fs.writeFileSync(outPath, [CSV_FIELDS.join(','), ...rows].join('\n'), 'utf-8');
  console.log(`CSV written: ${outPath} (${properties.length} rows)`);
}

main().catch(console.error);
