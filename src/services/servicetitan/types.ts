export type ServiceTitanEnvironment = 'integration' | 'production';

export type ServiceTitanAuthCredentials = {
  tenantId: number;
  clientId: string;
  clientSecret: string;
  appKey: string;
};

export type ServiceTitanPagedResponse<T> = {
  data?: T[];
  hasMore?: boolean;
  page?: number;
  pageSize?: number;
  totalCount?: number;
};

export type ServiceTitanAddress = {
  street?: string | null;
  unit?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string | null;
};

export type ServiceTitanContact = {
  type?: unknown;
  value?: string | null;
  memo?: string | null;
};

export type ServiceTitanCustomerApiModel = {
  id: number;
  active?: boolean;
  name?: string | null;
  address?: ServiceTitanAddress | null;
  contacts?: ServiceTitanContact[] | null;
};

export type ServiceTitanLocationApiModel = {
  id: number;
  active?: boolean;
  customerId?: number;
  name?: string | null;
  address?: ServiceTitanAddress | null;
};

export type ServiceTitanTechnicianApiModel = {
  id: number;
  userId?: number;
  name?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phoneNumber?: string;
  mobilePhone?: string;
  loginName?: string;
  team?: string;
  positions?: string[];
  shiftStart?: string;
  shiftEnd?: string;
  bio?: string;
  skills?: { id: number; name: string }[];
  permissions?: { id: number; value: string }[];
  active?: boolean;
};

export type ServiceTitanAppointmentApiModel = {
  id: number;
  start?: string;
  end?: string;
  arrivalWindowStart?: string;
  arrivalWindowEnd?: string;
  /** Job-type duration in seconds (from the associated job type). */
  duration?: number;
  /**
   * Appointment lifecycle status from ServiceTitan.
   * Common values: "Scheduled", "Dispatched", "Working", "Done", "Canceled", "Hold".
   */
  status?: string;
};

/** Statuses that indicate the appointment is finished or no longer active. */
export const APPOINTMENT_NON_BLOCKING_STATUSES = new Set([
  'Done',
  'Completed',
  'Canceled',
  'Cancelled',
]);

export type ServiceTitanAssignmentApiModel = {
  id?: number;
  appointmentId: number;
  technicianId: number;
};

/**
 * JPM `GET .../job-types` list item (see ServiceTitan API).
 * `skills` is `string[]`; `duration` is seconds; list requests use `page` >= 1.
 */
export type ServiceTitanJobTypeApiModel = Record<string, unknown>;

export type TechnicianScheduleItem = {
  appointmentId: number;
  start: string;
  end: string;
  arrivalWindowStart?: string;
  arrivalWindowEnd?: string;
  duration?: number;
  status?: string;
};

export type TechnicianBusyEventSource = 'job_appointment' | 'non_job_appointment';

export type TechnicianBusyEvent = {
  eventId: string;
  start: string;
  end: string;
  status?: string;
  source: TechnicianBusyEventSource;
  blocksBooking: boolean;
  preBufferMinutes: number;
  postBufferMinutes: number;
};

export type DailyTechnicianSchedule = {
  technicianId: string;
  technicianName: string;
  email?: string;
  phoneNumber?: string;
  shiftStart?: string;
  shiftEnd?: string;
  bio?: string;
  positions?: string[];
  skills?: { id: number; name: string }[];
  /** Normalized busy windows from job + non-job appointment sources. */
  busyEvents: TechnicianBusyEvent[];
  /** Legacy fallback retained for compatibility with cached schedule readers. */
  appointments: TechnicianScheduleItem[];
};

export type AvailabilitySlot = {
  start: string;
  end: string;
};

export type TechnicianAvailability = {
  technicianId: string;
  technicianName: string;
  bio?: string;
  positions?: string[];
  skills?: { id: number; name: string }[];
  slots: AvailabilitySlot[];
};
