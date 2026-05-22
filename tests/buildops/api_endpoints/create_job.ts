import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const CLIENT_ID     = process.env.CLIENT_ID!;
const CLIENT_SECRET = process.env.CLIENT_SECRET!;
const TENANT_ID     = process.env.TENANT_ID!;
const BASE_URL      = 'https://public-api.live.buildops.com/v1';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Usage: node create_job.ts <phone> [jobTypeName|jobTypeId]
const DEFAULT_JOB_TYPE_ID = '04df1a40-16b1-43f4-aa9b-8eafcec812ad';

const INBOUND_PHONE  = process.argv[2];
const JOB_TYPE_INPUT = process.argv[3] ?? DEFAULT_JOB_TYPE_ID;

if (!INBOUND_PHONE) {
  console.error('Usage: node create_job.ts <inboundPhone> [jobTypeName|jobTypeId]');
  process.exit(1);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function getAccessToken(): Promise<string> {
  const res = await fetch(`${BASE_URL}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, tenantId: TENANT_ID }),
  });
  if (!res.ok) throw new Error(`Auth failed: ${res.status}`);
  return (await res.json()).access_token;
}

async function lookupCustomerByPhone(phone: string): Promise<{ id: string; name: string; priceBookId: string | null }> {
  const digits = phone.replace(/\D/g, '').slice(-10);
  const { data } = await supabase
    .from('buildops_customers')
    .select('buildops_customer_id, name, price_book_id')
    .eq('tenant_id', TENANT_ID)
    .contains('all_numbers', [digits])
    .maybeSingle();
  if (!data) throw new Error(`No customer found with phone "${phone}" in buildops_customers`);
  const priceBookId = (data.price_book_id as string | null) ?? null;
  console.log(`Found customer: "${data.name}" | priceBookId: "${priceBookId}"`);
  return { id: data.buildops_customer_id as string, name: data.name as string, priceBookId };
}

async function resolveJobTypeId(token: string, input: string): Promise<string> {
  if (UUID_RE.test(input)) return input;

  const res = await fetch(`${BASE_URL}/job-types?page=0&page_size=100`, {
    headers: { Authorization: `Bearer ${token}`, tenantId: TENANT_ID, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Failed to fetch job types: ${res.status}`);
  const { items } = await res.json();

  const match = items.find(
    (jt: Record<string, unknown>) =>
      String(jt['tagName']).toLowerCase() === input.toLowerCase(),
  );
  if (!match) throw new Error(`No job type found with name "${input}". Run get_job_types.ts to list available types.`);
  console.log(`Job type "${match['tagName']}" → ${match['id']}`);
  return match['id'] as string;
}

async function resolvePriceBookId(token: string, fromDb: string | null): Promise<string> {
  if (fromDb) return fromDb;

  console.log('No priceBookId on customer — fetching first available price book from tenant...');
  const res = await fetch(`${BASE_URL}/price-books`, {
    headers: { Authorization: `Bearer ${token}`, tenantId: TENANT_ID, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Failed to fetch price books: ${res.status}`);
  const data = await res.json();
  const items = data.items ?? data ?? [];
  if (items.length === 0) throw new Error('No price books found in tenant.');
  console.log(`Using price book: "${items[0]['name'] ?? items[0]['id']}" (${items[0]['id']})`);
  return items[0]['id'] as string;
}

async function getCustomerPropertyId(token: string, customerId: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/customers/${customerId}/properties`, {
    headers: { Authorization: `Bearer ${token}`, tenantId: TENANT_ID, Accept: 'application/json' },
  });
  if (res.ok) {
    const data = await res.json();
    const items = data.items ?? data ?? [];
    if (items.length > 0) return items[0].id as string;
  }
  throw new Error(`No property found for customer ${customerId}. Run create_property.ts first.`);
}

async function main() {
  const token = await getAccessToken();
  console.log('Token acquired.');

  const customer = await lookupCustomerByPhone(INBOUND_PHONE);
  console.log(`Customer: "${customer.name}" (id: ${customer.id})`);

  const [jobTypeId, priceBookId, propertyId] = await Promise.all([
    resolveJobTypeId(token, JOB_TYPE_INPUT),
    resolvePriceBookId(token, customer.priceBookId),
    getCustomerPropertyId(token, customer.id),
  ]);

  console.log(`Property ID: ${propertyId}`);

  const payload = {
    customerId:         customer.id,
    customerPropertyId: propertyId,
    priceBookId,
    jobTypeId,
    status:             'Open',
    isUseTaxable:       false,
  };

  console.log('\nPayload:', JSON.stringify(payload, null, 2));

  const res = await fetch(`${BASE_URL}/jobs`, {
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
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = text; }

  console.log('\nStatus:', res.status);
  console.log('Response:', JSON.stringify(data, null, 2));

  if (!res.ok) throw new Error(`Job creation failed (${res.status})`);
  const job = data as Record<string, unknown>;
  console.log(`\nJob created! jobNumber: ${job['jobNumber']} | id: ${job['id']}`);
}

main().catch(console.error);
