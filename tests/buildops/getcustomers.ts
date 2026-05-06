import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const CLIENT_ID = process.env.CLIENT_ID!;
const CLIENT_SECRET = process.env.CLIENT_SECRET!;
const TENANT_ID = process.env.TENANT_ID!;
const BASE_URL = 'https://public-api.live.buildops.com/v1';
const LIMIT = 100;

const CSV_FIELDS = [
  'id', 'name', 'accountNumber', 'customerType', 'isActive', 'email',
  'customerNumber', 'creditLimit', 'isTaxable', 'taxRateValue', 'status',
  'phonePrimary', 'phoneAlternate', 'receiveSMS', 'invoiceDeliveryPref',
  'logoUrl', 'websiteUrl', 'version', 'tenantId', 'tenantCompanyId', 'amountNotToExceed',
];

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
  if (!response.ok) {
    const err = await response.json();
    throw new Error(`Auth failed (${response.status}): ${JSON.stringify(err)}`);
  }
  const data = await response.json();
  return data.access_token;
}

async function fetchPage(token: string, page: number): Promise<{ totalCount: number; items: Record<string, unknown>[] }> {
  const params = new URLSearchParams({
    limit: String(LIMIT),
    page: String(page),
    include_inactive: 'true',
  });
  const url = `${BASE_URL}/customers?${params}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      tenantId: TENANT_ID,
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new Error(`Page ${page} failed (${response.status}): ${JSON.stringify(errBody)}`);
  }
  return response.json();
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

  const lines = [CSV_FIELDS.join(','), ...toCSVRows(allItems)];
  const outPath = path.resolve(__dirname, 'customers.csv');
  fs.writeFileSync(outPath, lines.join('\n'), 'utf-8');
  console.log(`CSV written: ${outPath} (${allItems.length} rows)`);
}

getAllCustomers().catch(console.error);
