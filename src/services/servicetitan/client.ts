import { env } from '../../config/env.js';
import type {
  DailyTechnicianSchedule,
  TechnicianBusyEvent,
  ServiceTitanAppointmentApiModel,
  ServiceTitanAssignmentApiModel,
  ServiceTitanAuthCredentials,
  ServiceTitanCustomerApiModel,
  ServiceTitanJobTypeApiModel,
  ServiceTitanLocationApiModel,
  ServiceTitanPagedResponse,
  ServiceTitanTechnicianApiModel,
  ServiceTitanEnvironment,
  TechnicianScheduleItem,
} from './types.js';

export class ServiceTitanClient {
  private coerceIsoString(value: unknown): string | null {
    if (typeof value !== 'string' || value.trim() === '') return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  }

  private coerceNumber(value: unknown): number | null {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return null;
    return n;
  }

  private normalizeNonJobAppointmentWindow(
    raw: Record<string, unknown>,
    fallbackDayEndUtc: string
  ): { start: string; end: string } | null {
    const start =
      this.coerceIsoString(raw.start) ??
      this.coerceIsoString(raw.startsOn) ??
      this.coerceIsoString(raw.startTime) ??
      this.coerceIsoString(raw.from) ??
      null;
    if (!start) return null;

    const explicitEnd =
      this.coerceIsoString(raw.end) ??
      this.coerceIsoString(raw.endsOn) ??
      this.coerceIsoString(raw.endTime) ??
      this.coerceIsoString(raw.to) ??
      null;
    if (explicitEnd && explicitEnd > start) {
      return { start, end: explicitEnd };
    }

    const durationMinutes =
      this.coerceNumber(raw.durationMinutes) ??
      this.coerceNumber(raw.durationInMinutes) ??
      this.coerceNumber(raw.durationMins) ??
      this.coerceNumber(raw.duration);
    if (durationMinutes && durationMinutes > 0) {
      const end = new Date(new Date(start).getTime() + durationMinutes * 60_000).toISOString();
      if (end > start) return { start, end };
    }

    // Some non-job payloads omit an end; treat as blocked until UTC day-end of query window.
    return fallbackDayEndUtc > start ? { start, end: fallbackDayEndUtc } : null;
  }

  private readonly authBaseUrl: string;
  private readonly apiBaseUrl: string;
  private accessToken?: string;
  private accessTokenExpiresAt?: number;

  constructor(private readonly credentials: ServiceTitanAuthCredentials) {
    const environment = env.serviceTitanEnv as ServiceTitanEnvironment;
    this.authBaseUrl =
      environment === 'production'
        ? 'https://auth.servicetitan.io'
        : 'https://auth-integration.servicetitan.io';
    this.apiBaseUrl =
      environment === 'production'
        ? 'https://api.servicetitan.io'
        : 'https://api-integration.servicetitan.io';

    console.log('[ServiceTitan] Backend client initialized', {
      environment,
      tenantId: this.credentials.tenantId,
      hasClientId: Boolean(this.credentials.clientId),
      hasClientSecret: Boolean(this.credentials.clientSecret),
      hasAppKey: Boolean(this.credentials.appKey),
    });
  }

