import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const CLIENT_ID     = process.env.CLIENT_ID!;
const CLIENT_SECRET = process.env.CLIENT_SECRET!;
const TENANT_ID     = process.env.TENANT_ID!;
const BASE_URL      = 'https://public-api.live.buildops.com/v1';

const DEFAULT_JOB_ID = '2df753ce-9bf2-4d86-aed1-fc09aa1126b9';
const JOB_ID = process.argv[2] ?? DEFAULT_JOB_ID;

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

  const res = await fetch(`${BASE_URL}/jobs/${JOB_ID}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      tenantId: TENANT_ID,
      Accept: 'application/json',
    },
  });

  const text = await res.text();
  let data: Record<string, unknown>;
  try { data = JSON.parse(text); } catch { throw new Error(`Non-JSON response (${res.status}): ${text}`); }

  if (!res.ok) throw new Error(`BuildOps GET /jobs/${JOB_ID} → ${res.status}: ${text}`);

  console.log('=== Job Summary ===');
  console.log(`Job Number   : ${data['jobNumber'] ?? '(null)'}`);
  console.log(`Status       : ${data['status'] ?? '(null)'}`);
  console.log(`Customer     : ${data['customerName'] ?? '(null)'}`);
  console.log(`Rep Name     : ${data['customerRepName'] ?? '(null)'}`);
  console.log(`Best Contact : ${data['bestContact'] ?? '(null)'}`);
  console.log(`Job Type     : ${data['jobTypeName'] ?? '(null)'}`);
  console.log(`Created      : ${(data['audit'] as Record<string, unknown> | undefined)?.['createdDate'] ?? '(null)'}`);

  const departments = (data['departments'] as { id: string; name: string }[] | undefined) ?? [];
  console.log(`Departments  : ${departments.length > 0 ? departments.map(d => d.name).join(', ') : '(none)'}`);

  const desc = data['issueDescription'] as string | null | undefined;
  console.log('\n=== Issue Description ===');
  if (desc) {
    console.log(desc);
  } else {
    console.log('(null — no issue description on job)');
  }

  console.log('\n=== Raw Job Data ===');
  console.log(JSON.stringify(data, null, 2));
}

main().catch(console.error);
