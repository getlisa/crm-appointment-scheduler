/**
 * Supabase queries for the housecallpro_jobs cache.
 * A row is written immediately after a job is created in HCP (via book_job).
 */

import { supabaseAdmin as supabase } from '../../../lib/supabase.js';

export interface InsertJobInput {
  housecallproJobId: string;
  housecallproCustomerId: string;
  addressId: string;
  sessionId?: string | null;
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
  arrivalWindow?: number | null;
  lineItems?: unknown;
}

/**
 * Inserts (upserts on tenant_id + housecallpro_job_id) a created job into housecallpro_jobs.
 *
 * @param tenantId - HCP tenant UUID
 * @param job      - Created job fields
 */
export async function insertJob(tenantId: string, job: InsertJobInput): Promise<void> {
  const { error } = await supabase.from('housecallpro_jobs').upsert(
    {
      tenant_id: tenantId,
      housecallpro_job_id: job.housecallproJobId,
      housecallpro_customer_id: job.housecallproCustomerId,
      address_id: job.addressId,
      session_id: job.sessionId ?? null,
      scheduled_start: job.scheduledStart ?? null,
      scheduled_end: job.scheduledEnd ?? null,
      arrival_window: job.arrivalWindow ?? null,
      line_items: job.lineItems ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'tenant_id,housecallpro_job_id' },
  );
  if (error) throw new Error(`insertJob: ${error.message}`);
}

/** Fetches a cached job by HCP job id, scoped to the tenant. */
export async function getJobByHcpId(
  tenantId: string,
  housecallproJobId: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase
    .from('housecallpro_jobs')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('housecallpro_job_id', housecallproJobId)
    .single();

  if (error || !data) return null;
  return data as Record<string, unknown>;
}
