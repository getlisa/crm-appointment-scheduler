/**
 * Fetches a paginated list of invoices with optional filters.
 *
 * Usage:
 *   npx ts-node tests/buildops/api_endpoints/get_invoices_list.ts [options]
 *
 * Options:
 *   --status <draft|exported|void|closed|posted|deleted|bypassed>
 *   --start  <ISO 8601>   e.g. 2024-01-01T00:00:00Z
 *   --end    <ISO 8601>   e.g. 2024-12-31T23:59:59Z
 *   --dateFilterType <issuedDate|dueDate|createdDateTime|lastUpdatedDateTime>  (default: lastUpdatedDateTime)
 *   --invoice_number <string>
 *   --page <number>       (default: 0)
 *   --page_size <number>  (default: 10, max: 100)
 *
 * Examples:
 *   npx ts-node get_invoices_list.ts
 *   npx ts-node get_invoices_list.ts --status posted --page_size 25
 *   npx ts-node get_invoices_list.ts --start 2024-01-01T00:00:00Z --end 2024-06-30T23:59:59Z --dateFilterType issuedDate
 *   npx ts-node get_invoices_list.ts --invoice_number 40091
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const CLIENT_ID     = process.env.CLIENT_ID!;
const CLIENT_SECRET = process.env.CLIENT_SECRET!;
const TENANT_ID     = process.env.TENANT_ID!;
const BASE_URL      = 'https://public-api.live.buildops.com/v1';

// ── Parse CLI args ────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

const FILTERS = {
  status:          arg('status'),
  start:           arg('start'),
  end:             arg('end'),
  dateFilterType:  arg('dateFilterType') ?? 'lastUpdatedDateTime',
  invoice_number:  arg('invoice_number'),
  page:            Number(arg('page') ?? 0),
  page_size:       Number(arg('page_size') ?? 10),
};

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function getAccessToken(): Promise<string> {
  const res = await fetch(`${BASE_URL}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, tenantId: TENANT_ID }),
  });
  if (!res.ok) throw new Error(`Auth failed (${res.status}): ${await res.text()}`);
  return (await res.json()).access_token;
}

async function apiGet<T>(token: string, endpoint: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      tenantId: TENANT_ID,
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`GET ${endpoint} → ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

// ── Steps ─────────────────────────────────────────────────────────────────────

function buildQueryString(): string {
  const params = new URLSearchParams();
  params.set('page',           String(FILTERS.page));
  params.set('page_size',      String(FILTERS.page_size));
  params.set('dateFilterType', FILTERS.dateFilterType);
  if (FILTERS.status)         params.set('status',         FILTERS.status);
  if (FILTERS.start)          params.set('start',          FILTERS.start);
  if (FILTERS.end)            params.set('end',            FILTERS.end);
  if (FILTERS.invoice_number) params.set('invoice_number', FILTERS.invoice_number);
  return params.toString();
}

interface InvoiceListResponse {
  totalCount: number;
  items: Record<string, unknown>[];
  query?: Record<string, unknown>;
  links?: Record<string, unknown>;
}

async function step1_fetchList(token: string): Promise<InvoiceListResponse> {
  const qs = buildQueryString();
  console.log('\n── Step 1: Fetch invoices list ─────────────────────────────────────────');
  console.log(`  GET /v1/invoices?${qs}`);

  return apiGet<InvoiceListResponse>(token, `/invoices?${qs}`);
}

function step2_printList(data: InvoiceListResponse): void {
  const items = data.items ?? [];
  console.log('\n── Step 2: Results ─────────────────────────────────────────────────────');
  console.log(`  totalCount  : ${data.totalCount}`);
  console.log(`  page        : ${FILTERS.page}`);
  console.log(`  page_size   : ${FILTERS.page_size}`);
  console.log(`  returned    : ${items.length}`);

  if (items.length === 0) {
    console.log('\n  (no invoices matched the filters)');
    return;
  }

  const colW = { num: 8, status: 10, total: 12, job: 8, id: 38 };

  console.log(
    `\n  ${'#'.padEnd(colW.num)}` +
    `${'Status'.padEnd(colW.status)}` +
    `${'Total'.padEnd(colW.total)}` +
    `${'Job'.padEnd(colW.job)}` +
    `id (UUID)`,
  );
  console.log('  ' + '─'.repeat(colW.num + colW.status + colW.total + colW.job + colW.id));

  for (const inv of items) {
    const num        = String(inv['invoiceNumber'] ?? '—').slice(0, colW.num - 1).padEnd(colW.num);
    const status     = String(inv['status']        ?? '—').slice(0, colW.status - 1).padEnd(colW.status);
    const total      = String(inv['totalAmount']   ?? '—').slice(0, colW.total - 1).padEnd(colW.total);
    const job        = String(inv['jobNumber']     ?? '—').slice(0, colW.job - 1).padEnd(colW.job);
    const id         = String(inv['id'] ?? '—');
    console.log(`  ${num}${status}${total}${job}${id}`);
  }
}

function step3_assertions(data: InvoiceListResponse): void {
  console.log('\n── Step 3: Assertions ──────────────────────────────────────────────────');

  const items = data.items ?? [];
  const statusValues = new Set(['draft', 'exported', 'void', 'closed', 'posted', 'deleted', 'bypassed']);

  const checks: [string, boolean, string][] = [
    ['totalCount is a number',        typeof data.totalCount === 'number',    String(data.totalCount)],
    ['items is an array',             Array.isArray(items),                   `length=${items.length}`],
    ['page_size respected',           items.length <= FILTERS.page_size,      `${items.length} ≤ ${FILTERS.page_size}`],
    ['all items have an id',          items.every(i => !!i['id']),            items.every(i => !!i['id']) ? 'ok' : 'some missing'],
    ['all statuses are valid values', items.every(i => statusValues.has(String(i['status']))),
                                      items.every(i => statusValues.has(String(i['status']))) ? 'ok' : 'invalid status found'],
    ...(FILTERS.status
      ? [['status filter applied', items.every(i => i['status'] === FILTERS.status), `all = ${FILTERS.status}`] as [string, boolean, string]]
      : []),
  ];

  let passed = 0;
  console.log('');
  for (const [label, ok, detail] of checks) {
    console.log(`  ${ok ? '✓' : '✗'} ${label.padEnd(38)} ${detail}`);
    if (ok) passed++;
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════');
  console.log(`  ${passed}/${checks.length} assertions passed`);
  console.log('═══════════════════════════════════════════════════════════════════════');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const token = await getAccessToken();
  console.log('Token acquired.');

  console.log('\nFilters applied:');
  for (const [k, v] of Object.entries(FILTERS)) {
    if (v !== undefined && v !== '') console.log(`  ${k.padEnd(16)}: ${v}`);
  }

  const data = await step1_fetchList(token);
  step2_printList(data);
  step3_assertions(data);

  if (data.totalCount > FILTERS.page_size) {
    const remaining = data.totalCount - FILTERS.page_size * (FILTERS.page + 1);
    if (remaining > 0) {
      console.log(`\n  Next page: --page ${FILTERS.page + 1} --page_size ${FILTERS.page_size}`);
    }
  }
}

main().catch(console.error);
