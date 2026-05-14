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

// Usage: npx tsx add_representative.ts <inboundPhoneNumber> <firstName> <lastName> <cellPhone>
const [INBOUND_PHONE, FIRST_NAME, LAST_NAME, CELL_PHONE] = process.argv.slice(2);
if (!INBOUND_PHONE || !FIRST_NAME || !LAST_NAME || !CELL_PHONE) {
  console.error('Usage: npx tsx add_representative.ts <inboundPhoneNumber> <firstName> <lastName> <cellPhone>');
  console.error('Example: npx tsx add_representative.ts 8041234567 John Smith 8049876543');
  process.exit(1);
}

async function getAccessToken(): Promise<string> {
  const res = await fetch(`${BASE_URL}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, tenantId: TENANT_ID }),
  });
  if (!res.ok) throw new Error(`Auth failed: ${res.status}`);
  return (await res.json()).access_token;
}

function parseCSVLine(line: string): string[] {
  const cols: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      cols.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  cols.push(cur);
  return cols;
}

function lookupCustomerByPhone(phone: string): { id: string; name: string } {
  const csvPath = path.resolve(__dirname, '../output/customers.csv');
  const lines = fs.readFileSync(csvPath, 'utf-8').trim().split('\n');
  const headers = lines[0].split(',');
  const idIdx     = headers.indexOf('id');
  const nameIdx   = headers.indexOf('name');
  const allNumIdx = headers.indexOf('all_numbers');

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const allNums: string[] = JSON.parse(cols[allNumIdx] || '[]');
    const digits = phone.replace(/\D/g, '').slice(-10);
    if (allNums.includes(digits)) {
      return { id: cols[idIdx], name: cols[nameIdx] };
    }
  }
  throw new Error(`No customer found with phone "${phone}" in customers.csv`);
}

async function addRepresentative(
  token: string,
  customerId: string,
  firstName: string,
  lastName: string,
  cellPhone: string,
): Promise<{ id: string }> {
  const res = await fetch(`${BASE_URL}/customers/${customerId}/representatives`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      tenantId: TENANT_ID,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ firstName, lastName, cellPhone }),
  });

  const text = await res.text();
  console.log(`Status: ${res.status}`);
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = text; }
  console.log('Response:', JSON.stringify(data, null, 2));

  if (!res.ok) throw new Error(`POST representatives failed (${res.status})`);
  return data as { id: string };
}

async function main() {
  const token = await getAccessToken();
  console.log('Token acquired.');

  const customer = lookupCustomerByPhone(INBOUND_PHONE);
  console.log(`Customer: "${customer.name}" (id: ${customer.id})\n`);

  console.log(`Adding representative: ${FIRST_NAME} ${LAST_NAME} | cell: ${CELL_PHONE}`);
  const rep = await addRepresentative(token, customer.id, FIRST_NAME, LAST_NAME, CELL_PHONE);
  console.log(`\nCreated representative id: ${rep.id}`);
}

main().catch(console.error);
