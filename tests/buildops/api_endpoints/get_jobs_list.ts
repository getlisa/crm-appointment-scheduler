import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const CLIENT_ID     = process.env.CLIENT_ID!;
const CLIENT_SECRET = process.env.CLIENT_SECRET!;
const TENANT_ID     = process.env.TENANT_ID!;
const BASE_URL      = 'https://public-api.live.buildops.com/v1';

// Usage: node get_jobs_list.ts -number <jobNumber>
//        node get_jobs_list.ts              (lists most recent 10 jobs)
const numberFlagIdx = process.argv.indexOf('-number');
const JOB_NUMBER = numberFlagIdx !== -1 ? process.argv[numberFlagIdx + 1] : undefined;

async function getAccessToken(): Promise<string> {
  const res = await fetch(`${BASE_URL}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, tenantId: TENANT_ID }),
  });
  if (!res.ok) throw new Error(`Auth failed: ${res.status}`);
  return (await res.json()).access_token;
}

interface JobItem {
  id: string;
  jobNumber: string | null;
  status: string | null;
  customerName: string | null;
  customerPropertyName: string | null;
  customerRepName: string | null;
  bestContact: string | null;
  jobTypeName: string | null;
  issueDescription: string | null;
  audit: { createdDate: string | null } | null;
}

async function main() {
  const token = await getAccessToken();
  console.log('Token acquired.\n');

  const params = new URLSearchParams({ page_size: '10', page: '0' });
  if (JOB_NUMBER) params.set('job_number', JOB_NUMBER);

  const url = `${BASE_URL}/jobs?${params}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      tenantId: TENANT_ID,
      Accept: 'application/json',
    },
  });

  const text = await res.text();
  let data: Record<string, unknown>;
  try { data = JSON.parse(text); } catch { throw new Error(`Non-JSON response (${res.status}): ${text}`); }
  if (!res.ok) throw new Error(`BuildOps GET /jobs → ${res.status}: ${text}`);

  const items = (data['items'] as JobItem[]) ?? [];
  const totalCount = data['totalCount'] as number | undefined;

  if (JOB_NUMBER) {
    console.log(`Searching for job_number: "${JOB_NUMBER}"`);
  }
  console.log(`Total matching jobs: ${totalCount ?? '?'}  |  Showing: ${items.length}\n`);

  if (items.length === 0) {
    console.log('No jobs found.');
    return;
  }

  for (const job of items) {
    console.log('─'.repeat(60));
    console.log(`Job Number   : ${job.jobNumber ?? '(null)'}`);
    console.log(`ID (UUID)    : ${job.id}`);
    console.log(`Status       : ${job.status ?? '(null)'}`);
    console.log(`Customer     : ${job.customerName ?? '(null)'}`);
    console.log(`Property     : ${job.customerPropertyName ?? '(null)'}`);
    console.log(`Rep Name     : ${job.customerRepName ?? '(null)'}`);
    console.log(`Best Contact : ${job.bestContact ?? '(null)'}`);
    console.log(`Job Type     : ${job.jobTypeName ?? '(null)'}`);
    console.log(`Created      : ${job.audit?.createdDate ?? '(null)'}`);
    if (job.issueDescription) {
      console.log(`Description  : ${job.issueDescription}`);
    }
  }
  console.log('─'.repeat(60));

  if (items.length === 1) {
    console.log('\n=== Raw Job Data ===');
    console.log(JSON.stringify(items[0], null, 2));
  }
}

main().catch(console.error);
