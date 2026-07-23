/**
 * HouseCall Pro first-time customer ingestion (standalone).
 *
 * Walks every page of the HCP /customers endpoint for one tenant and upserts
 * the full result into housecallpro_customers. Use this for the initial backfill;
 * the housecallpro_cron edge function then keeps the cache incrementally in sync.
 *
 * Usage:
 *   npx tsx src/scripts/hcp-first-ingest.ts --no=+18185551234
 *   HCP_SYNC_NO=+18185551234 npx tsx src/scripts/hcp-first-ingest.ts
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in the environment (.env).
 */

import { supabaseAdmin as supabase } from '../lib/supabase.js';
import { resolveByInboundNumber } from '../services/housecallpro/db/tokens.js';
import { buildCustomerRow } from '../services/housecallpro/db/customers.js';
import { listCustomers } from '../services/housecallpro/client.js';
import type { HcpContext } from '../services/housecallpro/types.js';

const BATCH_SIZE = 200;
const PAGE_SIZE = 100;

function parseNo(): string | undefined {
  const arg = process.argv.find(a => a.startsWith('--no='));
  if (arg) return arg.slice('--no='.length).trim();
  return process.env.HCP_SYNC_NO?.trim();
}

async function main(): Promise<void> {
  const no = parseNo();
  if (!no) {
    console.error('Usage: npx tsx src/scripts/hcp-first-ingest.ts --no=<dialed number>');
    process.exit(1);
  }

  const token = await resolveByInboundNumber(no);
  if (!token) {
    console.error(`No housecallpro_tokens row for no="${no}". Add it via POST /api/housecallpro/admin/token first.`);
    process.exit(1);
  }

  const ctx: HcpContext = {
    apiKey: token.apiKey,
    tenantId: token.tenantId,
    emailTo: token.emailTo,
    ccMail: token.ccMail,
  };

  console.log(`[hcp-ingest] starting full ingestion for tenant ${token.tenantId} (no=${no})`);

  let page = 1;
  let totalPages = 1;
  let upserted = 0;

  do {
    const resp = await listCustomers(ctx, page, PAGE_SIZE);
    totalPages = resp.total_pages ?? 1;
    const customers = resp.customers ?? [];
    const rows = customers.map(c => buildCustomerRow(token.tenantId, c));

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const { error } = await supabase
        .from('housecallpro_customers')
        .upsert(rows.slice(i, i + BATCH_SIZE), { onConflict: 'tenant_id,housecallpro_customer_id' });
      if (error) throw new Error(`upsert page ${page}: ${error.message}`);
    }

    upserted += rows.length;
    console.log(`[hcp-ingest] page ${page}/${totalPages} — ${rows.length} customers (running total ${upserted})`);
    page++;
  } while (page <= totalPages);

  console.log(`[hcp-ingest] done — ${upserted} customers upserted across ${totalPages} page(s).`);
  process.exit(0);
}

main().catch(err => {
  console.error('[hcp-ingest] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
