/**
 * JSON body for ServiceTitan JPM `POST .../tenant/{id}/jobs`.
 * Integration examples often use string ids; we normalize to strings.
 */
export type ServiceTitanJobBookInput = {
  customerId: number;
  locationId: number;
  businessUnitId: number;
  jobTypeId: number;
  priority: string;
  campaignId: string;
  startUtc?: string;
  endUtc?: string;
  technicianIds: number[];
  summary?: string | null;
};

export function buildServiceTitanJobsPayload(input: ServiceTitanJobBookInput): Record<string, unknown> {
  let appointments: Record<string, unknown>[] | undefined;
  if (input.startUtc || input.endUtc || input.technicianIds.length > 0) {
    const appointment: Record<string, unknown> = {};
    if (input.startUtc) {
      appointment.start = input.startUtc;
      appointment.arrivalWindowStart = input.startUtc;
    }
    if (input.endUtc) {
      appointment.end = input.endUtc;
      appointment.arrivalWindowEnd = input.endUtc;
    }
    if (input.technicianIds.length > 0) {
      appointment.technicianIds = input.technicianIds.map((id) => String(id));
    }
    appointments = [appointment];
  }

  const payload: Record<string, unknown> = {
    customerId: String(input.customerId),
    locationId: String(input.locationId),
    businessUnitId: String(input.businessUnitId),
    jobTypeId: String(input.jobTypeId),
    priority: input.priority,
    campaignId: input.campaignId,
    summary:
      input.summary != null && String(input.summary).trim() !== ''
        ? String(input.summary).trim()
        : 'Scheduled appointment',
  };
  if (appointments) {
    payload.appointments = appointments;
  }
  return payload;
}
