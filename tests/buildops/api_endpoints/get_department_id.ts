import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const CLIENT_ID = process.env.CLIENT_ID!;
const CLIENT_SECRET = process.env.CLIENT_SECRET!;
const TENANT_ID = process.env.TENANT_ID!;
const API_URL = 'https://public-api.live.buildops.com';
const TARGET_NAME = 'D2 Service Calls (T&M)';

if (!CLIENT_ID || !CLIENT_SECRET || !TENANT_ID) {
  console.error('Missing CLIENT_ID, CLIENT_SECRET, or TENANT_ID in .env');
  process.exit(1);
}

interface Department {
  id: string;
  tagName: string;
  isActive: boolean;
}

async function getToken(): Promise<string> {
  const res = await fetch(`${API_URL}/v1/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, tenantId: TENANT_ID }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Auth failed ${res.status}: ${text}`);
  }
  const data = await res.json() as { access_token: string };
  return data.access_token;
}

async function fetchDepartments(token: string): Promise<Department[]> {
  const results: Department[] = [];
  let page = 0;
  const PAGE_SIZE = 100;

  while (true) {
    const res = await fetch(`${API_URL}/v1/departments?page=${page}&page_size=${PAGE_SIZE}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        tenantId: TENANT_ID,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Departments API failed ${res.status}: ${text}`);
    }

    const data = await res.json() as { departments?: Department[] };
    const items = data.departments ?? [];
    results.push(...items);
    if (items.length < PAGE_SIZE) break;
    page++;
  }

  return results;
}

async function main() {
  console.log('Authenticating...');
  const token = await getToken();
  console.log('Token OK\n');

  const envPath = path.resolve(__dirname, '../../../.env');
  const envContent = readFileSync(envPath, 'utf8');
  if (!envContent.includes(token.slice(0, 20))) {
    const updated = envContent.includes('ACCESS_TOKEN=')
      ? envContent.replace(/^ACCESS_TOKEN=.*/m, `ACCESS_TOKEN=${token}`)
      : `${envContent}\nACCESS_TOKEN=${token}`;
    writeFileSync(envPath, updated, 'utf8');
    console.log('Updated ACCESS_TOKEN in .env\n');
  }

  console.log(`Searching for "${TARGET_NAME}"...`);
  const departments = await fetchDepartments(token);

  const match = departments.find(d => d.tagName === TARGET_NAME);

  if (!match) {
    console.error(`\nNot found: "${TARGET_NAME}"`);
    console.log('\nAvailable departments:');
    departments.forEach(d => console.log(`  ${d.id}  ${d.tagName}  (active: ${d.isActive})`));
    process.exit(1);
  }

  console.log(`Found: ${match.tagName}`);
  console.log(`ID: ${match.id}`);
  console.log(`\nPaste this into src/services/buildops/handlers/job.ts:`);
  console.log(`  const DEFAULT_DEPARTMENT_ID = '${match.id}';`);
}

main().catch(err => { console.error(err); process.exit(1); });
