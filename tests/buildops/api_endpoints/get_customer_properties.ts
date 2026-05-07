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

// Usage: node get_customer_properties.ts <inboundPhoneNumber>
const INBOUND_PHONE = process.argv[2];
if (!INBOUND_PHONE) {
  console.error('Usage: node get_customer_properties.ts <inboundPhoneNumber>');
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

function lookupCustomerByPhone(phone: string): { id: string; name: string } {
  const csvPath = path.resolve(__dirname, '../output/customers.csv');
  const lines = fs.readFileSync(csvPath, 'utf-8').trim().split('\n');
  const headers = lines[0].split(',');
  const idIdx = headers.indexOf('id');
  const nameIdx = headers.indexOf('name');
  const phoneIdx = headers.indexOf('phonePrimary');

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
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

async function getProperties(token: string, customerId: string) {
  const res = await fetch(`${BASE_URL}/customers/${customerId}/properties`, {
    headers: { Authorization: `Bearer ${token}`, tenantId: TENANT_ID, Accept: 'application/json' },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Failed to fetch properties (${res.status}): ${JSON.stringify(err)}`);
  }
  const data = await res.json();
  return (data.items ?? data ?? []) as Record<string, unknown>[];
}

async function main() {
  const token = await getAccessToken();
  console.log('Token acquired.');

  const customer = lookupCustomerByPhone(INBOUND_PHONE);
  console.log(`Customer: "${customer.name}" (id: ${customer.id})\n`);

  const [addresses, properties] = await Promise.all([
    getCustomerAddresses(token, customer.id),
    getProperties(token, customer.id),
  ]);

  console.log(`Addresses on customer : ${addresses.length}`);
  console.log(`Properties in system  : ${properties.length}`);
  console.log(`Max possible properties: ${addresses.length} (one per address)\n`);

  console.log('--- Addresses ---');
  addresses.forEach((a, i) => {
    console.log(`  [${i + 1}] ${a['addressLine1']}, ${a['city']}, ${a['state']} ${a['zipcode']} (type: ${a['addressType']})`);
  });

  console.log('\n--- Properties ---');
  if (properties.length === 0) {
    console.log('  No properties found. Run create_property.ts to create them.');
  } else {
    properties.forEach((p, i) => {
      console.log(`  [${i + 1}] id: ${p['id']} | name: ${p['name']} | ${p['addressLine1']}, ${p['city']}`);
    });
  }
}

main().catch(console.error);
