import { Router } from 'express';
import { z } from 'zod';
import { ServiceTitanClient } from '../services/servicetitan/client.js';
import { computeDailyAvailability } from '../services/servicetitan/availability.js';
import {
  aggregateShiftWindowFromTechnicians,
  getUtcDayWindow,
  localWallClockToUtcIso,
  resolveNoDateSearchAnchorYmd,
} from '../services/servicetitan/date-window.js';
import { env } from '../config/env.js';
import { loadTenantCredentials, saveTenantCredentials } from '../services/servicetitan/credentials.js';
import { buildServiceTitanJobsPayload } from '../services/servicetitan/job-book-payload.js';
import { computeAgentAvailabilityCheck, computeAgentDaySlotsMode } from '../services/servicetitan/agent-check.js';
import { resolveJobTypeFromReason, type RetellJobTypeKbRow } from '../services/servicetitan/job-types-kb.js';
import {
  findCachedCustomersByPhone,
  findCachedLocationsByCustomerId,
  loadJobTypesKnowledgeBase,
  matchTechniciansBySkills,
  upsertServiceTitanCustomers,
  upsertServiceTitanJobTypes,
  upsertServiceTitanLocations,
  upsertServiceTitanTechnicians,
} from '../services/servicetitan/store.js';
import type {
  DailyTechnicianSchedule,
  ServiceTitanCustomerApiModel,
  ServiceTitanLocationApiModel,
} from '../services/servicetitan/types.js';

/** Retell / custom function runners often send fields under `body.arguments`; otherwise use root. */
function normalizedRequestPayload(req: { body?: unknown }): unknown {
  const body = req.body as { arguments?: unknown } | undefined;
  return body?.arguments ?? body ?? {};
}

/** Vercel/patched `console` can crash in `util.inspect` when formatting some throws (e.g. `ZodError`). */
function logRouteException(context: string, error: unknown): void {
  if (error instanceof z.ZodError) {
    console.error(context, JSON.stringify(error.flatten()));
    return;
  }
  if (error instanceof Error) {
    console.error(context, error.message);
    if (error.stack) console.error(error.stack);
    return;
  }
  try {
    console.error(context, JSON.stringify(error));
  } catch {
    console.error(context, String(error));
  }
}

const tenantIdField = z.preprocess(
  (value) => {
    if (value == null || value === '') return undefined;
    if (typeof value === 'string') return Number(value);
    return value;
  },
  z
    .number({ required_error: 'tenantId is required' })
    .int('tenantId must be an integer')
    .positive('tenantId must be a positive integer')
);

const connectBodySchema = z.object({
  tenantId: z.number().int().positive(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  appKey: z.string().min(1),
  timezone: z.string().min(1),
});

const syncQuerySchema = z.object({
  tenantId: tenantIdField,
  includeCrm: z.coerce.boolean().optional().default(true),
});

const scheduleQuerySchema = z.object({
  tenantId: tenantIdField,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const availabilityQuerySchema = z.object({
  tenantId: tenantIdField,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  duration: z.coerce.number().int().positive(),
});

const jobTypesKnowledgeBaseQuerySchema = z.object({
  tenantId: tenantIdField,
});

const matchTechniciansBodySchema = z.object({
  tenantId: tenantIdField,
  skills: z.array(z.string().min(1)).min(1),
});

const resolveJobTypeBodySchema = z.object({
  tenantId: tenantIdField,
  reason: z.string().min(1),
  topN: z.preprocess(
    (v) => (v === null ? undefined : v),
    z.coerce.number().int().min(1).max(10).optional().default(3)
  ),
});

const checkAvailabilityBodySchema = z
  .object({
    tenantId: tenantIdField,
    date: z.preprocess(
      (v) => (v === null ? undefined : v),
      z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
    ),
    technicianIds: z.array(z.string().min(1)).min(1),
    startTime: z.preprocess(
      (v) => (v === null ? undefined : v),
      z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional()
    ),
    endTime: z.preprocess(
      (v) => (v === null ? undefined : v),
      z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional()
    ),
    duration: z.preprocess(
      (v) => (v === null ? undefined : v),
      z.coerce.number().int().positive().default(60)
    ),
    /**
     * Cap on how many windows to return per technician after full expansion (0 = all, up to 2000).
     */
    slotPreviewLimit: z.preprocess(
      (v) => (v === null ? undefined : v),
      z.coerce.number().int().min(0).max(2000).optional().default(0)
    ),
  })
  .superRefine((b, ctx) => {
    if (b.startTime && !b.date) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['date'],
        message: 'date is required when startTime is provided',
      });
    }
    if (b.startTime) {
      if (b.endTime == null && b.duration == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['duration'],
          message: 'Provide endTime or duration when startTime is set',
        });
      }
    } else if (b.duration == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['duration'],
        message: 'duration is required when startTime is omitted',
      });
    }
  });

