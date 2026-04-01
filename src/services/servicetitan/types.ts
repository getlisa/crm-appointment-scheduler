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
  status?: string;
};

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
  status?: string;
};

export type DailyTechnicianSchedule = {
  technicianId: string;
  technicianName: string;
  shiftStart?: string;
  shiftEnd?: string;
  bio?: string;
  positions?: string[];
  skills?: { id: number; name: string }[];
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
