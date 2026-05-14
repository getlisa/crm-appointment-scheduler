import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const SUPABASE_URL     = process.env.SUPABASE_URL!.trim();
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!.trim();
const response = await fetch(
  `https://tpvserzjhmyxjssabokm.supabase.co/functions/v1/buildops_cron`,
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  },
);

console.log('Status:', response.status);
console.log(await response.json());