/** Same scheduling modes as check-availability, but resolves job type + technicians from `reason`. */
const checkAvailabilityByReasonBodySchema = z
  .object({
    tenantId: tenantIdField,
    reason: z.string().min(1),
    topN: z.preprocess(
      (v) => (v === null ? undefined : v),
      z.coerce.number().int().min(1).max(10).optional().default(3)
    ),
    date: z.preprocess(
      (v) => (v === null ? undefined : v),
      z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
    ),
    startTime: z.preprocess(
      (v) => (v === null ? undefined : v),
      z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional()
    ),
    /** Alias for `startTime` (e.g. Retell-friendly). */
    time: z.preprocess(
      (v) => (v === null ? undefined : v),
      z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional()
    ),
    endTime: z.preprocess(
      (v) => (v === null ? undefined : v),
      z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional()
    ),
    /** Overrides duration from the matched job type (and the default 60 minutes). */
    duration: z.preprocess(
      (v) => (v === null ? undefined : v),
      z.coerce.number().int().positive().optional()
    ),
    slotPreviewLimit: z.preprocess(
      (v) => (v === null ? undefined : v),
      z.coerce.number().int().min(0).max(2000).optional().default(0)
    ),
  })
  .superRefine((b, ctx) => {
    if (b.startTime != null && b.time != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['time'],
        message: 'Provide only one of startTime or time',
      });
    }
    const wall = b.startTime ?? b.time;
    if (wall != null && !b.date) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['date'],
        message: 'date is required when startTime or time is set',
      });
    }
  });

const customerAddressSchema = z.object({
  street: z.string().min(1),
  unit: z.preprocess((v) => (v === null ? undefined : v), z.string().optional()),
  city: z.string().min(1),
  state: z.string().min(1),
  zip: z.string().min(1),
  country: z.string().min(1),
});

const resolveCustomerLocationBodySchema = z
  .object({
    tenantId: tenantIdField,
    customerId: z.preprocess(
      (v) => (v === null ? undefined : v),
      z.number().int().positive().optional()
    ),
    locationId: z.preprocess(
      (v) => (v === null ? undefined : v),
      z.number().int().positive().optional()
    ),
    customerName: z.preprocess((v) => (v === null ? undefined : v), z.string().min(1).optional()),
    phone: z.preprocess((v) => (v === null ? undefined : v), z.string().min(1).optional()),
    address: z.preprocess((v) => (v === null ? undefined : v), customerAddressSchema.optional()),
  })
  .superRefine((b, ctx) => {
    const hasIds = b.customerId != null && b.locationId != null;
    const hasCustomerContext = b.customerName && b.phone && b.address;
    if (!hasIds && !hasCustomerContext) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['customerId'],
        message:
          'Provide customerId + locationId, or provide customerName + phone + address to resolve/create them',
      });
    }
  });

const bookAppointmentBodySchema = z
  .object({
    tenantId: tenantIdField,
    customerId: z.preprocess(
      (v) => (v === null ? undefined : v),
      z.number().int().positive().optional()
    ),
    locationId: z.preprocess(
      (v) => (v === null ? undefined : v),
      z.number().int().positive().optional()
    ),
    customerName: z.preprocess((v) => (v === null ? undefined : v), z.string().min(1).optional()),
    phone: z.preprocess((v) => (v === null ? undefined : v), z.string().min(1).optional()),
    address: z.preprocess((v) => (v === null ? undefined : v), customerAddressSchema.optional()),
    businessUnitId: z.number().int().positive(),
    jobTypeId: z.number().int().positive(),
    priority: z.string().min(1),
    summary: z.preprocess((v) => (v === null ? undefined : v), z.string().optional()),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    startTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
    endTime: z.preprocess(
      (v) => (v === null ? undefined : v),
      z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional()
    ),
    duration: z.preprocess(
      (v) => (v === null ? undefined : v),
      z.coerce.number().int().positive().optional().default(60)
    ),
    technicianId: z.number().int().positive(),
  })
  .superRefine((b, ctx) => {
    const hasIds = b.customerId != null && b.locationId != null;
    const hasCustomerContext = b.customerName && b.phone && b.address;
    if (!hasIds && !hasCustomerContext) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['customerId'],
        message:
          'Provide customerId + locationId, or provide customerName + phone + address to resolve/create them',
      });
    }
  })
  .refine((b) => b.endTime != null || b.duration != null, {
    message: 'Provide endTime or duration',
  });

function skillListForJobTypeRow(row: RetellJobTypeKbRow): string[] {
  const raw = row.skillNames.length > 0 ? row.skillNames : row.skills;
  return raw.map((s) => String(s).trim()).filter(Boolean);
}

/**
 * Returns up to `topN` skills aligned with ranked job-type matches: first takes one skill per
 * match in rank order, then fills remaining slots from additional skills on those same rows
 * (rank order, then position within each row) so default topN=3 yields three skills when available.
 */
