// @ts-nocheck — Deno runtime file; npm: imports won't resolve in Node TS.
/**
 * Supabase Edge Function — HouseCall Pro paginated customer sync (deployed as housecallpro_cron).
 * Triggered by pg_cron on a schedule. Each invocation processes ONE page of
 * customers (~100) per tenant to stay within the edge-function time budget.
 *
 * State is stored in housecallpro_tokens.sync_customer_page (INT, default 1):
 *   page >= 1 → fetch that page, dirty-detect vs housecallpro_updated_at, upsert changed rows
 *   page exhausted (items < PAGE_SIZE or page >= total_pages) → reset to 1 for the next cycle
 *
 * Auth is a static per-tenant API key (Authorization: Token <api_key>) — no OAuth refresh.
 * The customer list endpoint returns addresses[] inline, so address_ids are captured
 * without extra calls. Re-upserting a changed customer rewrites mobile_number +
 * address_ids from the current payload, so added/modified/deleted values self-heal.
 *
 * Auto-injected env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2';

const BASE_URL = 'https://api.housecallpro.com';
const PAGE_SIZE = 100;
const BATCH_SIZE = 200;

interface ApiAddress {
  id: string;
  type?: string | null;
  street?: string | null;
  street_line_2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string | null;
}

interface ApiCustomer {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  mobile_number?: string | null;
  company?: string | null;
  company_name?: string | null;
  notifications_enabled?: boolean;
  lead_source?: string | null;
  notes?: string | null;
  tags?: string[];
  created_at?: string | null;
  updated_at?: string | null;
  addresses?: ApiAddress[];
}

interface CustomersResponse {
  page: number;
  page_size: number;
  total_pages: number;
  total_items: number;
  customers: ApiCustomer[];
}

interface TokenRow {
  no: string;
  tenant_id: string;
  api_key: string;
  sync_customer_page?: number;
}

function makeSupabase(): SupabaseClient {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });
}

async function fetchWithRetry(url: string, options: RequestInit, retries = 3, delayMs = 1500): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, options);
    if (res.ok || res.status < 500) return res;
    if (attempt < retries) await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
  }
  return fetch(url, options);
}

function buildCustomerRow(tenantId: string, c: ApiCustomer): Record<string, unknown> {
  return {
    tenant_id: tenantId,
    housecallpro_customer_id: c.id,
    first_name: c.first_name ?? null,
    last_name: c.last_name ?? null,
    company_name: c.company_name ?? c.company ?? '',
    email: c.email ?? null,
    mobile_number: c.mobile_number ?? null,
    notifications_enabled: c.notifications_enabled ?? false,
    lead_source: c.lead_source ?? null,
    notes: c.notes ?? null,
    tags: c.tags ?? [],
    housecallpro_created_at: c.created_at ?? null,
    housecallpro_updated_at: c.updated_at ?? null,
    address_ids: (c.addresses ?? []).map(a => a.id),
    updated_at: new Date().toISOString(),
  };
}

async function batchUpsert(supabase: SupabaseClient, rows: object[]): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const { error } = await supabase
      .from('housecallpro_customers')
      .upsert(rows.slice(i, i + BATCH_SIZE) as never[], { onConflict: 'tenant_id,housecallpro_customer_id' });
    if (error) throw new Error(`upsert batch ${Math.floor(i / BATCH_SIZE) + 1}: ${error.message}`);
  }
}

async function syncTenantPage(supabase: SupabaseClient, t: TokenRow): Promise<Record<string, unknown>> {
  const tenantId = t.tenant_id;
  const page = t.sync_customer_page ?? 1;

  const res = await fetchWithRetry(`${BASE_URL}/customers?page=${page}&page_size=${PAGE_SIZE}`, {
    headers: { Authorization: `Token ${t.api_key}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`customers page ${page}: ${res.status} ${await res.text().catch(() => '')}`);
  const data = (await res.json()) as CustomersResponse;
  const items = data.customers ?? [];
  const totalPages = data.total_pages ?? 1;

  // Dirty detection: compare API updated_at vs cached housecallpro_updated_at
  const { data: dbRows, error: dbErr } = await supabase
    .from('housecallpro_customers')
    .select('housecallpro_customer_id, housecallpro_updated_at')
    .eq('tenant_id', tenantId);
  if (dbErr) throw new Error(`dbCustomerMap query: ${dbErr.message}`);
  const cachedMap = new Map(
    (dbRows ?? []).map((r: { housecallpro_customer_id: string; housecallpro_updated_at: string | null }) => [
      r.housecallpro_customer_id,
      r.housecallpro_updated_at ?? '',
    ]),
  );

  const dirty = items.filter(c => {
    const cached = cachedMap.get(c.id);
    return cached === undefined || cached !== (c.updated_at ?? '');
  });

  if (dirty.length > 0) {
    await batchUpsert(supabase, dirty.map(c => buildCustomerRow(tenantId, c)));
  }

  const pageExhausted = items.length < PAGE_SIZE || page >= totalPages;
  const nextPage = pageExhausted ? 1 : page + 1;
  await supabase.from('housecallpro_tokens').update({ sync_customer_page: nextPage }).eq('no', t.no);

  return {
    tenant: t.no,
    page,
    total_pages: totalPages,
    customers_on_page: items.length,
    upserted: dirty.length,
    skipped: items.length - dirty.length,
    page_exhausted: pageExhausted,
    next_page: nextPage,
  };
}

Deno.serve(async (_req: Request) => {
  try {
    const supabase = makeSupabase();
    const { data: tokens, error } = await supabase
      .from('housecallpro_tokens')
      .select('no, tenant_id, api_key, sync_customer_page');
    if (error) throw new Error(`housecallpro_tokens load: ${error.message}`);
    if (!tokens || (tokens as TokenRow[]).length === 0) {
      throw new Error('No rows in housecallpro_tokens — insert a tenant first.');
    }

    const results: Record<string, unknown>[] = [];
    for (const t of tokens as TokenRow[]) {
      if (!t.api_key || !t.tenant_id) {
        results.push({ tenant: t.no, skipped: 'missing api_key or tenant_id' });
        continue;
      }
      try {
        results.push(await syncTenantPage(supabase, t));
      } catch (err) {
        results.push({ tenant: t.no, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return new Response(JSON.stringify(results.length === 1 ? results[0] : results), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
