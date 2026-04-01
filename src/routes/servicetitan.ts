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
import { loadTenantCredentials, saveTenantCredentials } from '../services/servicetitan/credentials.js';
import { computeAgentAvailabilityCheck, computeAgentDaySlotsMode } from '../services/servicetitan/agent-check.js';
import { resolveJobTypeFromReason, type RetellJobTypeKbRow } from '../services/servicetitan/job-types-kb.js';
import {
  loadJobTypesKnowledgeBase,
  matchTechniciansBySkills,
  upsertServiceTitanJobTypes,
  upsertServiceTitanTechnicians,
} from '../services/servicetitan/store.js';
import type { DailyTechnicianSchedule } from '../services/servicetitan/types.js';

const tenantIdField = z.coerce.number().int().positive();

const connectBodySchema = z.object({
  tenantId: z.number().int().positive(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  appKey: z.string().min(1),
  timezone: z.string().min(1),
});

const syncQuerySchema = z.object({
  tenantId: tenantIdField,
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
  topN: z.coerce.number().int().min(1).max(10).optional().default(3),
});

const checkAvailabilityBodySchema = z
  .object({
    tenantId: tenantIdField,
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    technicianIds: z.array(z.string().min(1)).min(1),
    startTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
    endTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
    duration: z.coerce.number().int().positive().default(60),
    /**
     * Cap on how many windows to return per technician after full expansion (0 = all, up to 2000).
     */
    slotPreviewLimit: z.coerce.number().int().min(0).max(2000).optional().default(0),
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

const bookAppointmentBodySchema = z
  .object({
    tenantId: tenantIdField,
    customerId: z.number().int().positive(),
    locationId: z.number().int().positive(),
    businessUnitId: z.number().int().positive().optional(),
    jobTypeId: z.number().int().positive().optional(),
    campaignId: z.number().int().positive().optional(),
    priority: z.string().optional(),
    summary: z.string().optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    startTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
    endTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
    duration: z.coerce.number().int().positive().optional().default(60),
    technicianId: z.number().int().positive(),
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
    console.error('[ServiceTitan] connect failed', error);
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
    const [technicians, jobTypes] = await Promise.all([
      client.getTechnicians(),
      client.getAllJobTypes(),
    ]);

    await upsertServiceTitanTechnicians({
      tenantId: credentials.tenantId,
      technicians,
    });
    await upsertServiceTitanJobTypes({
      tenantId: credentials.tenantId,
      jobTypes,
    });
    console.log('[ServiceTitan] sync completed', {
      technicians: technicians.length,
      jobTypes: jobTypes.length,
    });
    return res.json({
      success: true,
      counts: {
        technicians: technicians.length,
        jobTypes: jobTypes.length,
      },
    });
  } catch (error) {
    console.error('[ServiceTitan] sync failed', error);
    return res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

serviceTitanRouter.get('/schedule', async (req, res) => {
  try {
    const query = scheduleQuerySchema.parse(req.query);
    const { credentials, timezone: tenantTimezone } = await loadTenantCredentials(query.tenantId);
    const client = new ServiceTitanClient(credentials);
    const timeZone = tenantTimezone ?? 'UTC';
    const window = getUtcDayWindow(query.date, timeZone);
    const schedule = await client.getDailyTechnicianSchedule(window).then((rows) =>
      rows.map((row) => ({
        ...row,
        appointments: row.appointments.map((appointment) => ({
          ...appointment,
          start: toClientTime(appointment.start, timeZone),
          end: toClientTime(appointment.end, timeZone),
        })),
      }))
    );

    return res.json({ success: true, data: schedule });
  } catch (error) {
    console.error('[ServiceTitan] schedule failed', error);
    return res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

serviceTitanRouter.get('/availability', async (req, res) => {
  try {
    const query = availabilityQuerySchema.parse(req.query);
    const { credentials, timezone: tenantTimezone } = await loadTenantCredentials(query.tenantId);
    const client = new ServiceTitanClient(credentials);
    const timeZone = tenantTimezone ?? 'UTC';
    const window = getUtcDayWindow(query.date, timeZone);
    const schedule = await client.getDailyTechnicianSchedule(window);

    const availability = computeDailyAvailability({
      schedules: schedule,
      date: query.date,
      timeZone,
      shiftStartIso: window.startsOnOrAfter,
      shiftEndIso: window.startsBefore,
      requestedDurationMinutes: query.duration,
    });
    const localizedAvailability = availability.map((row) => ({
      ...row,
      slots: row.slots.map((slot) => ({
        start: toClientTime(slot.start, timeZone),
        end: toClientTime(slot.end, timeZone),
      })),
    }));

    return res.json({ success: true, data: localizedAvailability });
  } catch (error) {
    console.error('[ServiceTitan] availability failed', error);
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
    const rows = await matchTechniciansBySkills({
      tenantId: credentials.tenantId,
      requiredSkills: body.skills,
    });

    const normReq = body.skills.map((s) => s.trim().toLowerCase()).filter(Boolean);
    const data = rows.map((r) => {
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
      };
    });

    return res.json({ success: true, data });
  } catch (error) {
    console.error('[ServiceTitan] agent match-technicians failed', error);
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
    console.error('[ServiceTitan] job-types knowledge-base failed', error);
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

    return res.json({
      success: true,
      data: {
        skills,
        duration,
      },
    });
  } catch (error) {
    console.error('[ServiceTitan] agent resolve-job-type failed', error);
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

serviceTitanRouter.post('/agent/check-availability', async (req, res) => {
  try {
    const body = checkAvailabilityBodySchema.parse(req.body);
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
        const dm = body.duration;
        if (dm == null) {
          return res.status(400).json({ success: false, error: 'durationMinutes required when endTime is omitted' });
        }
        endUtc = new Date(new Date(startUtc).getTime() + dm * 60_000).toISOString();
      }

      if (endUtc <= startUtc) {
        return res.status(400).json({ success: false, error: 'End must be after start' });
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

      return res.json({
        success: true,
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
      });
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

      return res.json({
        success: true,
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
      });
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

    return res.json({
      success: true,
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
    });
  } catch (error) {
    console.error('[ServiceTitan] agent check-availability failed', error);
    return res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

serviceTitanRouter.post('/agent/book', async (req, res) => {
  try {
    const body = bookAppointmentBodySchema.parse(req.body);
    const { credentials, timezone: tenantTimezone } = await loadTenantCredentials(body.tenantId);
    const client = new ServiceTitanClient(credentials);
    const timeZone = tenantTimezone ?? 'UTC';

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

    const appointment = {
      start: startUtc,
      end: endUtc,
      technicianIds: [body.technicianId],
    };

    const payload: Record<string, unknown> = {
      customerId: body.customerId,
      locationId: body.locationId,
      appointments: [appointment],
    };
    if (body.businessUnitId != null) payload.businessUnitId = body.businessUnitId;
    if (body.jobTypeId != null) payload.jobTypeId = body.jobTypeId;
    if (body.campaignId != null) payload.campaignId = body.campaignId;
    if (body.priority != null) payload.priority = body.priority;
    if (body.summary != null) payload.summary = body.summary;

    const raw = await client.bookJob(payload);
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
        technicianId: body.technicianId,
        start: ap?.start ? toClientTime(ap.start, timeZone) : toClientTime(startUtc, timeZone),
        end: ap?.end ? toClientTime(ap.end, timeZone) : toClientTime(endUtc, timeZone),
        startUtc: ap?.start ?? startUtc,
        endUtc: ap?.end ?? endUtc,
      },
    });
  } catch (error) {
    console.error('[ServiceTitan] agent book failed', error);
    return res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});
