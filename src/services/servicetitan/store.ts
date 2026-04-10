import { supabaseAdmin } from '../../lib/supabase.js';
import { buildKnowledgeBaseDocument } from './job-types-kb.js';
import type { RetellJobTypesKnowledgeBase } from './job-types-kb.js';
import { normalizeJobTypeUnknown } from './job-type-normalize.js';
import type { NormalizedJobType } from './job-type-normalize.js';
import type {
  DailyTechnicianSchedule,
  TechnicianBusyEvent,
  TechnicianScheduleItem,
  ServiceTitanAppointmentApiModel,
  ServiceTitanAssignmentApiModel,
  ServiceTitanCustomerApiModel,
  ServiceTitanJobTypeApiModel,
  ServiceTitanLocationApiModel,
  ServiceTitanTechnicianApiModel,
} from './types.js';

function normalizePhoneForLookup(phone: string | null | undefined): string | null {
  const digits = String(phone ?? '').replace(/\D+/g, '');
  return digits.length ? digits : null;
}


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
export async function getAllActiveTechnicians(params: {
  tenantId: number;
}): Promise<TechnicianSkillRow[]> {
  const { data, error } = await supabaseAdmin
    .from('servicetitan_technicians')
    .select('technician_id,name,skills')
    .eq('tenant_id', params.tenantId)
    .eq('is_active', true);

  if (error) throw new Error(`Failed loading technicians: ${error.message}`);
  return (data ?? []) as TechnicianSkillRow[];
}

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
    priority: jt.priority,
    business_unit_id: jt.businessUnitId,
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

export async function upsertServiceTitanCustomers(params: {
  tenantId: number;
  customers: ServiceTitanCustomerApiModel[];
}) {
  const now = new Date().toISOString();
  const rows = params.customers.map((customer) => {
    const contacts = Array.isArray(customer.contacts) ? customer.contacts : [];
    const phone = contacts
      .map((c) => String(c.value ?? '').trim())
      .find((v) => v.length > 0) ?? null;
    return {
      tenant_id: params.tenantId,
      customer_id: customer.id,
      name: customer.name ?? null,
      phone,
      normalized_phone: normalizePhoneForLookup(phone),
      address_street: customer.address?.street ?? null,
      address_unit: customer.address?.unit ?? null,
      address_city: customer.address?.city ?? null,
      address_state: customer.address?.state ?? null,
      address_zip: customer.address?.zip ?? null,
      address_country: customer.address?.country ?? null,
      raw_contacts: contacts,
      updated_at: now,
    };
  });
  if (!rows.length) return;
  const { error } = await supabaseAdmin.from('servicetitan_customers').upsert(rows, {
    onConflict: 'tenant_id,customer_id',
  });
  if (error) throw new Error(`Failed upserting customers: ${error.message}`);
}

export async function upsertServiceTitanLocations(params: {
  tenantId: number;
  locations: ServiceTitanLocationApiModel[];
}) {
  const now = new Date().toISOString();
  const rows = params.locations.map((location) => ({
    tenant_id: params.tenantId,
    location_id: location.id,
    customer_id: location.customerId ?? null,
    name: location.name ?? null,
    address_street: location.address?.street ?? null,
    address_unit: location.address?.unit ?? null,
    address_city: location.address?.city ?? null,
    address_state: location.address?.state ?? null,
    address_zip: location.address?.zip ?? null,
    address_country: location.address?.country ?? null,
    updated_at: now,
  }));
  if (!rows.length) return;
  const customerIds = [...new Set(rows.map((row) => row.customer_id).filter((v): v is number => v != null))];
  if (customerIds.length) {
    const existingCustomerIds = new Set<number>();
    const chunkSize = 200;
    for (let i = 0; i < customerIds.length; i += chunkSize) {
      const chunk = customerIds.slice(i, i + chunkSize);
      const { data, error } = await supabaseAdmin
        .from('servicetitan_customers')
        .select('customer_id')
        .eq('tenant_id', params.tenantId)
        .in('customer_id', chunk);
      if (error) throw new Error(`Failed validating location customer references: ${error.message}`);
      for (const row of data ?? []) {
        existingCustomerIds.add(Number(row.customer_id));
      }
    }
    for (const row of rows) {
      if (row.customer_id != null && !existingCustomerIds.has(row.customer_id)) {
        row.customer_id = null;
      }
    }
  }
  const { error } = await supabaseAdmin.from('servicetitan_locations').upsert(rows, {
    onConflict: 'tenant_id,location_id',
  });
  if (error) throw new Error(`Failed upserting locations: ${error.message}`);
}