function skillsAlignedWithTopNMatches(
  matches: { row: RetellJobTypeKbRow }[],
  topN: number
): string[] {
  const want = topN;
  if (want <= 0 || matches.length === 0) return [];

  const lists = matches.map((m) => skillListForJobTypeRow(m.row));
  const out: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < Math.min(lists.length, want); i++) {
    const first = lists[i][0];
    if (first && !seen.has(first)) {
      seen.add(first);
      out.push(first);
    }
  }

  for (let idx = 1; out.length < want; idx++) {
    let added = false;
    for (let i = 0; i < lists.length && out.length < want; i++) {
      const s = lists[i][idx];
      if (s && !seen.has(s)) {
        seen.add(s);
        out.push(s);
        added = true;
      }
    }
    if (!added) break;
  }

  return out;
}

type TechnicianMatchRow = {
  technicianId: string;
  name: string;
  matchedSkills: string[];
  usedFallback?: true;
};

async function technicianMatchesForSkills(
  tenantId: number,
  skills: string[]
): Promise<TechnicianMatchRow[]> {
  const rows = await matchTechniciansBySkills({ tenantId, requiredSkills: skills });
  const normReq = skills.map((s) => s.trim().toLowerCase()).filter(Boolean);
  const data: TechnicianMatchRow[] = rows.map((r) => {
    const skillList = (r.skills ?? []) as { id?: number; name?: string }[];
    const matchedNames = skillList
      .map((s) => s.name)
      .filter(Boolean)
      .filter((name) => {
        const n = String(name).toLowerCase();
        return normReq.some((req) => n.includes(req) || req.includes(n));
      }) as string[];

    return {
      technicianId: String(r.technician_id),
      name: r.name ?? `Technician ${r.technician_id}`,
      matchedSkills: matchedNames,
    };
  });

  if (data.length === 0 && env.serviceTitanFallbackTechnicianId != null) {
    const id = env.serviceTitanFallbackTechnicianId;
    console.warn(
      '[ServiceTitan] technician match: no skill matches, using SERVICETITAN_FALLBACK_TECHNICIAN_ID',
      { id }
    );
    data.push({
      technicianId: String(id),
      name: `Technician ${id}`,
      matchedSkills: [],
      usedFallback: true as const,
    });
  }

  return data;
}

function normalizeAddressPart(value: string | null | undefined): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function isSameAddress(
  left: { street?: string | null; unit?: string | null; city?: string | null; state?: string | null; zip?: string | null; country?: string | null },
  right: { street?: string | null; unit?: string | null; city?: string | null; state?: string | null; zip?: string | null; country?: string | null }
): boolean {
  return (
    normalizeAddressPart(left.street) === normalizeAddressPart(right.street) &&
    normalizeAddressPart(left.unit) === normalizeAddressPart(right.unit) &&
    normalizeAddressPart(left.city) === normalizeAddressPart(right.city) &&
    normalizeAddressPart(left.state) === normalizeAddressPart(right.state) &&
    normalizeAddressPart(left.zip) === normalizeAddressPart(right.zip) &&
    normalizeAddressPart(left.country) === normalizeAddressPart(right.country)
  );
}

