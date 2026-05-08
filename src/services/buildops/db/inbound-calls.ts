import { supabaseAdmin as supabase } from '../../../lib/supabase.js';
import type { InboundCallRow, InboundCallStatus, PendingJobData } from '../types.js';

function mapRow(row: Record<string, unknown>): InboundCallRow {
  return {
    id: row.id as string,
    retellCallId: row.retell_call_id as string,
    tenantId: row.tenant_id as string,
    caller: row.caller as string | null,
    receiver: row.receiver as string,
    matchedCustomerId: row.matched_customer_id as string | null,
    status: row.status as InboundCallStatus,
    buildopsJobId: row.buildops_job_id as string | null,
    pendingJobs: (row.pending_jobs as PendingJobData[]) ?? [],
  };
}

export async function createInboundCall(params: {
  retellCallId: string;
  tenantId: string;
  caller?: string;
  receiver: string;
}): Promise<InboundCallRow> {
  const { data, error } = await supabase
    .from('inbound_calls')
    .insert({
      retell_call_id: params.retellCallId,
      tenant_id: params.tenantId,
      caller: params.caller ?? null,
      receiver: params.receiver,
      status: 'active',
    })
    .select()
    .single();

  if (error || !data) throw new Error(`createInboundCall: ${error?.message}`);
  return mapRow(data as Record<string, unknown>);
}

export async function getInboundCall(retellCallId: string): Promise<InboundCallRow | null> {
  const { data, error } = await supabase
    .from('inbound_calls')
    .select('*')
    .eq('retell_call_id', retellCallId)
    .single();

  if (error || !data) return null;
  return mapRow(data as Record<string, unknown>);
}

export async function setMatchedCustomer(
  retellCallId: string,
  customerId: string,
): Promise<void> {
  await supabase
    .from('inbound_calls')
    .update({ matched_customer_id: customerId })
    .eq('retell_call_id', retellCallId);
}

export async function setJobCreated(
  retellCallId: string,
  buildopsJobId: string,
): Promise<void> {
  await supabase
    .from('inbound_calls')
    .update({ buildops_job_id: buildopsJobId, status: 'job_created' })
    .eq('retell_call_id', retellCallId);
}

export async function setCallStatus(
  retellCallId: string,
  status: InboundCallStatus,
): Promise<void> {
  await supabase
    .from('inbound_calls')
    .update({ status })
    .eq('retell_call_id', retellCallId);
}

export async function appendPendingJob(
  retellCallId: string,
  job: PendingJobData,
): Promise<void> {
  const { data } = await supabase
    .from('inbound_calls')
    .select('pending_jobs')
    .eq('retell_call_id', retellCallId)
    .single();

  const current: PendingJobData[] = (data as Record<string, unknown> | null)?.pending_jobs as PendingJobData[] ?? [];
  await supabase
    .from('inbound_calls')
    .update({ pending_jobs: [...current, job] })
    .eq('retell_call_id', retellCallId);
}
