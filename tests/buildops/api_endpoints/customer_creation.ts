import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const CLIENT_ID = process.env.CLIENT_ID!;
const CLIENT_SECRET = process.env.CLIENT_SECRET!;
const TENANT_ID = process.env.TENANT_ID!;
const BASE_URL = 'https://public-api.live.buildops.com/v1';

async function getAccessToken(): Promise<string> {
  const response = await fetch(`${BASE_URL}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, tenantId: TENANT_ID }),
  });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(`Auth failed (${response.status}): ${JSON.stringify(err)}`);
  }
  const data = await response.json();
  return data.access_token;
}

async function createCustomer() {
  const token = await getAccessToken();
  console.log('Token acquired.');

  const payload = {
    name: 'clara2',
    customerType: 'Commercial',
    isActive: true,
    email: 'clara2@example.com',
    phonePrimary: '555-100-2000',
    status: 'active',
    addresses: [
      {
        addressType: 'billingAddress',
        billTo: 'clara2',
        addressLine1: '742 Evergreen Terrace',
        addressLine2: 'Suite 1',
        city: 'Springfield',
        state: 'IL',
        zipcode: '62701',
        country: 'US',
        isActive: true,
      },
    ],
  };

  const response = await fetch(`${BASE_URL}/customers`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      tenantId: TENANT_ID,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  console.log('Status:', response.status);
  console.log('Response:', JSON.stringify(data, null, 2));

  if (!response.ok) {
    throw new Error(`Create customer failed (${response.status})`);
  }

  console.log('Customer created! ID:', data.id);
}

createCustomer().catch(console.error);