  async ensureAccessToken(): Promise<string> {
    if (this.accessToken && this.accessTokenExpiresAt && Date.now() < this.accessTokenExpiresAt) {
      console.log('[ServiceTitan] Reusing cached access token');
      return this.accessToken;
    }

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
    });

    console.log('[ServiceTitan] Requesting new access token');
    const response = await fetch(`${this.authBaseUrl}/connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[ServiceTitan] Auth failed', { status: response.status, errorText });
      throw new Error(`ServiceTitan auth failed: ${response.status} ${errorText}`);
    }

    const payload = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!payload.access_token) {
      throw new Error('ServiceTitan auth response missing access_token');
    }

    this.accessToken = payload.access_token;
    if (payload.expires_in) {
      this.accessTokenExpiresAt = Date.now() + (payload.expires_in - 60) * 1000;
    }
    console.log('[ServiceTitan] Access token refreshed', { expiresInSeconds: payload.expires_in });
    return payload.access_token;
  }

  private async apiRequest<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {}
  ): Promise<T> {
    const token = await this.ensureAccessToken();
    const searchParams = new URLSearchParams();

    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        searchParams.set(key, String(value));
      }
    });

    const url = `${this.apiBaseUrl}${path}${searchParams.toString() ? `?${searchParams.toString()}` : ''}`;
    console.log('[ServiceTitan] API request', { path, query });

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'ST-App-Key': this.credentials.appKey,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[ServiceTitan] API request failed', { path, status: response.status, errorText });
      throw new Error(`ServiceTitan API failed: ${response.status} ${errorText}`);
    }

    return (await response.json()) as T;
  }

  private async apiPost<T>(path: string, body: unknown): Promise<T> {
    const token = await this.ensureAccessToken();
    const url = `${this.apiBaseUrl}${path}`;
    console.log('[ServiceTitan] API POST', { path });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'ST-App-Key': this.credentials.appKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[ServiceTitan] API POST failed', { path, status: response.status, errorText });
      throw new Error(`ServiceTitan API failed: ${response.status} ${errorText}`);
    }

    return (await response.json()) as T;
  }

  /**
   * Book a job with at least one appointment. Payload shape follows JPM v2; required fields depend on tenant settings.
   * @see https://developer.servicetitan.io/docs/api-resources-job-planning/
   */
  async bookJob(body: Record<string, unknown>): Promise<unknown> {
    return this.apiPost(`/jpm/v2/tenant/${this.credentials.tenantId}/jobs`, body);
  }

  async getJobTypesPage(
    page: number,
    pageSize = 250
  ): Promise<ServiceTitanPagedResponse<ServiceTitanJobTypeApiModel>> {
    return this.apiRequest<ServiceTitanPagedResponse<ServiceTitanJobTypeApiModel>>(
      `/jpm/v2/tenant/${this.credentials.tenantId}/job-types`,
      {
        page,
        pageSize,
        includeTotal: true,
        active: true,
      }
    );
  }

  /** All active job types, paginated until `hasMore` is false. JPM requires `page` >= 1. */
  async getAllJobTypes(): Promise<ServiceTitanJobTypeApiModel[]> {
    const pageSize = 250;
    const all: ServiceTitanJobTypeApiModel[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const res = await this.getJobTypesPage(page, pageSize);
      const batch = res.data ?? [];
      all.push(...batch);
      hasMore = Boolean(res.hasMore && batch.length > 0);
      page += 1;
      if (page > 100) {
        console.warn('[ServiceTitan] job-types pagination safety stop at page 100');
        break;
      }
    }

    console.log('[ServiceTitan] Job types fetched', { count: all.length });
    return all;
  }

  async getTechnicians(pageSize = 200): Promise<ServiceTitanTechnicianApiModel[]> {
    const response = await this.apiRequest<ServiceTitanPagedResponse<ServiceTitanTechnicianApiModel>>(
      `/settings/v2/tenant/${this.credentials.tenantId}/technicians`,
      {
        active: true,
        includeTotal: true,
        pageSize,
      }
    );
    const technicians = response.data ?? [];
    // console.log('[ServiceTitan] technicians response', technicians[0]);
    console.log('[ServiceTitan] Technicians fetched', { count: technicians.length });
    return technicians;
  }

  async findCustomers(params: {
    phone?: string;
    name?: string;
    street?: string;
    city?: string;
    state?: string;
    zip?: string;
    country?: string;
    pageSize?: number;
  }): Promise<ServiceTitanCustomerApiModel[]> {
    const response = await this.apiRequest<ServiceTitanPagedResponse<ServiceTitanCustomerApiModel>>(
      `/crm/v2/tenant/${this.credentials.tenantId}/customers`,
      {
        includeTotal: true,
        page: 1,
        pageSize: params.pageSize ?? 200,
        phone: params.phone,
        name: params.name,
        street: params.street,
        city: params.city,
        state: params.state,
        zip: params.zip,
        country: params.country,
      }
    );
    return response.data ?? [];
  }

  async getCustomersPage(
    page: number,
    pageSize = 500
  ): Promise<ServiceTitanPagedResponse<ServiceTitanCustomerApiModel>> {
    return this.apiRequest<ServiceTitanPagedResponse<ServiceTitanCustomerApiModel>>(
      `/crm/v2/tenant/${this.credentials.tenantId}/customers`,
      {
        includeTotal: true,
        active: true,
        page,
        pageSize,
      }
    );
  }

  async getAllCustomers(): Promise<ServiceTitanCustomerApiModel[]> {
    const pageSize = 500;
    const all: ServiceTitanCustomerApiModel[] = [];
    let page = 1;
    let hasMore = true;
    while (hasMore) {
      const res = await this.getCustomersPage(page, pageSize);
      const batch = res.data ?? [];
      all.push(...batch.filter((row) => row.active !== false));
      hasMore = Boolean(res.hasMore && batch.length > 0);
      page += 1;
      if (page > 200) break;
    }
    return all;
  }

  async createCustomer(body: Record<string, unknown>): Promise<ServiceTitanCustomerApiModel> {
    return this.apiPost<ServiceTitanCustomerApiModel>(
      `/crm/v2/tenant/${this.credentials.tenantId}/customers`,
      body
    );
  }

  async findLocations(params: {
    customerId?: number;
    street?: string;
    city?: string;
    state?: string;
    zip?: string;
    country?: string;
    pageSize?: number;
  }): Promise<ServiceTitanLocationApiModel[]> {
    const response = await this.apiRequest<ServiceTitanPagedResponse<ServiceTitanLocationApiModel>>(
      `/crm/v2/tenant/${this.credentials.tenantId}/locations`,
      {
        includeTotal: true,
        page: 1,
        pageSize: params.pageSize ?? 200,
        customerId: params.customerId,
        street: params.street,
        city: params.city,
        state: params.state,
        zip: params.zip,
        country: params.country,
      }
    );
    return response.data ?? [];
  }

  async getLocationsPage(
    page: number,
    pageSize = 500
  ): Promise<ServiceTitanPagedResponse<ServiceTitanLocationApiModel>> {
    return this.apiRequest<ServiceTitanPagedResponse<ServiceTitanLocationApiModel>>(
      `/crm/v2/tenant/${this.credentials.tenantId}/locations`,
      {
        includeTotal: true,
        active: true,
        page,
        pageSize,
      }
    );
  }

  async getAllLocations(): Promise<ServiceTitanLocationApiModel[]> {
    const pageSize = 500;
    const all: ServiceTitanLocationApiModel[] = [];
    let page = 1;
    let hasMore = true;
    while (hasMore) {
      const res = await this.getLocationsPage(page, pageSize);
      const batch = res.data ?? [];
      all.push(...batch.filter((row) => row.active !== false));
      hasMore = Boolean(res.hasMore && batch.length > 0);
      page += 1;
      if (page > 200) break;
    }
    return all;
  }

  async createLocation(body: Record<string, unknown>): Promise<ServiceTitanLocationApiModel> {
    return this.apiPost<ServiceTitanLocationApiModel>(
      `/crm/v2/tenant/${this.credentials.tenantId}/locations`,
      body
    );
  }

  async getAppointmentsForWindow(params: {
    startsOnOrAfter: string;
    startsBefore: string;
    technicianId?: number;
    pageSize?: number;
  }): Promise<ServiceTitanAppointmentApiModel[]> {
    const response = await this.apiRequest<ServiceTitanPagedResponse<ServiceTitanAppointmentApiModel>>(
      `/jpm/v2/tenant/${this.credentials.tenantId}/appointments`,
      {
        active: true,
        startsOnOrAfter: params.startsOnOrAfter,
        startsBefore: params.startsBefore,
        technicianId: params.technicianId,
        pageSize: params.pageSize ?? 500,
      }
    );
    const appointments = response.data ?? [];
    console.log('[ServiceTitan] Appointments fetched', { count: appointments.length });
    return appointments;
  }

  async getNonJobAppointmentsForWindow(params: {
    startsOnOrAfter: string;
    startsOnOrBefore: string;
    technicianId: number;
    pageSize?: number;
  }): Promise<Record<string, unknown>[]> {
    const pageSize = params.pageSize ?? 500;
    const all: Record<string, unknown>[] = [];
    let page = 1;
    let hasMore = true;
    while (hasMore) {
      const response = await this.apiRequest<
        ServiceTitanPagedResponse<Record<string, unknown>>
      >(`/dispatch/v2/tenant/${this.credentials.tenantId}/non-job-appointments`, {
        includeTotal: true,
        activeOnly: true,
        technicianId: params.technicianId,
        startsOnOrAfter: params.startsOnOrAfter,
        startsOnOrBefore: params.startsOnOrBefore,
        page,
        pageSize,
      });
      const batch = response.data ?? [];
      all.push(...batch);
      hasMore = Boolean(response.hasMore && batch.length > 0);
      page += 1;
      if (page > 100) {
        console.warn('[ServiceTitan] non-job appointments pagination safety stop at page 100', {
          technicianId: params.technicianId,
        });
        break;
      }
    }
    console.log('[ServiceTitan] Non-job appointments fetched', {
      technicianId: params.technicianId,
      count: all.length,
    });
    if (all.length > 0) {
      console.log('[ServiceTitan] Non-job appointments details', {
        technicianId: params.technicianId,
        events: all.map((event) => ({
          id: event.id ?? null,
          start: event.start ?? event.startsOn ?? event.startTime ?? null,
          end: event.end ?? event.endsOn ?? event.endTime ?? null,
          status: event.status ?? null,
          durationMinutes:
            event.durationMinutes ?? event.durationInMinutes ?? event.durationMins ?? event.duration ?? null,
        })),
      });
    }
    return all;
  }

  async getAssignmentsByAppointmentIds(appointmentIds: number[]): Promise<ServiceTitanAssignmentApiModel[]> {
    if (!appointmentIds.length) {
      console.log('[ServiceTitan] No appointment IDs provided for assignments');
      return [];
    }

    const response = await this.apiRequest<ServiceTitanPagedResponse<ServiceTitanAssignmentApiModel>>(
      `/dispatch/v2/tenant/${this.credentials.tenantId}/appointment-assignments`,
      {
        includeTotal: true,
        active: true,
        appointmentIds: appointmentIds.join(','),
      }
    );
    const assignments = response.data ?? [];
    console.log('[ServiceTitan] Assignments fetched', { assignmentCount: assignments.length });
    return assignments;
  }

  async getDailyTechnicianSchedule(params: {
    startsOnOrAfter: string;
    startsBefore: string;
    technicianIds?: string[];
  }): Promise<DailyTechnicianSchedule[]> {
    const technicians = await this.getTechnicians();
    const requestedTechnicianIds = new Set((params.technicianIds ?? []).map((id) => String(id)));
    const techniciansForSchedule =
      requestedTechnicianIds.size > 0
        ? technicians.filter((tech) => requestedTechnicianIds.has(String(tech.id)))
        : technicians;
    console.log('[ServiceTitan] Schedule technicians selected', {
      requestedTechnicianIds: Array.from(requestedTechnicianIds),
      selectedTechnicianIds: techniciansForSchedule.map((tech) => String(tech.id)),
      selectedCount: techniciansForSchedule.length,
    });
    const nonJobUtcDay = (() => {
      const source = new Date(params.startsOnOrAfter);
      if (Number.isNaN(source.getTime())) {
        return {
          startsOnOrAfter: params.startsOnOrAfter,
          startsOnOrBefore: params.startsBefore,
        };
      }
      const ymd = source.toISOString().slice(0, 10);
      return {
        startsOnOrAfter: `${ymd}T00:00:00Z`,
        startsOnOrBefore: `${ymd}T23:59:59Z`,
      };
    })();
    const byTechFetch = await Promise.all(
      techniciansForSchedule.map(async (tech) => {
        const [jobAppointments, nonJobAppointments] = await Promise.all([
          this.getAppointmentsForWindow({
            startsOnOrAfter: params.startsOnOrAfter,
            startsBefore: params.startsBefore,
            technicianId: tech.id,
          }),
          this.getNonJobAppointmentsForWindow({
            startsOnOrAfter: nonJobUtcDay.startsOnOrAfter,
            startsOnOrBefore: nonJobUtcDay.startsOnOrBefore,
            technicianId: tech.id,
          }),
        ]);
        return [tech.id, { jobAppointments, nonJobAppointments }] as const;
      })
    );
    const jobsByTechId = new Map<number, ServiceTitanAppointmentApiModel[]>(
      byTechFetch.map(([id, data]) => [id, data.jobAppointments])
    );
    const nonJobByTechId = new Map<number, Record<string, unknown>[]>(
      byTechFetch.map(([id, data]) => [id, data.nonJobAppointments])
    );

    return techniciansForSchedule
      .map((technician) => {
        const techAppointments: TechnicianScheduleItem[] = (jobsByTechId.get(technician.id) ?? [])
          .filter((appointment) => Boolean(appointment.start) && Boolean(appointment.end))
          .map((appointment) => ({
            appointmentId: appointment.id,
            start: appointment.start as string,
            end: appointment.end as string,
            status: appointment.status,
          }));
        const busyFromJobs: TechnicianBusyEvent[] = techAppointments
          .filter((appointment) => Boolean(appointment.start) && Boolean(appointment.end))
          .map((appointment) => ({
            eventId: `job:${appointment.appointmentId}`,
            start: appointment.start,
            end: appointment.end,
            status: appointment.status,
            source: 'job_appointment' as const,
            blocksBooking: true,
            preBufferMinutes: 30,
            postBufferMinutes: 30,
          }));
        const busyFromNonJobs: TechnicianBusyEvent[] = [];
        for (const appointment of nonJobByTechId.get(technician.id) ?? []) {
          const window = this.normalizeNonJobAppointmentWindow(
            appointment,
            nonJobUtcDay.startsOnOrBefore
          );
          if (!window) continue;
          busyFromNonJobs.push({
            eventId: `nonjob:${appointment.id ?? `${technician.id}:${window.start}`}`,
            start: window.start,
            end: window.end,
            status: (appointment.status as string | undefined) ?? undefined,
            source: 'non_job_appointment',
            blocksBooking: true,
            preBufferMinutes: 0,
            postBufferMinutes: 0,
          });
        }
        const busyEvents = [...busyFromJobs, ...busyFromNonJobs].sort((a, b) =>
          a.start.localeCompare(b.start)
        );
        return {
          technicianId: String(technician.id),
          technicianName: technician.name ?? `Technician ${technician.id}`,
          shiftStart: technician.shiftStart,
          shiftEnd: technician.shiftEnd,
          bio: technician.bio,
          positions: technician.positions ?? [],
          skills: technician.skills ?? [],
          busyEvents,
          appointments: techAppointments.sort((a, b) => a.start.localeCompare(b.start)),
        };
      })
      .sort((a, b) => a.technicianName.localeCompare(b.technicianName));
  }
}
