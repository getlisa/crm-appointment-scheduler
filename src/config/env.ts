import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.string().optional(),
  PORT: z.string().optional(),
  SERVICETITAN_ENV: z.enum(['integration', 'production']).default('integration'),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid environment variables: ${parsed.error.message}`);
}

export const env = {
  nodeEnv: parsed.data.NODE_ENV ?? 'development',
  port: Number(parsed.data.PORT ?? '8080'),
  serviceTitanEnv: parsed.data.SERVICETITAN_ENV,
  supabaseUrl: parsed.data.SUPABASE_URL,
  supabaseServiceRoleKey: parsed.data.SUPABASE_SERVICE_ROLE_KEY,
};
