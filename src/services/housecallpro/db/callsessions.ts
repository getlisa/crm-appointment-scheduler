/**
 * Supabase queries for the housecallpro_callsessions table.
 * One row per Retell call.
 *
 * Column semantics:
 *   session_id     — internal stable UUID (DB default); FK target for housecallpro_jobs
 *   retell_call_id — Retell's real call_id (call_xxx), set at call_started; used for /fn lookups
 */

import { supabaseAdmin as supabase } from '../../../lib/supabase.js';
import type { HcpCallSessionRow, HcpCallStatus, HcpServiceAddressMap } from '../types.js';

function mapRow(row: Record<string, unknown>): HcpCallSessionRow {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    tenantId: row.tenant_id as string,
    retellCallId: (row.retell_call_id as string | null) ?? null,
    caller: row.caller as string,
    toNumber: (row.to_number as string | null) ?? null,
    housecallproCustomerId: (row.housecallpro_customer_id as string | null) ?? null,
    customerName: (row.customer_name as string | null) ?? null,
    matchTier: (row.match_tier as string | null) ?? null,
    selectedSlotStart: (row.selected_slot_start as string | null) ?? null,
    selectedSlotEnd: (row.selected_slot_end as string | null) ?? null,
    selectedSlotDisplay: (row.selected_slot_display as string | null) ?? null,
    selectedTechnicianId: (row.selected_technician_id as string | null) ?? null,
    housecallproJobId: (row.housecallpro_job_id as string | null) ?? null,
    housecallproJobNumber: (row.housecallpro_job_number as string | null) ?? null,
    escalationType: (row.escalation_type as string | null) ?? null,
    escalationSummary: (row.escalation_summary as string | null) ?? null,
    status: (row.status as HcpCallStatus) ?? 'active',
    serviceAddressMap: (row.service_address_map as HcpServiceAddressMap | null) ?? null,
  };
}

export async function createCallSession(params: {
  tenantId: string;
  caller: string;
  toNumber?: string | null;
  retellCallId?: string | null;
}): Promise<HcpCallSessionRow> {
  const { data, error } = await supabase
    .from('housecallpro_callsessions')
    .insert({
      tenant_id: params.tenantId,
      caller: params.caller,
      to_number: params.toNumber ?? null,
      retell_call_id: params.retellCallId ?? null,
      status: 'active',
    })
    .select('*')
    .single();

  if (error || !data) throw new Error(`createCallSession: ${error?.message}`);
  return mapRow(data as Record<string, unknown>);
}

/** Looks up a session by Retell's real call_id (set at call_started). */
export async function getByRetellCallId(retellCallId: string): Promise<HcpCallSessionRow | null> {
  const { data, error } = await supabase
    .from('housecallpro_callsessions')
    .select('*')
    .eq('retell_call_id', retellCallId)
    .single();

  if (error || !data) return null;
  return mapRow(data as Record<string, unknown>);
}

/** Finds the most recent active session for a caller+tenant (last-10 match in JS). */
export async function findActiveByCallerAndTenant(
  tenantId: string,
  caller: string,
): Promise<HcpCallSessionRow | null> {
  const last10 = caller.replace(/\D/g, '').slice(-10);

  const { data } = await supabase
    .from('housecallpro_callsessions')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(5);

  if (!data || (data as unknown[]).length === 0) return null;

  const match = (data as Record<string, unknown>[]).find(row => {
    const stored = ((row.caller as string) ?? '').replace(/\D/g, '').slice(-10);
    return stored.length === 10 && last10.length === 10 && stored === last10;
  });

  return match ? mapRow(match) : null;
}

export async function setRetellCallId(sessionId: string, retellCallId: string): Promise<void> {
  await supabase
    .from('housecallpro_callsessions')
    .update({ retell_call_id: retellCallId })
    .eq('session_id', sessionId);
}

export async function setMatchedCustomer(
  sessionId: string,
  housecallproCustomerId: string,
  customerName: string | null,
  matchTier?: string,
): Promise<void> {
  await supabase
    .from('housecallpro_callsessions')
    .update({
      housecallpro_customer_id: housecallproCustomerId,
      customer_name: customerName,
      ...(matchTier ? { match_tier: matchTier } : {}),
    })
    .eq('session_id', sessionId);
}

export async function setServiceAddressMap(
  sessionId: string,
  map: HcpServiceAddressMap,
): Promise<void> {
  await supabase
    .from('housecallpro_callsessions')
    .update({ service_address_map: map })
    .eq('session_id', sessionId);
}

export async function setSelectedSlot(
  sessionId: string,
  slot: { start?: string | null; end?: string | null; display?: string | null; technicianId?: string | null },
): Promise<void> {
  await supabase
    .from('housecallpro_callsessions')
    .update({
      selected_slot_start: slot.start ?? null,
      selected_slot_end: slot.end ?? null,
      selected_slot_display: slot.display ?? null,
      selected_technician_id: slot.technicianId ?? null,
    })
    .eq('session_id', sessionId);
}

export async function setJobCreated(
  sessionId: string,
  jobId: string,
  jobNumber: string | null,
): Promise<void> {
  await supabase
    .from('housecallpro_callsessions')
    .update({
      housecallpro_job_id: jobId,
      housecallpro_job_number: jobNumber,
      status: 'job_created',
    })
    .eq('session_id', sessionId);
}

export async function setEscalation(
  sessionId: string,
  escalationType: string,
  escalationSummary: string,
): Promise<void> {
  await supabase
    .from('housecallpro_callsessions')
    .update({
      escalation_type: escalationType,
      escalation_summary: escalationSummary,
      status: 'escalated',
    })
    .eq('session_id', sessionId);
}

export async function setStatus(sessionId: string, status: HcpCallStatus): Promise<void> {
  await supabase
    .from('housecallpro_callsessions')
    .update({ status })
    .eq('session_id', sessionId);
}