async function resolveCustomerAndLocationIds(params: {
  client: ServiceTitanClient;
  tenantId: number;
  customerId?: number;
  locationId?: number;
  customerName?: string;
  phone?: string;
  address?: {
    street: string;
    unit?: string;
    city: string;
    state: string;
    zip: string;
    country: string;
  };
}): Promise<{ customerId: number; locationId: number; customerCreated: boolean; locationCreated: boolean }> {
  if (params.customerId != null && params.locationId != null) {
    return {
      customerId: params.customerId,
      locationId: params.locationId,
      customerCreated: false,
      locationCreated: false,
    };
  }

  if (!params.customerName || !params.phone || !params.address) {
    throw new Error(
      'Missing customer context. Provide customerId + locationId, or customerName + phone + address.'
    );
  }

  const addr = params.address;
  let customerCreated = false;
  let locationCreated = false;
  const cachedCustomers = await findCachedCustomersByPhone({
    tenantId: params.tenantId,
    phone: params.phone,
  });

  let customer: ServiceTitanCustomerApiModel | null =
    cachedCustomers
      .map((c) => ({
        id: c.customer_id,
        name: c.name,
        address: {
          street: c.address_street,
          unit: c.address_unit,
          city: c.address_city,
          state: c.address_state,
          zip: c.address_zip,
          country: c.address_country,
        },
      }))
      .find((c) => (c.address ? isSameAddress(c.address, addr) : false)) ?? null;

  if (!customer) {
    const matchedCustomers = await params.client.findCustomers({
      phone: params.phone,
      street: addr.street,
      city: addr.city,
      state: addr.state,
      zip: addr.zip,
      country: addr.country,
    });
    if (matchedCustomers.length) {
      await upsertServiceTitanCustomers({
        tenantId: params.tenantId,
        customers: matchedCustomers,
      });
    }
    customer =
      matchedCustomers.find((c) => (c.address ? isSameAddress(c.address, addr) : false)) ??
      matchedCustomers[0] ??
      null;
  }

  if (!customer) {
    customer = await params.client.createCustomer({
      name: params.customerName,
      address: addr,
      locations: [
        {
          name: params.customerName,
          address: addr,
        },
      ],
    });
    customerCreated = true;
    await upsertServiceTitanCustomers({
      tenantId: params.tenantId,
      customers: [customer],
    });
  }

  const resolvedCustomerId = Number(customer.id);
  if (!Number.isFinite(resolvedCustomerId) || resolvedCustomerId <= 0) {
    throw new Error('Failed to resolve a valid customerId for booking');
  }

  let resolvedLocationId = params.locationId;
  if (resolvedLocationId == null) {
    const cachedLocations = await findCachedLocationsByCustomerId({
      tenantId: params.tenantId,
      customerId: resolvedCustomerId,
    });
    let matchedLocation: ServiceTitanLocationApiModel | null =
      cachedLocations
        .map((l) => ({
          id: l.location_id,
          customerId: l.customer_id ?? undefined,
          name: l.name,
          address: {
            street: l.address_street,
            unit: l.address_unit,
            city: l.address_city,
            state: l.address_state,
            zip: l.address_zip,
            country: l.address_country,
          },
        }))
        .find((l) => (l.address ? isSameAddress(l.address, addr) : false)) ?? null;

    if (!matchedLocation) {
      const locations = await params.client.findLocations({
        customerId: resolvedCustomerId,
        street: addr.street,
        city: addr.city,
        state: addr.state,
        zip: addr.zip,
        country: addr.country,
      });
      if (locations.length) {
        await upsertServiceTitanLocations({
          tenantId: params.tenantId,
          locations,
        });
      }
      matchedLocation =
        locations.find((l) => (l.address ? isSameAddress(l.address, addr) : false)) ??
        locations[0] ??
        null;
    }

    if (!matchedLocation) {
      matchedLocation = await params.client.createLocation({
        customerId: resolvedCustomerId,
        name: params.customerName,
        address: addr,
      });
      locationCreated = true;
      await upsertServiceTitanLocations({
        tenantId: params.tenantId,
        locations: [matchedLocation],
      });
    }

    const numericLocationId = Number(matchedLocation.id);
    if (!Number.isFinite(numericLocationId) || numericLocationId <= 0) {
      throw new Error('Failed to resolve a valid locationId for booking');
    }
    resolvedLocationId = numericLocationId;
  }

  return {
    customerId: resolvedCustomerId,
    locationId: resolvedLocationId,
    customerCreated,
    locationCreated,
  };
}

export type ResolveCustomerLocationStatus =
  | 'ids_provided'
  | 'matched_existing'
  | 'customer_matched_location_created'
  | 'customer_created_location_matched'
  | 'customer_and_location_created';

function deriveResolveCustomerLocationStatus(params: {
  idsProvided: boolean;
  customerCreated: boolean;
  locationCreated: boolean;
}): ResolveCustomerLocationStatus {
  if (params.idsProvided) return 'ids_provided';
  if (params.customerCreated && params.locationCreated) return 'customer_and_location_created';
  if (params.customerCreated && !params.locationCreated) return 'customer_created_location_matched';
  if (!params.customerCreated && params.locationCreated) return 'customer_matched_location_created';
  return 'matched_existing';
}

function normalizeTimeComponent(t: string): string {
  return t.length === 5 ? `${t}:00` : t;
}

