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
  startUtc: string;
  endUtc: string;
  technicianIds: number[];
  summary?: string | null;
};

export function buildServiceTitanJobsPayload(input: ServiceTitanJobBookInput): Record<string, unknown> {
  const techIds = input.technicianIds.map((id) => String(id));
  return {
    customerId: String(input.customerId),
    locationId: String(input.locationId),
    businessUnitId: String(input.businessUnitId),
    jobTypeId: String(input.jobTypeId),
    priority: input.priority,
    campaignId: input.campaignId,
    appointments: [
      {
        start: input.startUtc,
        end: input.endUtc,
        arrivalWindowStart: input.startUtc,
        arrivalWindowEnd: input.endUtc,
        technicianIds: techIds,
      },
    ],
    summary:
      input.summary != null && String(input.summary).trim() !== ''
        ? String(input.summary).trim()
        : 'Scheduled appointment',
  };
}
