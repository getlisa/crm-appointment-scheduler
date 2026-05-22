import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const TENANT_ID = process.env.TENANT_ID!;

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Usage: npx tsx getcustomers.ts [--name <partial>] [--phone <digits>] [--limit <n>]
const nameFlag  = process.argv.indexOf('--name');
const phoneFlag = process.argv.indexOf('--phone');
const limitFlag = process.argv.indexOf('--limit');
const NAME_FILTER  = nameFlag  !== -1 ? process.argv[nameFlag + 1]  : null;
const PHONE_FILTER = phoneFlag !== -1 ? process.argv[phoneFlag + 1] : null;
const LIMIT        = limitFlag !== -1 ? parseInt(process.argv[limitFlag + 1], 10) : 100;

async function main() {
  console.log(`Querying buildops_customers (tenant: ${TENANT_ID})...\n`);

  let q = supabase
    .from('buildops_customers')
    .select('buildops_customer_id, name, status, phone_primary, price_book_id, all_numbers, all_numbers_sources, representative_ids, property_ids')
    .eq('tenant_id', TENANT_ID)
    .order('name')
    .limit(LIMIT);

  if (NAME_FILTER) {
    q = q.ilike('name', `%${NAME_FILTER}%`);
  }
  if (PHONE_FILTER) {
    const digits = PHONE_FILTER.replace(/\D/g, '').slice(-10);
    q = q.contains('all_numbers', [digits]);
  }

  const { data, error } = await q;
  if (error) throw new Error(`Supabase query failed: ${error.message}`);
  if (!data || data.length === 0) {
    console.log('No customers found.');
    return;
  }

  console.log(`Found ${data.length} customer(s):\n`);

  for (const c of data) {
    const allNums  = (c.all_numbers  as string[] | null) ?? [];
    const allSrcs  = (c.all_numbers_sources as string[] | null) ?? [];
    const repIds   = (c.representative_ids as string[] | null) ?? [];
    const propIds  = (c.property_ids as string[] | null) ?? [];

    console.log(`${c.name}`);
    console.log(`  buildops_customer_id : ${c.buildops_customer_id}`);
    console.log(`  status               : ${c.status ?? '-'}`);
    console.log(`  phone_primary        : ${c.phone_primary ?? '-'}`);
    console.log(`  price_book_id        : ${c.price_book_id ?? '-'}`);
    console.log(`  properties           : ${propIds.length > 0 ? propIds.join(', ') : '(none)'}`);
    console.log(`  representative_ids   : ${repIds.length > 0 ? `${repIds.length} rep(s)` : '(none)'}`);
    console.log(`  all_numbers (${String(allNums.length).padStart(2)})`);
    allNums.forEach((n, i) => {
      console.log(`    ${n.padEnd(12)}  ← ${allSrcs[i] ?? '?'}`);
    });
    console.log();
  }
}

main().catch(console.error);
