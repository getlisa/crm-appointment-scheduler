import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const BASE_URL = 'https://public-api.live.buildops.com/v1';
const CLIENT_ID = process.env.CLIENT_ID!;
const CLIENT_SECRET = process.env.CLIENT_SECRET!;
const TENANT_ID = process.env.TENANT_ID!;
const CUSTOMER_ID = process.argv[2] ?? '3e34ee30-60e4-4017-ab5b-f7c1c7cb6426';

async function getToken(): Promise<string> {
  const res = await fetch(`${BASE_URL}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, tenantId: TENANT_ID }),
  });
  if (!res.ok) throw new Error(`Auth failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function getReps(token: string, customerId: string) {
  const all: unknown[] = [];
  let page = 0;
  while (true) {
    const res = await fetch(
      `${BASE_URL}/customers/${customerId}/our-representatives?page=${page}&page_size=100`,
      { headers: { Authorization: `Bearer ${token}`, tenantId: TENANT_ID, Accept: 'application/json' } },
    );
    if (!res.ok) throw new Error(`Reps fetch failed: ${res.status} ${await res.text()}`);
    const data = await res.json() as { totalCount?: number; items?: unknown[] };
    const items = data.items ?? [];
    all.push(...items);
    console.log(`Page ${page}: ${items.length} reps (totalCount=${data.totalCount})`);
    if (items.length < 100) break;
    page++;
  }
  return all;
}

const token = await getToken();
console.log(`customer_id: ${CUSTOMER_ID}\n`);
const reps = await getReps(token, CUSTOMER_ID);
console.log(`\nTotal reps: ${reps.length}`);
console.log(JSON.stringify(reps, null, 2));