export type CachedCustomerRow = {
  customer_id: number;
  name: string | null;
  phone: string | null;
  normalized_phone: string | null;
  address_street: string | null;
  address_unit: string | null;
  address_city: string | null;
  address_state: string | null;
  address_zip: string | null;
  address_country: string | null;
};

export async function findCachedCustomersByPhone(params: {
  tenantId: number;
  phone: string;
}): Promise<CachedCustomerRow[]> {
  const normalizedPhone = normalizePhoneForLookup(params.phone);
  if (!normalizedPhone) return [];
  const { data, error } = await supabaseAdmin
    .from('servicetitan_customers')
    .select(
      'customer_id,name,phone,normalized_phone,address_street,address_unit,address_city,address_state,address_zip,address_country'
    )
    .eq('tenant_id', params.tenantId)
    .eq('normalized_phone', normalizedPhone)
    .limit(100);
  if (error) throw new Error(`Failed loading cached customers: ${error.message}`);
  return (data ?? []) as CachedCustomerRow[];
}

export type CachedLocationRow = {
  location_id: number;
  customer_id: number | null;
  name: string | null;
  address_street: string | null;
  address_unit: string | null;
  address_city: string | null;
  address_state: string | null;
  address_zip: string | null;
  address_country: string | null;
};

export async function findCachedLocationsByCustomerId(params: {
  tenantId: number;
  customerId: number;
}): Promise<CachedLocationRow[]> {
  const { data, error } = await supabaseAdmin
    .from('servicetitan_locations')
    .select(
      'location_id,customer_id,name,address_street,address_unit,address_city,address_state,address_zip,address_country'
    )
    .eq('tenant_id', params.tenantId)
    .eq('customer_id', params.customerId)
    .limit(200);
  if (error) throw new Error(`Failed loading cached locations: ${error.message}`);
  return (data ?? []) as CachedLocationRow[];
}

export async function loadJobTypesKnowledgeBase(tenantId: number): Promise<RetellJobTypesKnowledgeBase> {
  const { data, error } = await supabaseAdmin
    .from('servicetitan_job_types')
    .select(
      'job_type_id,name,code,summary,duration_seconds,skills,intent_hints,priority,business_unit_id'
    )
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
      skills: unknown[];
      intent_hints: unknown[] | null;
      priority: string | null;
      business_unit_id: number | null;
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

  const scheduleMap = new Map<
    string,
    { technicianName: string; appointments: TechnicianScheduleItem[]; busyEvents: TechnicianBusyEvent[] }
  >();
  (assignments ?? []).forEach((assignment) => {
    const appointment = appointmentsById.get(assignment.appointment_id);
    if (!appointment?.start || !appointment?.end) return;
    const techId = String(assignment.technician_id);
    const existing =
      scheduleMap.get(techId) ??
      ({
        technicianName: technicianNameById.get(assignment.technician_id) ?? `Technician ${techId}`,
        appointments: [],
        busyEvents: [],
      } as {
        technicianName: string;
        appointments: TechnicianScheduleItem[];
        busyEvents: TechnicianBusyEvent[];
      });
    existing.appointments.push(appointment);
    existing.busyEvents.push({
      eventId: `job:${appointment.appointmentId}`,
      start: appointment.start,
      end: appointment.end,
      status: appointment.status,
      source: 'job_appointment',
      blocksBooking: true,
      preBufferMinutes: 30,
      postBufferMinutes: 30,
    });
    scheduleMap.set(techId, existing);
  });

  return Array.from(scheduleMap.entries()).map(([technicianId, value]) => ({
    technicianId,
    technicianName: value.technicianName,
    busyEvents: value.busyEvents.sort((a, b) => a.start.localeCompare(b.start)),
    appointments: value.appointments.sort((a: any, b: any) => a.start.localeCompare(b.start)),
  }));
}
