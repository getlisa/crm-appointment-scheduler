import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const CLIENT_ID = process.env.CLIENT_ID!;
const CLIENT_SECRET = process.env.CLIENT_SECRET!;
const TENANT_ID = process.env.TENANT_ID!;
const BASE_URL = 'https://public-api.live.buildops.com/v1';

// Usage: node create_task.ts <jobId> "<taskName>" [description]
const JOB_ID       = process.argv[2];
const TASK_NAME    = process.argv[3];
const DESCRIPTION  = process.argv[4] ?? null;

if (!JOB_ID || !TASK_NAME) {
  console.error('Usage: node create_task.ts <jobId> "<taskName>" [description]');
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

async function createTask(token: string) {
  const payload: Record<string, unknown> = { name: TASK_NAME };
  if (DESCRIPTION) payload.description = DESCRIPTION;

  const res = await fetch(`${BASE_URL}/jobs/${JOB_ID}/tasks`, {
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

  console.log(`Status: ${res.status}`);
  console.log('Response:', JSON.stringify(data, null, 2));

  if (!res.ok) throw new Error(`Task creation failed (${res.status})`);
  const task = data as Record<string, unknown>;
  console.log(`\nTask created! taskNumber: ${task['taskNumber']} | id: ${task['id']}`);
}

async function main() {
  const token = await getAccessToken();
  console.log('Token acquired.');
  console.log(`Creating task "${TASK_NAME}" in job ${JOB_ID}...\n`);
  await createTask(token);
}

main().catch(console.error);
