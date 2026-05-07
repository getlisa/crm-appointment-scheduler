import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const CLIENT_ID = process.env.CLIENT_ID!;
const CLIENT_SECRET = process.env.CLIENT_SECRET!;
const TENANT_ID = process.env.TENANT_ID!;
const BASE_URL = 'https://public-api.live.buildops.com/v1';

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

function parseCSVLine(line: string): string[] {
  const cols: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      cols.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  cols.push(cur);
  return cols;
}

function extractPriceBookIdsFromCSV(): string[] {
  const csvPath = path.resolve(__dirname, 'customers.csv');
  const lines = fs.readFileSync(csvPath, 'utf-8').trim().split('\n');
  const headers = lines[0].split(',');
  const pbIdx = headers.indexOf('priceBookId');

  if (pbIdx === -1) {
    throw new Error('"priceBookId" column not found in customers.csv. Re-run getcustomers.ts first.');
  }

  const ids = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    const val = parseCSVLine(lines[i])[pbIdx]?.trim();
    if (val) ids.add(val);
  }
  return [...ids];
}

async function getPriceBook(token: string, id: string) {
  const res = await fetch(`${BASE_URL}/price-books/${id}`, {
    headers: { Authorization: `Bearer ${token}`, tenantId: TENANT_ID, Accept: 'application/json' },
  });
  const text = await res.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

async function main() {
  const token = await getAccessToken();
  console.log('Token acquired.');

  const ids = extractPriceBookIdsFromCSV();
  console.log(`Unique priceBookIds in customers.csv: ${ids.length}`);
  ids.forEach((id, i) => console.log(`  [${i + 1}] ${id}`));

  console.log('\nFetching price book details...\n');
  for (const id of ids) {
    const { status, data } = await getPriceBook(token, id);
    console.log(`── ${id}`);
    console.log(`   Status: ${status}`);
    console.log(`   ${JSON.stringify(data, null, 2).replace(/\n/g, '\n   ')}\n`);
  }
}

main().catch(console.error);
