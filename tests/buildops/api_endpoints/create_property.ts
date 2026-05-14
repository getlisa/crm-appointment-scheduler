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

// Usage: node create_property.ts <inboundPhoneNumber>
const INBOUND_PHONE = process.argv[2];
if (!INBOUND_PHONE) {
  console.error('Usage: node create_property.ts <inboundPhoneNumber>');
  process.exit(1);
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
  const idIdx = headers.indexOf('id');
  const nameIdx = headers.indexOf('name');
  const phoneIdx = headers.indexOf('phonePrimary');

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    if (cols[phoneIdx] === phone) {
      return { id: cols[idIdx], name: cols[nameIdx] };
    }
  }
  throw new Error(`No customer found with phone "${phone}" in customers.csv`);
}

async function getCustomerAddresses(token: string, customerId: string) {
  const res = await fetch(`${BASE_URL}/customers/${customerId}`, {
    headers: { Authorization: `Bearer ${token}`, tenantId: TENANT_ID, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Failed to fetch customer: ${res.status}`);
  const data = await res.json();
  return (data.addresses?.items ?? []) as Record<string, unknown>[];
}

async function createProperty(token: string, customerId: string, address: Record<string, unknown>) {
  const payload = {
    customerId,
    addressLine1: address['addressLine1'],
    city: address['city'],
    state: address['state'],
    zipcode: address['zipcode'],
    country: address['country'],
    latitude: address['latitude'] != null ? Number(address['latitude']) : null,
    longitude: address['longitude'] != null ? Number(address['longitude']) : null,
  };

  const res = await fetch(`${BASE_URL}/properties`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      tenantId: TENANT_ID,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  console.log(`  Status: ${res.status}`);
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = text; }
  console.log(`  Response:`, typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data, null, 2));
  return data;
}

async function main() {
  const token = await getAccessToken();
  console.log('Token acquired.');

  const customer = lookupCustomerByPhone(INBOUND_PHONE);
  console.log(`Customer found: "${customer.name}" (id: ${customer.id})`);

  const addresses = await getCustomerAddresses(token, customer.id);
  console.log(`Addresses found: ${addresses.length}`);

  if (addresses.length === 0) {
    console.log('No addresses on this customer — nothing to create.');
    return;
  }

  for (let i = 0; i < addresses.length; i++) {
    const addr = addresses[i];
    console.log(`\nCreating property ${i + 1}/${addresses.length}: ${addr['addressLine1']}, ${addr['city']}`);
    await createProperty(token, customer.id, addr);
  }
}

main().catch(console.error);
