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

// Usage: node get_representatives.ts <phone>
//        node get_representatives.ts --id <buildops_customer_id>
//        node get_representatives.ts --id <buildops_customer_id> --contacts   ← customer-side contacts
//        node get_representatives.ts --rep-id <buildops_rep_uuid>             ← single rep by UUID
const idFlag       = process.argv.indexOf('--id');
const repIdFlag    = process.argv.indexOf('--rep-id');
const USE_CONTACTS = process.argv.includes('--contacts');
const SINGLE_REP_ID = repIdFlag !== -1 ? process.argv[repIdFlag + 1] : null;
const DIRECT_CUSTOMER_ID = idFlag !== -1 ? process.argv[idFlag + 1] : null;
const INBOUND_PHONE = (DIRECT_CUSTOMER_ID || SINGLE_REP_ID) ? null : (process.argv[2]?.startsWith('--') ? null : process.argv[2]);
if (!INBOUND_PHONE && !DIRECT_CUSTOMER_ID && !SINGLE_REP_ID) {
  console.error('Usage: node get_representatives.ts <phone>');
  console.error('       node get_representatives.ts --id <buildops_customer_id>');
  console.error('       node get_representatives.ts --id <buildops_customer_id> --contacts');
  console.error('       node get_representatives.ts --rep-id <buildops_rep_uuid>');
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

async function lookupCustomerByPhone(phone: string): Promise<{ id: string; name: string }> {
  const digits = phone.replace(/\D/g, '').slice(-10);
  const { data } = await supabase
    .from('buildops_customers')
    .select('buildops_customer_id, name')
    .eq('tenant_id', TENANT_ID)
    .contains('all_numbers', [digits])
    .maybeSingle();
  if (!data) throw new Error(`No customer found with phone "${phone}" in buildops_customers`);
  return { id: data.buildops_customer_id as string, name: data.name as string };
}

async function lookupCustomerById(buildopsCustomerId: string): Promise<{ id: string; name: string }> {
  const { data } = await supabase
    .from('buildops_customers')
    .select('buildops_customer_id, name')
    .eq('tenant_id', TENANT_ID)
    .eq('buildops_customer_id', buildopsCustomerId)
    .maybeSingle();
  return data
    ? { id: data.buildops_customer_id as string, name: data.name as string }
    : { id: buildopsCustomerId, name: buildopsCustomerId };
}

interface Rep {
  id: string;
  firstName: string | null;
  lastName: string | null;
  cellPhone: string | null;
  landlinePhone: string | null;
  email: string | null;
  propertyId: string | null;
  isActive: boolean;
  isDoNotCall: boolean;
  version: number;
}

async function getRepresentatives(token: string, customerId: string, contacts = false): Promise<Rep[]> {
  const results: Rep[] = [];
  let page = 0;
  const endpoint = contacts
    ? `${BASE_URL}/customers/${customerId}/representatives`
    : `${BASE_URL}/customers/${customerId}/our-representatives`;

  while (true) {
    const res = await fetch(`${endpoint}?page=${page}&page_size=100`, {
      headers: { Authorization: `Bearer ${token}`, tenantId: TENANT_ID, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`GET ${contacts ? 'representatives' : 'our-representatives'} failed (${res.status}): ${await res.text()}`);
    const data = await res.json() as { items?: Rep[] };
    const items = data.items ?? [];
    results.push(...items);
    if (items.length < 100) break;
    page++;
  }

  return results;
}

async function getRepById(token: string, repId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE_URL}/representatives/${repId}`, {
    headers: { Authorization: `Bearer ${token}`, tenantId: TENANT_ID, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`GET /representatives/${repId} failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<Record<string, unknown>>;
}

async function main() {
  const token = await getAccessToken();
  console.log('Token acquired.\n');

  // ── Single rep by UUID ───────────────────────────────────────────────────────
  if (SINGLE_REP_ID) {
    const r = await getRepById(token, SINGLE_REP_ID);
    console.log('=== Representative ===');
    console.log(`ID           : ${r['id']}`);
    console.log(`Name         : ${r['name'] ?? [r['firstName'], r['lastName']].filter(Boolean).join(' ')}`);
    console.log(`Contact Role : ${r['contactRole'] ?? '(null)'}`);
    console.log(`Contact Type : ${r['contactType'] ?? '(null)'}`);
    console.log(`Cell Phone   : ${r['cellPhone'] ?? '(null)'}`);
    console.log(`Landline     : ${r['landlinePhone'] ?? '(null)'}`);
    console.log(`Email        : ${r['email'] ?? '(null)'}`);
    console.log(`Best Contact : ${r['bestContact'] ?? '(null)'}`);
    console.log(`Customer ID  : ${r['customerId'] ?? '(null)'}`);
    console.log(`Property ID  : ${r['propertyId'] ?? '(null)'}`);
    console.log(`Active       : ${r['isActive']}`);
    console.log(`Status       : ${r['status'] ?? '(null)'}`);
    console.log('\n=== Raw ===');
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  // ── All reps for a customer ──────────────────────────────────────────────────
  const customer = DIRECT_CUSTOMER_ID
    ? await lookupCustomerById(DIRECT_CUSTOMER_ID)
    : await lookupCustomerByPhone(INBOUND_PHONE!);
  console.log(`Customer: "${customer.name}" (id: ${customer.id})`);
  console.log(`Mode: ${USE_CONTACTS ? 'customer contacts (/representatives)' : 'internal staff (/our-representatives)'}\n`);

  const reps = await getRepresentatives(token, customer.id, USE_CONTACTS);
  console.log(`Representatives: ${reps.length}`);

  if (reps.length === 0) {
    console.log('  No representatives found.');
    return;
  }

  reps.forEach((r, i) => {
    const name = [r.firstName, r.lastName].filter(Boolean).join(' ') || '(no name)';
    const phones = [r.cellPhone && `cell: ${r.cellPhone}`, r.landlinePhone && `landline: ${r.landlinePhone}`]
      .filter(Boolean).join(', ') || 'no phones';
    console.log(`  [${i + 1}] ${name} | ${phones} | email: ${r.email ?? '-'} | active: ${r.isActive} | dnc: ${r.isDoNotCall} | v${r.version}`);
  });
}

main().catch(console.error);
