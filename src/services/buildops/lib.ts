import fs from 'fs';
import path from 'path';

export const BASE_URL = 'https://public-api.live.buildops.com/v1';

export const CSV_FIELDS = [
  'id', 'name', 'accountNumber', 'customerType', 'isActive', 'status',
  'email', 'customerNumber', 'creditLimit', 'isTaxable', 'taxRateValue',
  'phonePrimary', 'phoneAlternate', 'receiveSMS',
  'priceBookId', 'paymentTermId', 'invoicePresetId', 'invoiceDeliveryPref',
  'logoUrl', 'websiteUrl', 'version', 'tenantId', 'tenantCompanyId', 'amountNotToExceed',
  'last_updated',
  'last_added',
  'all_numbers',
  'all_numbers_sources',
  'addresses_all',
  'representatives',
  'properties',
] as const;

export type PhoneEntry = { phone: string; source: string };

export type PropertySummary = {
  id: string;
  companyName: string | null;
  phonePrimary: string | null;
  phoneAlternate: string | null;
  priceBookId: string | null;
  isTaxable: boolean;
  version: number;
  addresses: {
    addressLine1: string;
    addressLine2: string | null;
    city: string;
    state: string;
    zipcode: string;
    addressType: string;
  }[];
};

export type RepSummary = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  cellPhone: string | null;
  landlinePhone: string | null;
  email: string | null;
  propertyId: string | null;
  isActive: boolean;
  isDoNotCall: boolean;
  version: number;
};

export type SyncState = {
  lastRunAt: string | null;
  lastSyncedMs: number;
  versions: Record<string, number>;
  propertyVersions: Record<string, number>;
};

const EMPTY_STATE: SyncState = { lastRunAt: null, lastSyncedMs: 0, versions: {}, propertyVersions: {} };

export async function getAccessToken(clientId: string, clientSecret: string, tenantId: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret, tenantId }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Auth failed (${res.status}): ${text}`);
  }
  return ((await res.json()) as { access_token: string }).access_token;
}

export function normalize(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '').slice(-10);
  return digits.length === 10 ? digits : null;
}

export function escape(val: unknown): string {
  const str = val == null ? '' : String(val);
  return str.includes(',') || str.includes('"') || str.includes('\n')
    ? `"${str.replace(/"/g, '""')}"`
    : str;
}

export function toCSVRow(item: Record<string, unknown>): string {
  return (CSV_FIELDS as readonly string[]).map(f => escape(item[f])).join(',');
}

export function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      let field = '';
      i++;
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') { field += '"'; i += 2; }
        else if (line[i] === '"') { i++; break; }
        else { field += line[i++]; }
      }
      fields.push(field);
      if (line[i] === ',') i++;
    } else {
      const end = line.indexOf(',', i);
      if (end === -1) { fields.push(line.slice(i)); break; }
      fields.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return fields;
}

export function loadSyncState(dir: string): SyncState {
  const p = path.resolve(dir, 'sync_state.json');
  if (!fs.existsSync(p)) return { ...EMPTY_STATE };
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as Partial<SyncState>;
    return { ...EMPTY_STATE, ...parsed };
  } catch {
    return { ...EMPTY_STATE };
  }
}

export function saveSyncState(dir: string, state: SyncState): void {
  fs.writeFileSync(path.resolve(dir, 'sync_state.json'), JSON.stringify(state, null, 2), 'utf-8');
}

export function loadExistingRows(dir: string): Map<string, Record<string, unknown>> {
  const csvPath = path.resolve(dir, 'customers.csv');
  if (!fs.existsSync(csvPath)) return new Map();
  const lines = fs.readFileSync(csvPath, 'utf-8').trim().split('\n');
  if (lines.length < 2) return new Map();
  const headers = parseCSVLine(lines[0]);
  const idIdx = headers.indexOf('id');
  if (idIdx === -1) return new Map();
  const map = new Map<string, Record<string, unknown>>();
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const id = cols[idIdx]?.trim();
    if (!id) continue;
    const row: Record<string, unknown> = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = cols[j] ?? '';
    map.set(id, row);
  }
  return map;
}
