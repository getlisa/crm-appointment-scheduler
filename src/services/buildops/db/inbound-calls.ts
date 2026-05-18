/**
 * Supabase queries for the buildops_inbound_calls table.
 * One row per Retell call. Created at call_inbound and updated
 * throughout the call lifecycle (customer matched, job created, call ended/handed off).
 *
 * Column semantics:
 *   session_id     — stable UUID assigned at call_inbound (internal session key)
 *   retell_call_id — Retell's real call_id (call_xxx...), set at call_started
 */

import { supabaseAdmin as supabase } from '../../../lib/supabase.js';
import type { InboundCallRow, InboundCallStatus } from '../types.js';

function mapRow(row: Record<string, unknown>): InboundCallRow {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    retellCallId: row.retell_call_id as string | null,
    tenantId: row.tenant_id as string,
    caller: row.caller as string | null,
    matchedCustomerId: row.matched_customer_id as string | null,
    status: row.status as InboundCallStatus,
    buildopsJobId: row.buildops_job_id as string | null,
  };
}

/**
 * Creates a new inbound call session row at call_inbound.
 *
 * @param params.sessionId - Stable UUID for this session (Retell's call_id from call_inbound)
 * @param params.tenantId  - BuildOps tenant UUID resolved from the dialed number
 * @param params.caller    - Caller's E.164 number (may be absent for private numbers)
 */
export async function createInboundCall(params: {
  sessionId: string;
  tenantId?: string;
  caller?: string;
}): Promise<InboundCallRow> {
  const { data, error } = await supabase
    .from('buildops_inbound_calls')
    .insert({
      session_id: params.sessionId,
      tenant_id: params.tenantId ?? null,
      caller: params.caller ?? null,
      status: 'active',
    })
    .select()
    .single();

  if (error || !data) throw new Error(`createInboundCall: ${error?.message}`);
  return mapRow(data as Record<string, unknown>);
}

/**
 * Fetches the call session row by Retell's real call_id (set at call_started).
 * Called at the start of every function-call dispatch to get the current session state.
 *
 * @param retellCallId - Retell's real call_id from the function-call envelope
 * @returns The InboundCallRow, or null if not found
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
 *
 * @param sessionId  - Stable session UUID
 * @param customerId - Our buildops_customers.id (UUID)
 */
export async function setMatchedCustomer(
  sessionId: string,
  customerId: string,
): Promise<void> {
  await supabase
    .from('buildops_inbound_calls')
    .update({ matched_customer_id: customerId })
    .eq('session_id', sessionId);
}

/**
 * Records that a BuildOps job was successfully created during this call.
 * Sets status to 'job_created' and stores the BuildOps job UUID.
 *
 * @param sessionId     - Stable session UUID
 * @param buildopsJobId - BuildOps job UUID returned by POST /v1/jobs
 */
export async function setJobCreated(
  sessionId: string,
  buildopsJobId: string,
): Promise<void> {
  await supabase
    .from('buildops_inbound_calls')
    .update({ buildops_job_id: buildopsJobId, status: 'job_created' })
    .eq('session_id', sessionId);
}

/**
 * Finds the most recent active session for a caller+tenant pair.
 * Used at call_started to locate the session created at call_inbound,
 * and as a fallback for function calls when direct lookup fails.
 */
export async function findActiveByCallerAndTenant(
  tenantId: string,
  caller: string,
): Promise<InboundCallRow | null> {
  const last10 = caller.replace(/\D/g, '').slice(-10);

  const { data, error } = await supabase
    .from('buildops_inbound_calls')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(5);

  if (error || !data || (data as unknown[]).length === 0) {
    console.log('[buildops] findActiveByCallerAndTenant', { tenantId, callerLast10: last10, rowsFound: 0, matched: false, error: error?.message });
    return null;
  }

  const match = (data as Record<string, unknown>[]).find(row => {
    const storedLast10 = ((row.caller as string) ?? '').replace(/\D/g, '').slice(-10);
    return storedLast10.length === 10 && last10.length === 10 && storedLast10 === last10;
  });

  console.log('[buildops] findActiveByCallerAndTenant', { tenantId, callerLast10: last10, rowsFound: (data as unknown[]).length, matched: !!match });
  return match ? mapRow(match) : null;
}

/**
 * Sets the real Retell call_id on the session row at call_started.
 * After this, getInboundCall(realCallId) will find the row directly.
 *
 * @param sessionId  - Stable session UUID (from call_inbound)
 * @param realCallId - Retell's real call_id received at call_started
 */
export async function setRetellCallId(
  sessionId: string,
  realCallId: string,
): Promise<void> {
  await supabase
    .from('buildops_inbound_calls')
    .update({ retell_call_id: realCallId })
    .eq('session_id', sessionId);
}

/**
 * Updates the call status.
 *
 * @param sessionId - Stable session UUID
 * @param status    - New status
 */
export async function setCallStatus(
  sessionId: string,
  status: InboundCallStatus,
): Promise<void> {
  await supabase
    .from('buildops_inbound_calls')
    .update({ status })
    .eq('session_id', sessionId);
}
