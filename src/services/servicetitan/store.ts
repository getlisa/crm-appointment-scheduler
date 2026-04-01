import { supabaseAdmin } from '../../lib/supabase.js';
import { buildKnowledgeBaseDocument } from './job-types-kb.js';
import type { RetellJobTypesKnowledgeBase } from './job-types-kb.js';
import { normalizeJobTypeUnknown } from './job-type-normalize.js';
import type { NormalizedJobType } from './job-type-normalize.js';
import type {
  DailyTechnicianSchedule,
  TechnicianScheduleItem,
  ServiceTitanAppointmentApiModel,
  ServiceTitanAssignmentApiModel,
  ServiceTitanJobTypeApiModel,
  ServiceTitanTechnicianApiModel,
} from './types.js';


export async function upsertServiceTitanSnapshot(params: {
  tenantId: number;
  technicians: ServiceTitanTechnicianApiModel[];
  appointments: ServiceTitanAppointmentApiModel[];
  assignments: ServiceTitanAssignmentApiModel[];
}) {
  const now = new Date().toISOString();
  const techRows = params.technicians.map((tech) => ({
    tenant_id: params.tenantId,
    technician_id: tech.id,
    name: tech.name ?? null,
    email: tech.email ?? null,
    phone: tech.phoneNumber ?? null,
    login_name: tech.loginName ?? null,
    skills: tech.skills ?? [],
    permissions: tech.permissions ?? [],
    positions: tech.positions ?? [],
    shift_start: tech.shiftStart ?? null,
    shift_end: tech.shiftEnd ?? null,
    bio: tech.bio ?? null,
    is_active: tech.active ?? true,
    updated_at: now,
  }));

  const appointmentRows = params.appointments.map((appointment) => ({
    tenant_id: params.tenantId,
    appointment_id: appointment.id,
    start_time: appointment.start ?? null,
    end_time: appointment.end ?? null,
    status: appointment.status ?? null,
    updated_at: now,
  }));

  const assignmentRows = params.assignments.map((assignment) => ({
    tenant_id: params.tenantId,
    appointment_id: assignment.appointmentId,
    technician_id: assignment.technicianId,
    updated_at: now,
  }));

  if (techRows.length) {
    const { error } = await supabaseAdmin.from('servicetitan_technicians').upsert(techRows, {
      onConflict: 'tenant_id,technician_id',
    });
    if (error) throw new Error(`Failed upserting technicians: ${error.message}`);
  }

  if (appointmentRows.length) {
    const { error } = await supabaseAdmin.from('servicetitan_appointments').upsert(appointmentRows, {
      onConflict: 'tenant_id,appointment_id',
    });
    if (error) throw new Error(`Failed upserting appointments: ${error.message}`);
  }

  if (assignmentRows.length) {
    const { error } = await supabaseAdmin.from('servicetitan_appointment_assignments').upsert(assignmentRows, {
      onConflict: 'tenant_id,appointment_id,technician_id',
    });
    if (error) throw new Error(`Failed upserting assignments: ${error.message}`);
  }
}

export type TechnicianSkillRow = {
  technician_id: number;
  name: string | null;
  skills: { id?: number; name?: string }[] | null;
};

/**
 * Active technicians whose skill names match all required strings (case-insensitive, per-skill substring).
 */
export async function matchTechniciansBySkills(params: {
  tenantId: number;
  requiredSkills: string[];
}): Promise<TechnicianSkillRow[]> {
  const normalizedRequired = params.requiredSkills
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!normalizedRequired.length) return [];

  const { data, error } = await supabaseAdmin
    .from('servicetitan_technicians')
    .select('technician_id,name,skills')
    .eq('tenant_id', params.tenantId)
    .eq('is_active', true);

  if (error) throw new Error(`Failed loading technicians: ${error.message}`);

  const rows = (data ?? []) as TechnicianSkillRow[];

  return rows.filter((row) => {
    const skillNames = (row.skills ?? [])
      .map((skill) => (skill.name ?? '').toLowerCase())
      .filter(Boolean);
    return normalizedRequired.every((req) =>
      skillNames.some((name) => name.includes(req) || req.includes(name))
    );
  });
}

export async function upsertServiceTitanTechnicians(params: {
  tenantId: number;
  technicians: ServiceTitanTechnicianApiModel[];
}) {
  const now = new Date().toISOString();
  const techRows = params.technicians.map((tech) => ({
    tenant_id: params.tenantId,
    technician_id: tech.id,
    name: tech.name ?? null,
    email: tech.email ?? null,
    phone: tech.phoneNumber ?? null,
    login_name: tech.loginName ?? null,
    skills: tech.skills ?? [],
    permissions: tech.permissions ?? [],
    positions: tech.positions ?? [],
    shift_start: tech.shiftStart ?? null,
    shift_end: tech.shiftEnd ?? null,
    bio: tech.bio ?? null,
    is_active: tech.active ?? true,
    updated_at: now,
  }));

  if (!techRows.length) return;

  const { error } = await supabaseAdmin.from('servicetitan_technicians').upsert(techRows, {
    onConflict: 'tenant_id,technician_id',
  });
  if (error) throw new Error(`Failed upserting technicians: ${error.message}`);
}

