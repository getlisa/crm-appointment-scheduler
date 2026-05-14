/**
 * Supabase queries for the buildops_inbound_calls table.
 * One row per Retell call. Created at call_started/call_inbound and updated
 * throughout the call lifecycle (customer matched, job created, call ended/handed off).
 */

import { supabaseAdmin as supabase } from '../../../lib/supabase.js';
import type { InboundCallRow, InboundCallStatus } from '../types.js';

function mapRow(row: Record<string, unknown>): InboundCallRow {
  return {
    id: row.id as string,
    retellCallId: row.retell_call_id as string,
    tenantId: row.tenant_id as string,
    caller: row.caller as string | null,
    matchedCustomerId: row.matched_customer_id as string | null,
    status: row.status as InboundCallStatus,
    buildopsJobId: row.buildops_job_id as string | null,
  };
}

/**
 * Creates a new inbound call session row at the start of every Retell call.
 *
 * @param params.retellCallId - Retell's unique call identifier (session key throughout the call)
 * @param params.tenantId     - BuildOps tenant UUID resolved from the dialed number
 * @param params.caller       - Caller's E.164 number (may be absent for private numbers)
 * @returns The newly created InboundCallRow
 * @throws If the insert fails
 */
export async function createInboundCall(params: {
  retellCallId: string;
  tenantId: string;
  caller?: string;
}): Promise<InboundCallRow> {
  const { data, error } = await supabase
    .from('buildops_inbound_calls')
    .insert({
      retell_call_id: params.retellCallId,
      tenant_id: params.tenantId,
      caller: params.caller ?? null,
      status: 'active',
    })
    .select()
    .single();

  if (error || !data) throw new Error(`createInboundCall: ${error?.message}`);
  return mapRow(data as Record<string, unknown>);
}

/**
 * Fetches the call session row by Retell call ID.
 * Called at the start of every function-call dispatch to get the current session state.
 *
 * @param retellCallId - Retell call identifier from the webhook payload
 * @returns The InboundCallRow, or null if the session was never created
 */
export async function getInboundCall(retellCallId: string): Promise<InboundCallRow | null> {
  const { data, error } = await supabase
    .from('buildops_inbound_calls')
    .select('*')
    .eq('retell_call_id', retellCallId)
    .single();

  if (error || !data) return null;
  return mapRow(data as Record<string, unknown>);
}

/**
 * Records which customer was identified for this call.
 * Called by lookup and confirm handlers once the customer is resolved.
 *
 * @param retellCallId - Retell call identifier
 * @param customerId   - Our buildops_customers.id (UUID)
 */
export async function setMatchedCustomer(
  retellCallId: string,
  customerId: string,
): Promise<void> {
  await supabase
    .from('buildops_inbound_calls')
    .update({ matched_customer_id: customerId })
    .eq('retell_call_id', retellCallId);
}

/**
 * Records that a BuildOps job was successfully created during this call.
 * Sets status to 'job_created' and stores the BuildOps job UUID.
 *
 * @param retellCallId  - Retell call identifier
 * @param buildopsJobId - BuildOps job UUID returned by POST /v1/jobs
 */
export async function setJobCreated(
  retellCallId: string,
  buildopsJobId: string,
): Promise<void> {
  await supabase
    .from('buildops_inbound_calls')
    .update({ buildops_job_id: buildopsJobId, status: 'job_created' })
    .eq('retell_call_id', retellCallId);
}

/**
 * Updates the call status.
 * Valid transitions: active → ended (normal), active → handed_off (transferred/low confidence).
 *
 * @param retellCallId - Retell call identifier
 * @param status       - New status: 'active' | 'ended' | 'handed_off' | 'job_created'
 */
export async function setCallStatus(
  retellCallId: string,
  status: InboundCallStatus,
): Promise<void> {
  await supabase
    .from('buildops_inbound_calls')
    .update({ status })
    .eq('retell_call_id', retellCallId);
}
