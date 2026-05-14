import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const CLIENT_ID = process.env.CLIENT_ID!;
const CLIENT_SECRET = process.env.CLIENT_SECRET!;
const TENANT_ID = process.env.TENANT_ID!;
const BASE_URL = 'https://public-api.live.buildops.com/v1';
const PAGE_SIZE = 100;

async function getAccessToken(): Promise<string> {
  const res = await fetch(`${BASE_URL}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, tenantId: TENANT_ID }),
  });
  if (!res.ok) throw new Error(`Auth failed: ${res.status}`);
  const data = await res.json();
  return data.access_token;
}

async function fetchPage(token: string, page: number) {
  const params = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE) });
  const res = await fetch(`${BASE_URL}/job-types?${params}`, {
    headers: { Authorization: `Bearer ${token}`, tenantId: TENANT_ID, Accept: 'application/json' },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Failed (${res.status}): ${JSON.stringify(err)}`);
  }
  return res.json() as Promise<{ totalCount: number; items: Record<string, unknown>[] }>;
}

async function getJobTypes() {
  const token = await getAccessToken();
  console.log('Token acquired.');

  const first = await fetchPage(token, 0);
  const totalCount = first.totalCount;
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  console.log(`Total job types: ${totalCount} — fetching ${totalPages} page(s)...`);

  const allItems = [...first.items];
  for (let page = 1; page < totalPages; page++) {
    const { items } = await fetchPage(token, page);
    allItems.push(...items);
  }

  console.log('\nJob Types:');
  allItems.forEach((jt, i) => {
    console.log(`  [${i + 1}] id: ${jt['id']} | tagName: ${jt['tagName']} | tagType: ${jt['tagType']}`);
  });
}

getJobTypes().catch(console.error);
