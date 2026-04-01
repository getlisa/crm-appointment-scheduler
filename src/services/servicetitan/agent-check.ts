import { computeDailyAvailability } from './availability.js';
import type { AvailabilitySlot, DailyTechnicianSchedule, TechnicianAvailability } from './types.js';

function requestFitsSlot(reqStart: string, reqEnd: string, slot: AvailabilitySlot): boolean {
  return reqStart >= slot.start && reqEnd <= slot.end;
}

function findEarliestAlternative(
  slots: AvailabilitySlot[],
  durationMinutes: number,
  onOrAfterIso: string | null
): { start: string; end: string } | null {
  const durMs = durationMinutes * 60 * 1000;
  const afterMs = onOrAfterIso ? new Date(onOrAfterIso).getTime() : null;
  let best: { start: string; end: string } | null = null;
  let bestStart = Infinity;

  for (const slot of slots) {
    const s = new Date(slot.start).getTime();
    const e = new Date(slot.end).getTime();
    let candStart = s;
    if (afterMs !== null && afterMs > candStart) candStart = afterMs;
    const candEnd = candStart + durMs;
    if (candEnd <= e && candStart < bestStart) {
      bestStart = candStart;
      best = { start: new Date(candStart).toISOString(), end: new Date(candEnd).toISOString() };
    }
  }

  return best;
}

export type AgentAvailabilityTechnicianResult = {
  technicianId: string;
  technicianName: string;
  fitsRequest: boolean;
  doesNotFitReason?: string;
  earliestAlternativeUtc?: { start: string; end: string } | null;
};

export function computeAgentAvailabilityCheck(params: {
  schedules: DailyTechnicianSchedule[];
  date: string;
  timeZone: string;
  shiftStartIso: string;
  shiftEndIso: string;
  requestStartUtc: string;
  requestEndUtc: string;
}): {
  technicians: AgentAvailabilityTechnicianResult[];
  globalEarliestAlternativeUtc: { technicianId: string; start: string; end: string } | null;
} {
  const durationMinutes = Math.max(
    1,
    Math.round(
      (new Date(params.requestEndUtc).getTime() - new Date(params.requestStartUtc).getTime()) / 60_000
    )
  );

  const fullAvailability: TechnicianAvailability[] = computeDailyAvailability({
    schedules: params.schedules,
    date: params.date,
    timeZone: params.timeZone,
    shiftStartIso: params.shiftStartIso,
    shiftEndIso: params.shiftEndIso,
    requestedDurationMinutes: durationMinutes,
  });

  const byTechId = new Map(fullAvailability.map((row) => [row.technicianId, row]));

  const technicians: AgentAvailabilityTechnicianResult[] = params.schedules.map((sched) => {
    const row = byTechId.get(sched.technicianId);
    if (!row) {
      return {
        technicianId: sched.technicianId,
        technicianName: sched.technicianName,
        fitsRequest: false,
        doesNotFitReason: 'technician_not_found',
        earliestAlternativeUtc: null,
      };
    }
    const fits = row.slots.some((slot) =>
      requestFitsSlot(params.requestStartUtc, params.requestEndUtc, slot)
    );

    if (fits) {
      return {
        technicianId: row.technicianId,
        technicianName: row.technicianName,
        fitsRequest: true,
        earliestAlternativeUtc: null,
      };
    }

    let reason = 'requested_time_unavailable';
    if (!row.slots.length) {
      reason = 'no_contiguous_window_for_duration';
    }

    const alt = findEarliestAlternative(row.slots, durationMinutes, params.requestStartUtc);

    return {
      technicianId: row.technicianId,
      technicianName: row.technicianName,
      fitsRequest: false,
      doesNotFitReason: reason,
      earliestAlternativeUtc: alt,
    };
  });

  let globalEarliest: { technicianId: string; start: string; end: string } | null = null;
  let globalStart = Infinity;
  for (const t of technicians) {
    const alt = t.earliestAlternativeUtc;
    if (!alt) continue;
    const s = new Date(alt.start).getTime();
    if (s < globalStart) {
      globalStart = s;
      globalEarliest = { technicianId: t.technicianId, ...alt };
    }
  }

  return { technicians, globalEarliestAlternativeUtc: globalEarliest };
}

