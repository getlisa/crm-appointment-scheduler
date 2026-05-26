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

// Usage:
//   node create_property_representative.ts --property-id <uuid> --first-name <name> --last-name <name> --phone <phone> [--email <email>]
//
// Example (Highcrest, LLC — 6824 Elm St):
//   node create_property_representative.ts --property-id 874ff062-a43e-46ba-9a8c-a17fe1853c03 --first-name Test --last-name Rep --phone 202-555-9999 --email test@highcrestdc.com

function getArg(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : null;
}

const propertyId = getArg('--property-id');
const firstName  = getArg('--first-name');
const lastName   = getArg('--last-name');
const phone      = getArg('--phone');
const email      = getArg('--email');

if (!propertyId || !firstName || !lastName || !phone) {
  console.error('Usage: node create_property_representative.ts --property-id <uuid> --first-name <name> --last-name <name> --phone <phone> [--email <email>]');
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

async function main() {
  const token = await getAccessToken();
  console.log('Token acquired.\n');

  // 1. Look up the property's customer from Supabase
  const { data: propRow } = await supabase
    .from('buildops_properties')
    .select('id, name, customer_id')
    .eq('id', propertyId)
    .maybeSingle();

  if (!propRow) {
    console.warn(`Property ${propertyId} not found in local buildops_properties — proceeding with API call only.\n`);
  } else {
    console.log(`Property : ${propRow.name ?? '(no name)'} (${propRow.id})`);
    console.log(`Customer : ${propRow.customer_id}\n`);
  }

  // 2. Create rep in BuildOps
  const payload: Record<string, string | null> = { firstName, lastName, cellPhone: phone };
  if (email) payload.email = email;

  console.log('Creating rep in BuildOps...');
  console.log('  POST', `${BASE_URL}/properties/${propertyId}/representatives`);
  console.log('  Body:', JSON.stringify(payload));

  const res = await fetch(`${BASE_URL}/properties/${propertyId}/representatives`, {
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
  let data: Record<string, unknown>;
  try { data = JSON.parse(text); } catch { throw new Error(`Non-JSON response (${res.status}): ${text}`); }
  if (!res.ok) throw new Error(`BuildOps POST /properties/${propertyId}/representatives → ${res.status}: ${text}`);

  const buildopsRepId = data['id'] as string;
  console.log(`\nCreated in BuildOps:`);
  console.log(`  buildops_rep_id : ${buildopsRepId}`);
  console.log(`  Raw:`, JSON.stringify(data, null, 2));

  // 3. Mirror to local Supabase (same as handleAddRepresentative does)
  if (propRow?.customer_id) {
    const normalize = (p: string) => p.replace(/\D/g, '').slice(-10);
    const { data: inserted, error } = await supabase
      .from('buildops_representatives')
      .insert({
        tenant_id: TENANT_ID,
        customer_id: propRow.customer_id,
        property_id: propertyId,
        buildops_rep_id: buildopsRepId,
        first_name: firstName,
        last_name: lastName,
        cell_phone: phone,
        landline_phone: null,
        normalized_cell_phone: normalize(phone),
        normalized_landline_phone: null,
        email: email ?? null,
        is_active: true,
        is_do_not_call: false,
        is_email_opt_out: false,
        is_sms_opt_out: false,
        rep_source: 'property_rep',
        version: 0,
      })
      .select()
      .single();

    if (error) {
      console.error(`\nSupabase insert failed: ${error.message}`);
      console.error('Rep was created in BuildOps but NOT mirrored locally.');
    } else {
      const row = inserted as Record<string, unknown>;
      console.log(`\nMirrored to buildops_representatives:`);
      console.log(`  supabase id     : ${row['id']}`);
      console.log(`  buildops_rep_id : ${row['buildops_rep_id']}`);
      console.log(`  customer_id     : ${row['customer_id']}`);
      console.log(`  property_id     : ${row['property_id']}`);
      console.log(`  normalized_cell : ${row['normalized_cell_phone']}`);
    }
  } else {
    console.warn('\nSkipped Supabase mirror — property not found in local DB (run cron first to seed properties).');
  }

  console.log('\n--- Verification ---');
  console.log(`Run to confirm rep in BuildOps:`);
  console.log(`  node tests/buildops/api_endpoints/get_representatives.ts --rep-id ${buildopsRepId}`);
  console.log(`\nTo verify Tier 2 would find this rep (phone lookup):`);
  const digits = phone.replace(/\D/g, '').slice(-10);
  console.log(`  SELECT * FROM buildops_representatives WHERE normalized_cell_phone = '${digits}' AND tenant_id = '${TENANT_ID}';`);
}

main().catch(console.error);
