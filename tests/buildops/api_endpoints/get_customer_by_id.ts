import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const CLIENT_ID     = process.env.CLIENT_ID!;
const CLIENT_SECRET = process.env.CLIENT_SECRET!;
const TENANT_ID     = process.env.TENANT_ID!;
const BASE_URL      = 'https://public-api.live.buildops.com/v1';

// Usage: node get_customer_by_id.ts <customerId>
const CUSTOMER_ID = process.argv[2];
if (!CUSTOMER_ID) {
  console.error('Usage: node get_customer_by_id.ts <customerId>');
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

async function getCustomerById(token: string, id: string) {
  const res = await fetch(`${BASE_URL}/customers/${id}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      tenantId: TENANT_ID,
      Accept: 'application/json',
    },
  });

  const text = await res.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = text; }

  console.log(`Status: ${res.status}`);
  if (!res.ok) throw new Error(`Request failed (${res.status}): ${text}`);

  const c = data as Record<string, unknown>;
  const addresses = (c['addresses'] as { items?: unknown[] } | null)?.items ?? [];

  console.log(`\nCustomer`);
  console.log(`  id           : ${c['id']}`);
  console.log(`  name         : ${c['name']}`);
  console.log(`  accountNumber: ${c['accountNumber']}`);
  console.log(`  customerType : ${c['customerType']}`);
  console.log(`  isActive     : ${c['isActive']}`);
  console.log(`  phonePrimary : ${c['phonePrimary']}`);
  console.log(`  phoneAlt     : ${c['phoneAlternate']}`);
  console.log(`  email        : ${c['email']}`);
  console.log(`  priceBookId  : ${c['priceBookId']}`);
  console.log(`  paymentTermId: ${c['paymentTermId']}`);
  console.log(`  status       : ${c['status']}`);
  console.log(`  version      : ${c['version']}`);

  console.log(`\nAddresses (${addresses.length}):`);
  addresses.forEach((a: unknown, i: number) => {
    const addr = a as Record<string, unknown>;
    console.log(`  [${i + 1}] ${addr['addressType']} | ${addr['addressLine1']}, ${addr['city']}, ${addr['state']} ${addr['zipcode']}`);
    console.log(`       propertyId: ${addr['propertyId'] ?? 'none'}`);
  });

  console.log('\nFull response:');
  console.log(JSON.stringify(data, null, 2));
}

async function main() {
  const token = await getAccessToken();
  console.log('Token acquired.');
  await getCustomerById(token, CUSTOMER_ID);
}

main().catch(console.error);