export async function upsertServiceTitanJobTypes(params: {
  tenantId: number;
  jobTypes: ServiceTitanJobTypeApiModel[];
}) {
  const normalized: NormalizedJobType[] = [];
  for (const raw of params.jobTypes) {
    try {
      normalized.push(normalizeJobTypeUnknown(raw));
    } catch {
      console.warn('[ServiceTitan] skipped invalid job type row', raw);
    }
  }

  const { data: existing } = await supabaseAdmin
    .from('servicetitan_job_types')
    .select('job_type_id,intent_hints')
    .eq('tenant_id', params.tenantId);

  const hintsById = new Map<number, string[]>();
  for (const row of existing ?? []) {
    hintsById.set(Number(row.job_type_id), (row.intent_hints as string[]) ?? []);
  }

  const now = new Date().toISOString();
  const rows = normalized.map((jt) => ({
    tenant_id: params.tenantId,
    job_type_id: jt.id,
    name: jt.name,
    code: jt.code,
    summary: jt.summary,
    duration_seconds: jt.durationSeconds,
    skills: jt.skills,
    is_active: true,
    intent_hints: hintsById.get(jt.id) ?? [],
    updated_at: now,
  }));

  if (!rows.length) return;

  const { error } = await supabaseAdmin.from('servicetitan_job_types').upsert(rows, {
    onConflict: 'tenant_id,job_type_id',
  });
  if (error) throw new Error(`Failed upserting job types: ${error.message}`);
}

export async function loadJobTypesKnowledgeBase(tenantId: number): Promise<RetellJobTypesKnowledgeBase> {
  const { data, error } = await supabaseAdmin
    .from('servicetitan_job_types')
    .select('job_type_id,name,code,summary,duration_seconds,skills,intent_hints')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .order('name', { ascending: true });

  if (error) throw new Error(`Failed loading job types: ${error.message}`);

  return buildKnowledgeBaseDocument({
    tenantId,
    rows: (data ?? []) as {
      job_type_id: number;
      name: string | null;
      code: string | null;
      summary: string | null;
      duration_seconds: number | null;
      skills: string[];
      intent_hints: string[] | null;
    }[],
  });
}

export async function getCachedDailySchedule(params: {
  tenantId: number;
  startsOnOrAfter: string;
  startsBefore: string;
}): Promise<DailyTechnicianSchedule[]> {
  const { data: appointments, error: appointmentError } = await supabaseAdmin
    .from('servicetitan_appointments')
    .select('appointment_id,start_time,end_time,status')
    .eq('tenant_id', params.tenantId)
    .gte('start_time', params.startsOnOrAfter)
    .lt('start_time', params.startsBefore);
  if (appointmentError) throw new Error(`Failed loading cached appointments: ${appointmentError.message}`);

  if (!appointments?.length) return [];

  const appointmentIds = appointments.map((a) => a.appointment_id);
  const { data: assignments, error: assignmentError } = await supabaseAdmin
    .from('servicetitan_appointment_assignments')
    .select('appointment_id,technician_id')
    .eq('tenant_id', params.tenantId)
    .in('appointment_id', appointmentIds);
  if (assignmentError) throw new Error(`Failed loading cached assignments: ${assignmentError.message}`);

  const technicianIds = [...new Set(assignments?.map((a) => a.technician_id) ?? [])];
  const { data: technicians, error: technicianError } = await supabaseAdmin
    .from('servicetitan_technicians')
    .select('technician_id,name')
    .eq('tenant_id', params.tenantId)
    .in('technician_id', technicianIds);
  if (technicianError) throw new Error(`Failed loading cached technicians: ${technicianError.message}`);

  const appointmentsById = new Map(
    appointments.map((appointment) => [
      appointment.appointment_id,
      {
        appointmentId: appointment.appointment_id,
        start: appointment.start_time,
        end: appointment.end_time,
        status: appointment.status ?? undefined,
      },
    ])
  );
  const technicianNameById = new Map(
    (technicians ?? []).map((technician) => [technician.technician_id, technician.name ?? null])
  );

  const scheduleMap = new Map<string, { technicianName: string; appointments: TechnicianScheduleItem[] }>();
  (assignments ?? []).forEach((assignment) => {
    const appointment = appointmentsById.get(assignment.appointment_id);
    if (!appointment?.start || !appointment?.end) return;
    const techId = String(assignment.technician_id);
    const existing =
      scheduleMap.get(techId) ??
      ({
        technicianName: technicianNameById.get(assignment.technician_id) ?? `Technician ${techId}`,
        appointments: [],
      } as { technicianName: string; appointments: TechnicianScheduleItem[] });
    existing.appointments.push(appointment);
    scheduleMap.set(techId, existing);
  });

  return Array.from(scheduleMap.entries()).map(([technicianId, value]) => ({
    technicianId,
    technicianName: value.technicianName,
    appointments: value.appointments.sort((a: any, b: any) => a.start.localeCompare(b.start)),
  }));
}
