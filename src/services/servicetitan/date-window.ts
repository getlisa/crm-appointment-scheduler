function parseDateParts(date: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) {
    throw new Error('Invalid date. Expected YYYY-MM-DD');
  }

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
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

function zonedMidnightToUtcMs(date: string, timeZone: string): number {
  const { year, month, day } = parseDateParts(date);
  let utcMs = Date.UTC(year, month - 1, day, 0, 0, 0);

  // Iterate to handle DST offset transitions accurately.
  for (let i = 0; i < 3; i += 1) {
    const offsetMinutes = getOffsetMinutes(timeZone, new Date(utcMs));
    const next = Date.UTC(year, month - 1, day, 0, 0, 0) - offsetMinutes * 60_000;
    if (next === utcMs) break;
    utcMs = next;
  }

  return utcMs;
}

/** Convert tenant-local wall-clock time on `date` (YYYY-MM-DD) to UTC ISO string. */
export function localWallClockToUtcIso(date: string, timeValue: string, timeZone: string): string | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeMatch = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(timeValue);
  if (!dateMatch || !timeMatch) return null;

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

  return new Date(utcMs).toISOString();
}

/** Today's calendar date in the given IANA timezone (YYYY-MM-DD). */
export function todayYyyyMmDdInTimeZone(timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());

  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

/** Add calendar days to a YYYY-MM-DD string (naive date; matches tenant-local calendar labels). */
export function addCalendarDaysYmd(ymd: string, days: number): string {
  const { year, month, day } = parseDateParts(ymd);
  const dt = new Date(Date.UTC(year, month - 1, day + days));
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Seconds since local midnight in `timeZone` (for comparing to shift wall times). */
export function nowLocalSecondsSinceMidnight(timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date());

  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Number(map.hour) * 3600 + Number(map.minute) * 60 + Number(map.second);
}

export function parseShiftTimeToSeconds(value: string | undefined): number | null {
  if (value == null || value === '') return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const s = Number(m[3] ?? '0');
  if (h > 23 || min > 59 || s > 59) return null;
  return h * 3600 + min * 60 + s;
}

/**
 * Earliest shift start and latest shift end among technicians (same calendar-day shifts only).
 * Ignores overnight pairs where end <= start.
 */
export function aggregateShiftWindowFromTechnicians(
  techs: { shiftStart?: string; shiftEnd?: string }[]
): { start: number; end: number } | null {
  let minStart = Infinity;
  let maxEnd = -Infinity;
  for (const t of techs) {
    const s = parseShiftTimeToSeconds(t.shiftStart);
    const e = parseShiftTimeToSeconds(t.shiftEnd);
    if (s == null || e == null) continue;
    if (e <= s) continue;
    minStart = Math.min(minStart, s);
    maxEnd = Math.max(maxEnd, e);
  }
  if (minStart === Infinity) return null;
  return { start: minStart, end: maxEnd };
}

export type NoDateSearchAnchorStrategy =
  | 'today_within_shift_hours'
  | 'next_day_outside_shift_hours'
  | 'today_no_shift_aggregate_for_requested_technicians';

/**
 * For “no date” availability: the single calendar day to evaluate is today if local now falls
 * inside the aggregate shift window; otherwise the next calendar day.
 */
export function resolveNoDateSearchAnchorYmd(
  timeZone: string,
  aggregateShift: { start: number; end: number } | null
): { anchor: string; strategy: NoDateSearchAnchorStrategy } {
  const today = todayYyyyMmDdInTimeZone(timeZone);
  if (!aggregateShift) {
    return { anchor: today, strategy: 'today_no_shift_aggregate_for_requested_technicians' };
  }
  const nowSec = nowLocalSecondsSinceMidnight(timeZone);
  const inWindow = nowSec >= aggregateShift.start && nowSec <= aggregateShift.end;
  if (inWindow) {
    return { anchor: today, strategy: 'today_within_shift_hours' };
  }
  return {
    anchor: addCalendarDaysYmd(today, 1),
    strategy: 'next_day_outside_shift_hours',
  };
}

export function getUtcDayWindow(
  date: string,
  timeZone = 'UTC'
): { startsOnOrAfter: string; startsBefore: string } {
  const startUtcMs = zonedMidnightToUtcMs(date, timeZone);
  const nextDay = new Date(startUtcMs);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const nextDate = nextDay.toISOString().slice(0, 10);
  const endUtcMs = zonedMidnightToUtcMs(nextDate, timeZone);

  return {
    startsOnOrAfter: new Date(startUtcMs).toISOString(),
    startsBefore: new Date(endUtcMs).toISOString(),
  };
}