export type AgentDaySlotsTechnicianResult = {
  technicianId: string;
  technicianName: string;
  hasAvailability: boolean;
  earliestSlotUtc: { start: string; end: string } | null;
  /** All bookable windows of `durationMinutes`, consecutive starts spaced by `durationMinutes`, sorted. */
  slotsPreviewUtc: { start: string; end: string }[];
};

/** Hard cap so a single request cannot return unbounded arrays. */
const MAX_SLOTS_PREVIEW_PER_TECH = 2000;

/**
 * Every valid `{start, end}` of length `durationMinutes` inside free gaps; next start is +durationMinutes
 * (back-to-back slots from gap start). Result sorted by start.
 */
function expandAllBookableWindows(
  slots: AvailabilitySlot[],
  durationMinutes: number
): { start: string; end: string }[] {
  const durMs = durationMinutes * 60 * 1000;
  const stepMs = durMs;
  const out: { start: string; end: string }[] = [];

  slotLoop: for (const slot of slots) {
    const s0 = new Date(slot.start).getTime();
    const e0 = new Date(slot.end).getTime();
    if (e0 - s0 < durMs) continue;

    for (let t = s0; t + durMs <= e0; t += stepMs) {
      out.push({
        start: new Date(t).toISOString(),
        end: new Date(t + durMs).toISOString(),
      });
      if (out.length >= MAX_SLOTS_PREVIEW_PER_TECH) break slotLoop;
    }
  }

  out.sort((a, b) => a.start.localeCompare(b.start));
  return out;
}

/** Date provided, no specific time: earliest slot + full list of bookable windows (for “next earliest”). */
export function computeAgentDaySlotsMode(params: {
  schedules: DailyTechnicianSchedule[];
  date: string;
  timeZone: string;
  shiftStartIso: string;
  shiftEndIso: string;
  durationMinutes: number;
  /**
   * Max windows to return after expansion; 0 = all (up to MAX_SLOTS_PREVIEW_PER_TECH).
   */
  slotPreviewLimit: number;
}): {
  technicians: AgentDaySlotsTechnicianResult[];
  globalEarliestUtc: { technicianId: string; start: string; end: string } | null;
} {
  const fullAvailability: TechnicianAvailability[] = computeDailyAvailability({
    schedules: params.schedules,
    date: params.date,
    timeZone: params.timeZone,
    shiftStartIso: params.shiftStartIso,
    shiftEndIso: params.shiftEndIso,
    requestedDurationMinutes: params.durationMinutes,
  });

  const byTechId = new Map(fullAvailability.map((row) => [row.technicianId, row]));

  const technicians: AgentDaySlotsTechnicianResult[] = params.schedules.map((sched) => {
    const row = byTechId.get(sched.technicianId);
    if (!row) {
      return {
        technicianId: sched.technicianId,
        technicianName: sched.technicianName,
        hasAvailability: false,
        earliestSlotUtc: null,
        slotsPreviewUtc: [],
      };
    }

    const earliest = findEarliestAlternative(row.slots, params.durationMinutes, null);
    let slotsPreviewUtc = expandAllBookableWindows(row.slots, params.durationMinutes);
    if (params.slotPreviewLimit > 0) {
      slotsPreviewUtc = slotsPreviewUtc.slice(0, params.slotPreviewLimit);
    }

    return {
      technicianId: sched.technicianId,
      technicianName: sched.technicianName,
      hasAvailability: row.slots.length > 0,
      earliestSlotUtc: earliest,
      slotsPreviewUtc,
    };
  });

  let globalEarliest: { technicianId: string; start: string; end: string } | null = null;
  let globalStart = Infinity;
  for (const t of technicians) {
    const slot = t.earliestSlotUtc;
    if (!slot) continue;
    const s = new Date(slot.start).getTime();
    if (s < globalStart) {
      globalStart = s;
      globalEarliest = { technicianId: t.technicianId, ...slot };
    }
  }

  return { technicians, globalEarliestUtc: globalEarliest };
}
