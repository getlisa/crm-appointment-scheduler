import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.string().optional(),
  PORT: z.string().optional(),
  SERVICETITAN_ENV: z.enum(['integration', 'production']).default('integration'),
  /** Global fallback campaign id; tenant-level value in servicetitan_tenants.campaign_id takes priority. */
  SERVICETITAN_CAMPAIGN_ID: z.string().min(1).optional(),
  /** Global fallback technician id; tenant-level value in servicetitan_tenants.fallback_technician_id takes priority. */
  SERVICETITAN_FALLBACK_TECHNICIAN_ID: z.string().optional(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  CLIENT_ID: z.string().min(1),
  CLIENT_SECRET: z.string().min(1),
  TENANT_ID: z.string().min(1),
  RETELL_API_KEY: z.string().min(1),
  BASE_URL: z.string().url(),
  LLM_ID: z.string().optional(),
  BUILDOPS_API_URL: z.string().url().optional(),
  BUILDOPS_DEFAULT_JOB_TYPE_ID: z.string().min(1).optional(),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid environment variables: ${parsed.error.message}`);
}

function parseOptionalPositiveInt(value: string | undefined): number | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && Number.isInteger(n) ? n : undefined;
}

export const env = {
  nodeEnv: parsed.data.NODE_ENV ?? 'development',
  port: Number(parsed.data.PORT ?? '8080'),
  serviceTitanEnv: parsed.data.SERVICETITAN_ENV,
  serviceTitanCampaignId: parsed.data.SERVICETITAN_CAMPAIGN_ID ?? null,
  serviceTitanFallbackTechnicianId: parseOptionalPositiveInt(parsed.data.SERVICETITAN_FALLBACK_TECHNICIAN_ID),
  supabaseUrl: parsed.data.SUPABASE_URL,
  supabaseServiceRoleKey: parsed.data.SUPABASE_SERVICE_ROLE_KEY,
  clientId: parsed.data.CLIENT_ID,
  clientSecret: parsed.data.CLIENT_SECRET,
  tenantId: parsed.data.TENANT_ID,
  retellApiKey: parsed.data.RETELL_API_KEY,
  retellBaseUrl: parsed.data.BASE_URL,
  retellLlmId: parsed.data.LLM_ID,
  buildopsApiUrl: parsed.data.BUILDOPS_API_URL ?? 'https://public-api.live.buildops.com',
  buildopsDefaultJobTypeId: parsed.data.BUILDOPS_DEFAULT_JOB_TYPE_ID ?? null,
};