function toClientTime(utcIso: string, timeZone: string): string {
  const date = new Date(utcIso);
  if (Number.isNaN(date.getTime())) return utcIso;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}`;
}

export const serviceTitanRouter = Router();

serviceTitanRouter.post('/connect', async (req, res) => {
  try {
    const body = connectBodySchema.parse(req.body);
    const client = new ServiceTitanClient({
      tenantId: body.tenantId,
      clientId: body.clientId,
      clientSecret: body.clientSecret,
      appKey: body.appKey,
    });

    await client.ensureAccessToken();
    await saveTenantCredentials(body);

    return res.json({ success: true, message: 'ServiceTitan connected successfully' });
  } catch (error) {
    logRouteException('[ServiceTitan] connect failed', error);
    return res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

serviceTitanRouter.post('/sync', async (req, res) => {
  try {
    const query = syncQuerySchema.parse(req.query);
    const { credentials } = await loadTenantCredentials(query.tenantId);
    const client = new ServiceTitanClient(credentials);
    const [technicians, jobTypes, customers, locations] = await Promise.all([
      client.getTechnicians(),
      client.getAllJobTypes(),
      query.includeCrm ? client.getAllCustomers() : Promise.resolve([]),
      query.includeCrm ? client.getAllLocations() : Promise.resolve([]),
    ]);

    await upsertServiceTitanTechnicians({
      tenantId: credentials.tenantId,
      technicians,
    });
    await upsertServiceTitanJobTypes({
      tenantId: credentials.tenantId,
      jobTypes,
    });
    if (query.includeCrm) {
      await upsertServiceTitanCustomers({
        tenantId: credentials.tenantId,
        customers,
      });
      await upsertServiceTitanLocations({
        tenantId: credentials.tenantId,
        locations,
      });
    }
    console.log('[ServiceTitan] sync completed', {
      technicians: technicians.length,
      jobTypes: jobTypes.length,
    });
    return res.json({
      success: true,
      counts: {
        technicians: technicians.length,
        jobTypes: jobTypes.length,
        customers: customers.length,
        locations: locations.length,
      },
    });
  } catch (error) {
    logRouteException('[ServiceTitan] sync failed', error);
    return res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

serviceTitanRouter.post('/agent/match-technicians', async (req, res) => {
  try {
    const body = matchTechniciansBodySchema.parse(req.body);
    const { credentials } = await loadTenantCredentials(body.tenantId);
    const data = await technicianMatchesForSkills(credentials.tenantId, body.skills);

    return res.json({ success: true, data });
  } catch (error) {
    logRouteException('[ServiceTitan] agent match-technicians failed', error);
    return res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

serviceTitanRouter.get('/job-types/knowledge-base', async (req, res) => {
  try {
    const query = jobTypesKnowledgeBaseQuerySchema.parse(req.query);
    const data = await loadJobTypesKnowledgeBase(query.tenantId);
    return res.json({ success: true, data });
  } catch (error) {
    logRouteException('[ServiceTitan] job-types knowledge-base failed', error);
    return res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

serviceTitanRouter.post('/agent/resolve-job-type', async (req, res) => {
  try {
    const body = resolveJobTypeBodySchema.parse(req.body);
    const kb = await loadJobTypesKnowledgeBase(body.tenantId);
    const { matches } = resolveJobTypeFromReason(body.reason, kb, body.topN);
    const top = matches[0];
    const skills = skillsAlignedWithTopNMatches(matches, body.topN);
    const duration = top?.row.durationMinutes ?? null;
    const priority = top?.row.priority ?? null;
    const businessId = top?.row.businessUnitId ?? null;
    const jobTypeId = top != null ? top.jobTypeId : null;

    return res.json({
      success: true,
      data: {
        skills,
        duration,
        priority,
        businessId,
        jobTypeId,
      },
    });
  } catch (error) {
    logRouteException('[ServiceTitan] agent resolve-job-type failed', error);
    return res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

function schedulesForTechnicianIds(schedule: DailyTechnicianSchedule[], technicianIds: string[]) {
  const byId = new Map(schedule.map((s) => [s.technicianId, s]));
  return technicianIds.map(
    (id) =>
      byId.get(id) ?? {
        technicianId: id,
        technicianName: `Technician ${id}`,
        appointments: [],
      }
  );
}

type ParsedCheckAvailability = z.infer<typeof checkAvailabilityBodySchema>;

type AgentCheckAvailabilityCoreResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; status: number; error: string };

/** Public shape for `check-availability-by-reason`: scheduling fields + jobTypeId / priority / businessId only (see `desired_output.json`). */
function buildCheckAvailabilityByReasonData(
  coreData: Record<string, unknown>,
  bookCtx: { jobTypeId: number; priority: string | null; businessId: number | null }
): Record<string, unknown> {
  const booking = {
    jobTypeId: bookCtx.jobTypeId,
    priority: bookCtx.priority,
    businessId: bookCtx.businessId,
  };
  const mode = coreData.mode;
  if (mode === 'earliest_in_range') {
    return {
      mode: coreData.mode,
      timeZone: coreData.timeZone,
      durationMinutes: coreData.durationMinutes,
      ...booking,
      searchAnchorStrategy: coreData.searchAnchorStrategy,
      searchDate: coreData.searchDate,
      requestedWindow: coreData.requestedWindow ?? null,
      technicians: coreData.technicians,
      globalEarliestSlot: coreData.globalEarliestSlot,
    };
  }
  if (mode === 'day_slots') {
    return {
      mode: coreData.mode,
      date: coreData.date,
      timeZone: coreData.timeZone,
      durationMinutes: coreData.durationMinutes,
      ...booking,
      requestedWindow: coreData.requestedWindow ?? null,
      technicians: coreData.technicians,
      globalEarliestSlot: coreData.globalEarliestSlot,
    };
  }
  if (mode === 'specific_window') {
    return {
      mode: coreData.mode,
      date: coreData.date,
      timeZone: coreData.timeZone,
      durationMinutes: coreData.durationMinutes,
      ...booking,
      requestedWindow: coreData.requestedWindow,
      technicians: coreData.technicians,
      globalEarliestAlternative: coreData.globalEarliestAlternative,
    };
  }
  return { ...coreData, ...booking };
}

async function runAgentCheckAvailabilityCore(
  body: ParsedCheckAvailability
): Promise<AgentCheckAvailabilityCoreResult> {
  const { credentials, timezone: tenantTimezone } = await loadTenantCredentials(body.tenantId);
  const client = new ServiceTitanClient(credentials);
  const timeZone = tenantTimezone ?? 'UTC';

  const localizeWin = (alt: { start: string; end: string } | null | undefined) =>
    alt
      ? {
          start: toClientTime(alt.start, timeZone),
          end: toClientTime(alt.end, timeZone),
        }
      : null;

  // 1) Specific date + time: verify window; suggest alternatives if it does not fit.
  if (body.date && body.startTime) {
    const window = getUtcDayWindow(body.date, timeZone);

    const startUtc = localWallClockToUtcIso(body.date, normalizeTimeComponent(body.startTime), timeZone);
    if (!startUtc) {
      return { ok: false, status: 400, error: 'Invalid startTime or date' };
    }

    let endUtc: string;
    if (body.endTime) {
      const parsed = localWallClockToUtcIso(body.date, normalizeTimeComponent(body.endTime), timeZone);
      if (!parsed) {
        return { ok: false, status: 400, error: 'Invalid endTime or date' };
      }
      endUtc = parsed;
    } else {
      const dm = body.duration;
      if (dm == null) {
        return {
          ok: false,
          status: 400,
          error: 'durationMinutes required when endTime is omitted',
        };
      }
      endUtc = new Date(new Date(startUtc).getTime() + dm * 60_000).toISOString();
    }

    if (endUtc <= startUtc) {
      return { ok: false, status: 400, error: 'End must be after start' };
    }

    const resolvedDurationMinutes = Math.max(
      1,
      body.duration ??
        Math.round((new Date(endUtc).getTime() - new Date(startUtc).getTime()) / 60_000)
    );

    const schedule = await client.getDailyTechnicianSchedule(window);
    const schedulesForCheck = schedulesForTechnicianIds(schedule, body.technicianIds);

    const check = computeAgentAvailabilityCheck({
      schedules: schedulesForCheck,
      date: body.date,
      timeZone,
      shiftStartIso: window.startsOnOrAfter,
      shiftEndIso: window.startsBefore,
      requestStartUtc: startUtc,
      requestEndUtc: endUtc,
    });

    const globalRaw = check.globalEarliestAlternativeUtc;

    return {
      ok: true,
      data: {
        mode: 'specific_window' as const,
        date: body.date,
        timeZone,
        durationMinutes: resolvedDurationMinutes,
        requestedWindow: {
          start: toClientTime(startUtc, timeZone),
          end: toClientTime(endUtc, timeZone),
        },
        technicians: check.technicians.map((t) => ({
          technicianId: t.technicianId,
          technicianName: t.technicianName,
          fitsRequest: t.fitsRequest,
          ...(t.doesNotFitReason ? { doesNotFitReason: t.doesNotFitReason } : {}),
          earliestAlternative: localizeWin(t.earliestAlternativeUtc ?? null),
        })),
        globalEarliestAlternative:
          globalRaw && localizeWin(globalRaw)
            ? { technicianId: globalRaw.technicianId, ...localizeWin(globalRaw)! }
            : null,
      },
    };
  }

  // 2) Date only: openings that day (earliest + preview list per tech).
  if (body.date && !body.startTime) {
    const window = getUtcDayWindow(body.date, timeZone);
    const schedule = await client.getDailyTechnicianSchedule(window);
    const schedulesForCheck = schedulesForTechnicianIds(schedule, body.technicianIds);

    const day = computeAgentDaySlotsMode({
      schedules: schedulesForCheck,
      date: body.date,
      timeZone,
      shiftStartIso: window.startsOnOrAfter,
      shiftEndIso: window.startsBefore,
      durationMinutes: body.duration,
      slotPreviewLimit: body.slotPreviewLimit,
    });

    const globalRaw = day.globalEarliestUtc;

    return {
      ok: true,
      data: {
        mode: 'day_slots' as const,
        date: body.date,
        timeZone,
        durationMinutes: body.duration,
        requestedWindow: null,
        technicians: day.technicians.map((t) => ({
          technicianId: t.technicianId,
          technicianName: t.technicianName,
          hasAvailability: t.hasAvailability,
          earliestSlot: localizeWin(t.earliestSlotUtc),
          slotsPreview: t.slotsPreviewUtc.map((w) => localizeWin(w)!),
        })),
        globalEarliestSlot:
          globalRaw && localizeWin(globalRaw)
            ? { technicianId: globalRaw.technicianId, ...localizeWin(globalRaw)! }
            : null,
      },
    };
  }

  // 3) No date: one schedule fetch only. Anchor = today if local now is inside aggregate shift
  // hours for requested technicians; otherwise tomorrow.
  const allTechnicians = await client.getTechnicians();
  const idSet = new Set(body.technicianIds);
  const techsForAnchor = allTechnicians.filter((t) => idSet.has(String(t.id)));
  const aggregateShift = aggregateShiftWindowFromTechnicians(techsForAnchor);
  const { anchor: searchDate, strategy: searchAnchorStrategy } = resolveNoDateSearchAnchorYmd(
    timeZone,
    aggregateShift
  );

  const window = getUtcDayWindow(searchDate, timeZone);
  const schedule = await client.getDailyTechnicianSchedule(window);
  const technicianNameById = new Map(schedule.map((s) => [s.technicianId, s.technicianName]));
  const schedulesForCheck = schedulesForTechnicianIds(schedule, body.technicianIds);

  const day = computeAgentDaySlotsMode({
    schedules: schedulesForCheck,
    date: searchDate,
    timeZone,
    shiftStartIso: window.startsOnOrAfter,
    shiftEndIso: window.startsBefore,
    durationMinutes: body.duration,
    slotPreviewLimit: body.slotPreviewLimit,
  });

  const dayById = new Map(day.technicians.map((t) => [t.technicianId, t]));

  let bestGlobal: { technicianId: string; date: string; startUtc: string; endUtc: string } | null =
    null;
  let bestStartMs = Infinity;
  for (const t of day.technicians) {
    if (!t.earliestSlotUtc) continue;
    const slotStartMs = new Date(t.earliestSlotUtc.start).getTime();
    if (slotStartMs < bestStartMs) {
      bestStartMs = slotStartMs;
      bestGlobal = {
        technicianId: t.technicianId,
        date: searchDate,
        startUtc: t.earliestSlotUtc.start,
        endUtc: t.earliestSlotUtc.end,
      };
    }
  }

  return {
    ok: true,
    data: {
      mode: 'earliest_in_range' as const,
      timeZone,
      durationMinutes: body.duration,
      searchAnchorStrategy,
      searchDate,
      requestedWindow: null,
      technicians: body.technicianIds.map((id) => {
        const name = technicianNameById.get(id) ?? `Technician ${id}`;
        const row = dayById.get(id);
        const slot = row?.earliestSlotUtc;
        return {
          technicianId: id,
          technicianName: name,
          hasAvailability: Boolean(slot),
          earliestSlot: slot
            ? {
                date: searchDate,
                start: toClientTime(slot.start, timeZone),
                end: toClientTime(slot.end, timeZone),
              }
            : null,
          slotsPreview: (row?.slotsPreviewUtc ?? []).map((w) => localizeWin(w)!),
        };
      }),
      globalEarliestSlot: bestGlobal
        ? {
            technicianId: bestGlobal.technicianId,
            date: bestGlobal.date,
            start: toClientTime(bestGlobal.startUtc, timeZone),
            end: toClientTime(bestGlobal.endUtc, timeZone),
          }
        : null,
    },
  };
}

serviceTitanRouter.post('/agent/check-availability', async (req, res) => {
  try {
    const body = checkAvailabilityBodySchema.parse(req.body);
    const result = await runAgentCheckAvailabilityCore(body);
    if (!result.ok) {
      return res.status(result.status).json({ success: false, error: result.error });
    }
    return res.json({ success: true, data: result.data });
  } catch (error) {
    logRouteException('[ServiceTitan] agent check-availability failed', error);
    return res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

serviceTitanRouter.post('/agent/check-availability-by-reason', async (req, res) => {
  try {
    const requestPayload = normalizedRequestPayload(req);
    const body = checkAvailabilityByReasonBodySchema.parse(requestPayload);
    const { credentials } = await loadTenantCredentials(body.tenantId);
    const kb = await loadJobTypesKnowledgeBase(body.tenantId);
    const { matches } = resolveJobTypeFromReason(body.reason, kb, body.topN);
    const top = matches[0];
    if (!top) {
      return res.status(400).json({
        success: false,
        error: 'No job type match for the given reason',
      });
    }

    const skills = skillsAlignedWithTopNMatches(matches, body.topN);
    if (skills.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No skills available for the matched job type',
      });
    }

    const techMatches = await technicianMatchesForSkills(credentials.tenantId, skills);
    if (techMatches.length === 0) {
      return res.status(400).json({
        success: false,
        error:
          'No technicians matched the required skills; set SERVICETITAN_FALLBACK_TECHNICIAN_ID for a last-resort tech',
      });
    }

    const technicianIds = techMatches.map((t) => t.technicianId);
    const resolvedDuration = body.duration ?? top.row.durationMinutes ?? 60;
    if (!Number.isFinite(resolvedDuration) || resolvedDuration <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid duration for availability check',
      });
    }

    const wallTime = body.startTime ?? body.time;
    const inner = checkAvailabilityBodySchema.parse({
      tenantId: body.tenantId,
      date: body.date,
      technicianIds,
      startTime: wallTime,
      endTime: body.endTime,
      duration: resolvedDuration,
      slotPreviewLimit: body.slotPreviewLimit,
    });

    const result = await runAgentCheckAvailabilityCore(inner);
    if (!result.ok) {
      return res.status(result.status).json({ success: false, error: result.error });
    }

    const priority = top.row.priority ?? null;
    const businessId = top.row.businessUnitId ?? null;

    return res.json({
      success: true,
      data: buildCheckAvailabilityByReasonData(result.data, {
        jobTypeId: top.jobTypeId,
        priority,
        businessId,
      }),
    });
  } catch (error) {
    logRouteException('[ServiceTitan] agent check-availability-by-reason failed', error);
    return res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

serviceTitanRouter.post('/agent/resolve-customer-location', async (req, res) => {
  try {
    const body = resolveCustomerLocationBodySchema.parse(req.body);
    const { credentials } = await loadTenantCredentials(body.tenantId);
    const client = new ServiceTitanClient(credentials);
    const idsProvided = body.customerId != null && body.locationId != null;
    const resolved = await resolveCustomerAndLocationIds({
      client,
      tenantId: body.tenantId,
      customerId: body.customerId,
      locationId: body.locationId,
      customerName: body.customerName,
      phone: body.phone,
      address: body.address,
    });
    const status = deriveResolveCustomerLocationStatus({
      idsProvided,
      customerCreated: resolved.customerCreated,
      locationCreated: resolved.locationCreated,
    });

    return res.json({
      success: true,
      data: {
        customerId: resolved.customerId,
        locationId: resolved.locationId,
        status,
        customerCreated: resolved.customerCreated,
        locationCreated: resolved.locationCreated,
      },
    });
  } catch (error) {
    logRouteException('[ServiceTitan] agent resolve-customer-location failed', error);
    return res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

serviceTitanRouter.post('/agent/book', async (req, res) => {
  try {
    const requestPayload = normalizedRequestPayload(req);
    const body = bookAppointmentBodySchema.parse(requestPayload);
    const { credentials, timezone: tenantTimezone } = await loadTenantCredentials(body.tenantId);
    const client = new ServiceTitanClient(credentials);
    const timeZone = tenantTimezone ?? 'UTC';
    const idsProvidedAtRequest = body.customerId != null && body.locationId != null;
    const resolved = await resolveCustomerAndLocationIds({
      client,
      tenantId: body.tenantId,
      customerId: body.customerId,
      locationId: body.locationId,
      customerName: body.customerName,
      phone: body.phone,
      address: body.address,
    });
    const resolveStatus = deriveResolveCustomerLocationStatus({
      idsProvided: idsProvidedAtRequest,
      customerCreated: resolved.customerCreated,
      locationCreated: resolved.locationCreated,
    });

    const startUtc = localWallClockToUtcIso(body.date, normalizeTimeComponent(body.startTime), timeZone);
    if (!startUtc) {
      return res.status(400).json({ success: false, error: 'Invalid startTime or date' });
    }

    let endUtc: string;
    if (body.endTime) {
      const parsed = localWallClockToUtcIso(body.date, normalizeTimeComponent(body.endTime), timeZone);
      if (!parsed) {
        return res.status(400).json({ success: false, error: 'Invalid endTime or date' });
      }
      endUtc = parsed;
    } else {
      endUtc = new Date(
        new Date(startUtc).getTime() + (body.duration as number) * 60_000
      ).toISOString();
    }

    if (endUtc <= startUtc) {
      return res.status(400).json({ success: false, error: 'End must be after start' });
    }

    const jobPayload = buildServiceTitanJobsPayload({
      customerId: resolved.customerId,
      locationId: resolved.locationId,
      businessUnitId: body.businessUnitId,
      jobTypeId: body.jobTypeId,
      priority: body.priority,
      campaignId: env.serviceTitanCampaignId,
      startUtc,
      endUtc,
      technicianIds: [body.technicianId],
      summary: body.summary,
    });

    const raw = await client.bookJob(jobPayload);
    const job = raw as {
      id?: number;
      appointments?: { id?: number; start?: string; end?: string; technicianIds?: number[] }[];
    };
    const ap = job.appointments?.[0];

    return res.json({
      success: true,
      data: {
        jobId: job.id ?? null,
        appointmentId: ap?.id ?? null,
        customerId: resolved.customerId,
        locationId: resolved.locationId,
        status: resolveStatus,
        customerCreated: resolved.customerCreated,
        locationCreated: resolved.locationCreated,
        technicianId: body.technicianId,
        start: ap?.start ? toClientTime(ap.start, timeZone) : toClientTime(startUtc, timeZone),
        end: ap?.end ? toClientTime(ap.end, timeZone) : toClientTime(endUtc, timeZone),
        startUtc: ap?.start ?? startUtc,
        endUtc: ap?.end ?? endUtc,
      },
    });
  } catch (error) {
    logRouteException('[ServiceTitan] agent book failed', error);
    return res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});
