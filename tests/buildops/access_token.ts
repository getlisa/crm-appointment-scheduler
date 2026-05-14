// test-auth.ts
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const CLIENT_ID = process.env.CLIENT_ID || "<client-id>";
const CLIENT_SECRET = process.env.CLIENT_SECRET || "<client-secret>";
const TENANT_ID = process.env.TENANT_ID || "<tenant-id>";
console.log("CLIENT_ID:", CLIENT_ID);
console.log("CLIENT_SECRET exists:", !!CLIENT_SECRET);
console.log("TENANT_ID:", TENANT_ID);

async function testAuth() {
  try {
    const response = await fetch(
      "https://public-api.live.buildops.com/v1/auth/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          tenantId: TENANT_ID,
        }),
      }
    );

    const data = await response.json();

    console.log("Status:", response.status);
    console.log("Response:", data);

    if (!response.ok) {
      throw new Error(`Auth failed: ${response.status}`);
    }

    console.log("Access Token:", data.access_token);
  } catch (err) {
    console.error("Error:", err);
  }
}

testAuth();