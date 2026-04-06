import type {
  AvailabilitySlot,
  DailyTechnicianSchedule,
  TechnicianAvailability,
} from './types.js';

function addMinutes(isoDate: string, minutes: number): string {
  const d = new Date(isoDate);
  d.setMinutes(d.getMinutes() + minutes);
  return d.toISOString();
}

function getOffsetMinutes(timeZone: string, date: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
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
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  );
  return (asUtc - date.getTime()) / 60000;
}

function zonedLocalToUtcMs(date: string, timeValue: string, timeZone: string): number {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeMatch = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(timeValue);
  if (!dateMatch || !timeMatch) return Number.NaN;

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const second = Number(timeMatch[3] ?? '00');

  let utcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let i = 0; i < 3; i += 1) {
    const offsetMinutes = getOffsetMinutes(timeZone, new Date(utcMs));
    const next = Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60_000;
    if (next === utcMs) break;
    utcMs = next;
  }

  return utcMs;
}

function buildShiftIso(dayDate: string, timeZone: string, timeValue?: string): string | null {
  if (!timeValue) return null;
  const utcMs = zonedLocalToUtcMs(dayDate, timeValue, timeZone);
  if (Number.isNaN(utcMs)) return null;
  return new Date(utcMs).toISOString();
}

function mergeSlots(slots: AvailabilitySlot[]): AvailabilitySlot[] {
  if (slots.length <= 1) return slots;
  const sorted = [...slots].sort((a, b) => a.start.localeCompare(b.start));
  const merged: AvailabilitySlot[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i += 1) {
    const last = merged[merged.length - 1];
    const current = sorted[i];
    if (current.start <= last.end) {
      last.end = current.end > last.end ? current.end : last.end;
    } else {
      merged.push(current);
    }
  }

  return merged;
}

export function computeDailyAvailability(params: {
  schedules: DailyTechnicianSchedule[];
  date: string;
  timeZone: string;
  shiftStartIso: string;
  shiftEndIso: string;
  requestedDurationMinutes: number;
}): TechnicianAvailability[] {
  return params.schedules.map((schedule) => {
    const technicianShiftStart = buildShiftIso(params.date, params.timeZone, schedule.shiftStart);
    const technicianShiftEnd = buildShiftIso(params.date, params.timeZone, schedule.shiftEnd);

    const shiftBlock: AvailabilitySlot =
      technicianShiftStart && technicianShiftEnd && technicianShiftEnd > technicianShiftStart
        ? { start: technicianShiftStart, end: technicianShiftEnd }
        : { start: params.shiftStartIso, end: params.shiftEndIso };

    const busyEvents =
      schedule.busyEvents.length > 0
        ? schedule.busyEvents
        : schedule.appointments.map((appointment) => ({
            eventId: `legacy:${appointment.appointmentId}`,
            start: appointment.start,
            end: appointment.end,
            status: appointment.status,
            source: 'job_appointment' as const,
            blocksBooking: true,
            preBufferMinutes: 30,
            postBufferMinutes: 30,
          }));

    const bufferedBusy: AvailabilitySlot[] = busyEvents
      .filter((event) => event.blocksBooking)
      .map((event) => ({
        start: addMinutes(event.start, -event.preBufferMinutes),
        end: addMinutes(event.end, event.postBufferMinutes),
      }));

    const mergedBusy = mergeSlots(bufferedBusy);
    const freeSlots: AvailabilitySlot[] = [];
    let pointer = shiftBlock.start;

    mergedBusy.forEach((busy) => {
      if (busy.start > pointer) {
        freeSlots.push({ start: pointer, end: busy.start });
      }
      if (busy.end > pointer) {
        pointer = busy.end;
      }
    });

    if (pointer < shiftBlock.end) {
      freeSlots.push({ start: pointer, end: shiftBlock.end });
    }

    const minMs = params.requestedDurationMinutes * 60 * 1000;
    const filteredSlots = freeSlots.filter((slot) => {
      const startMs = new Date(slot.start).getTime();
      const endMs = new Date(slot.end).getTime();
      return endMs - startMs >= minMs;
    });

    return {
      technicianId: schedule.technicianId,
      technicianName: schedule.technicianName,
      bio: schedule.bio,
      positions: schedule.positions ?? [],
      skills: schedule.skills ?? [],
      slots: filteredSlots,
    };
  });
}
