/**
 * Fetches a single invoice by ID and prints its key fields.
 *
 * Usage:
 *   npx ts-node tests/buildops/api_endpoints/get_invoice_by_id.ts <invoiceId>
 *
 * Example:
 *   npx ts-node tests/buildops/api_endpoints/get_invoice_by_id.ts 11785575-1328-4063-9683-e2f7a18d5a7d
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

const INVOICE_ID = process.argv[2];
if (!INVOICE_ID) {
  console.error('Usage: npx ts-node get_invoice_by_id.ts <invoiceId>');
  process.exit(1);
}

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

async function step1_fetchInvoice(token: string): Promise<Record<string, unknown>> {
  console.log('\n── Step 1: Fetch invoice ───────────────────────────────────────────────');
  console.log(`  GET /v1/invoices/${INVOICE_ID}`);

  const invoice = await apiGet<Record<string, unknown>>(token, `/invoices/${INVOICE_ID}`);
  return invoice;
}

function fmtUnix(val: unknown): string {
  if (!val) return '(null)';
  const ms = Number(val) * (String(val).length <= 10 ? 1000 : 1);
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

async function step2_printSummary(invoice: Record<string, unknown>): Promise<void> {
  console.log('\n── Step 2: Invoice summary ─────────────────────────────────────────────');

  const fields: [string, string][] = [
    ['id',                    invoice['id']                    as string],
    ['invoiceNumber',         invoice['invoiceNumber']         as string],
    ['status',                invoice['status']                as string],
    ['jobNumber',             invoice['jobNumber']             as string],
    ['jobId',                 invoice['jobId']                 as string],
    ['billingCustomerId',     invoice['billingCustomerId']     as string],
    ['tenantCompanyName',     invoice['tenantCompanyName']     as string],
    ['totalAmount',           String(invoice['totalAmount'])],
    ['subtotal',              String(invoice['subtotal'])],
    ['taxAmount',             String(invoice['taxAmount'])],
    ['salesTaxRate',          String(invoice['salesTaxRate'])],
    ['discount',              String(invoice['discount'])],
    ['paymentTermName',       invoice['paymentTermName']       as string],
    ['isFinalInvoice',        String(invoice['isFinalInvoice'])],
    ['issuedDate',            fmtUnix(invoice['issuedDate'])],
    ['dueDate',               fmtUnix(invoice['dueDate'])],
    ['postingDate',           fmtUnix(invoice['postingDate'])],
    ['closedDate',            fmtUnix(invoice['closedDate'])],
    ['departmentId',          invoice['departmentId']          as string],
    ['projectId',             invoice['projectId']             as string],
    ['projectName',           invoice['projectName']           as string],
    ['serviceAgreementId',    invoice['serviceAgreementId']    as string],
    ['customerPropertyId',    invoice['customerPropertyId']    as string],
    ['note',                  invoice['note']                  as string],
    ['summary',               invoice['summary']              as string],
    ['authorizedBy',          invoice['authorizedBy']          as string],
    ['customerProvidedPONumber', invoice['customerProvidedPONumber'] as string],
    ['customerProvidedWONumber', invoice['customerProvidedWONumber'] as string],
    ['amountNotToExceed',     String(invoice['amountNotToExceed'])],
    ['invoicePdfUrl',         invoice['invoicePdfUrl']         as string],
  ];

  const pad = Math.max(...fields.map(([k]) => k.length));
  for (const [key, val] of fields) {
    console.log(`  ${key.padEnd(pad)} : ${val ?? '(null)'}`);
  }

  // ── Line items ──
  const items = invoice['invoiceItems'] as Record<string, unknown>[] | null;
  if (items && items.length > 0) {
    console.log(`\n  Invoice items (${items.length}):`);
    for (const item of items) {
      console.log(
        `    [${item['sortOrder'] ?? '?'}] ${String(item['name']).slice(0, 50).padEnd(50)}` +
        `  qty=${item['quantity'] ?? '-'}  unitPrice=${item['unitPrice'] ?? '-'}  amount=${item['amount'] ?? '-'}  taxable=${item['taxable']}`,
      );
    }
  } else {
    console.log('\n  Invoice items : (none or hidden — showLineItems may be false)');
  }

  // ── Payments ──
  const payments = invoice['payments'] as Record<string, unknown>[] | null;
  if (payments && payments.length > 0) {
    console.log(`\n  Payments (${payments.length}):`);
    for (const p of payments) {
      console.log(
        `    #${p['paymentNumber']}  status=${p['paymentStatus']}  amount=${p['paymentAmount']}  applied=${p['appliedAmount']}  date=${p['paymentDate']}`,
      );
    }
  } else {
    console.log('\n  Payments      : (none)');
  }

  // ── Addresses ──
  const addresses = invoice['addresses'] as Record<string, unknown>[] | null;
  if (addresses && addresses.length > 0) {
    console.log(`\n  Addresses (${addresses.length}):`);
    for (const a of addresses) {
      console.log(`    [${a['addressType']}] ${a['addressLine1'] ?? ''} ${a['city'] ?? ''} ${a['state'] ?? ''} ${a['zipcode'] ?? ''}`.trim());
    }
  }
}

async function step3_fetchJob(token: string, jobId: string): Promise<void> {
  console.log('\n── Step 3: Job details ─────────────────────────────────────────────────');
  console.log(`  GET /v1/jobs/${jobId}`);

  let job: Record<string, unknown>;
  try {
    job = await apiGet<Record<string, unknown>>(token, `/jobs/${jobId}`);
  } catch (err) {
    console.log(`  ✗ Could not fetch job: ${(err as Error).message}`);
    return;
  }

  const fields: [string, string][] = [
    ['jobId',               job['id']               as string],
    ['jobNumber',           job['jobNumber']         as string],
    ['jobTypeName',         job['jobTypeName']       as string],
    ['jobTypeInternal',     job['jobTypeInternal']   as string],
    ['status',              job['status']            as string],
    ['billingStatus',       job['billingStatus']     as string],
    ['billingType',         job['billingType']       as string],
    ['issueDescription',    job['issueDescription']  as string],
    ['customerRepName',     job['customerRepName']   as string],
    ['amountQuoted',        String(job['amountQuoted'] ?? '(null)')],
    ['costAmount',          String(job['costAmount']   ?? '(null)')],
    ['closeoutReport',      String(job['closeoutReport'])],
    ['createdDate',         fmtUnix(job['createdDateTime'] ?? job['createdDate'])],
    ['completedDate',       fmtUnix(job['completedDate'])],
  ];

  const pad = Math.max(...fields.map(([k]) => k.length));
  for (const [key, val] of fields) {
    console.log(`  ${key.padEnd(pad)} : ${val ?? '(null)'}`);
  }

  // ── Visits ──
  const visits = job['visits'] as Record<string, unknown>[] | null;
  if (visits && visits.length > 0) {
    console.log(`\n  Visits (${visits.length}):`);
    for (const v of visits) {
      console.log(`    [${v['visitNumber']}] scheduledFor=${fmtUnix(v['scheduledFor'])}  status=${v['status'] ?? '—'}`);
    }
  }

  // ── Job notes ──
  const notes = job['notes'] as Record<string, unknown>[] | null;
  if (notes && notes.length > 0) {
    console.log(`\n  Job notes (${notes.length}):`);
    for (const n of notes) {
      console.log(`    - ${String(n['note'] ?? n['text'] ?? '').slice(0, 120)}`);
    }
  } else {
    console.log('\n  Job notes     : (none)');
  }

  // ── Raw keys — surfaces anything unexpected ──
  const knownKeys = new Set(['id','jobNumber','jobTypeName','jobTypeInternal','status','billingStatus',
    'billingType','issueDescription','customerRepName','amountQuoted','costAmount','closeoutReport',
    'createdDateTime','createdDate','completedDate','visits','notes']);
  const extra = Object.keys(job).filter(k => !knownKeys.has(k) && job[k] !== null && job[k] !== undefined);
  if (extra.length > 0) {
    console.log(`\n  Other non-null fields available: ${extra.join(', ')}`);
  }
}

function step4_assertions(invoice: Record<string, unknown>): void {
  console.log('\n── Step 3: Assertions ──────────────────────────────────────────────────');

  const checks: [string, boolean, string][] = [
    ['id present',            !!invoice['id'],            invoice['id'] as string],
    ['status present',        !!invoice['status'],        invoice['status'] as string],
    ['totalAmount >= 0',      (invoice['totalAmount'] as number) >= 0, String(invoice['totalAmount'])],
    ['subtotal >= 0',         (invoice['subtotal'] as number) >= 0,    String(invoice['subtotal'])],
    ['salesTaxRate >= 0',     (invoice['salesTaxRate'] as number) >= 0, String(invoice['salesTaxRate'])],
    ['isActive = true',       invoice['isActive'] === true,  String(invoice['isActive'])],
  ];

  let passed = 0;
  console.log('');
  for (const [label, ok, detail] of checks) {
    console.log(`  ${ok ? '✓' : '✗'} ${label.padEnd(30)} ${detail ?? ''}`);
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
  console.log(`\nTarget invoice: ${INVOICE_ID}`);

  const invoice = await step1_fetchInvoice(token);
  await step2_printSummary(invoice);

  const jobId = invoice['jobId'] as string | null;
  if (jobId) {
    await step3_fetchJob(token, jobId);
  } else {
    console.log('\n── Step 3: Job details ─────────────────────────────────────────────────');
    console.log('  (skipped — invoice has no jobId)');
  }

  step4_assertions(invoice);
}

main().catch(console.error);
