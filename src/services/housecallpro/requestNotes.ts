/**
 * Shared note builder for the two intake endings: book_job (Zephyr) and
 * create_lead (Pierce).
 *
 * Neither sends a schedule to HCP, so the classified service, the caller's full
 * account, and their requested timeframe all live in one free-text block the
 * office reads:
 *
 *   Service :- <canonical service type>            (omitted if not classified)
 *   Issue Description :- <caller's complete account>
 *   <Job|Request> logged for <date> in the <morning/afternoon/evening>
 *
 * The timeframe is deliberately coarse — a date plus a part of day — so nothing
 * in the note can read as a booked slot.
 */

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Parses a local time string into a friendly date plus its hour (0-23) and minute.
 * Accepts 24-hour ISO ("2026-08-04T14:00:00") and tolerates a single-digit hour
 * and an explicit AM/PM suffix ("2026-08-04T2:00 PM" → hour 14). No tz conversion.
 */
export function formatLocalDate(iso?: string | null): { date: string; hour: number; minute: number } | null {
  const m = iso?.trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ]\s*(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?/i);
  if (!m) return null;
  const [, y, mo, d, hh, mi, ap] = m;
  let hour = Number(hh);
  if (ap) {
    const isPm = ap.toLowerCase() === 'pm';
    if (isPm && hour < 12) hour += 12; // 2 PM → 14
    if (!isPm && hour === 12) hour = 0; // 12 AM → 0
  }
  if (hour > 23) hour %= 24;
  return { date: `${MONTHS[Number(mo) - 1]} ${Number(d)}, ${y}`, hour, minute: Number(mi) };
}

/** Coarse part of day, so notes/emails never imply a specific booked time. */
export function partOfDay(hour: number): 'morning' | 'afternoon' | 'evening' {
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}

/** A part-of-day word if the text explicitly says one (wins over a parsed hour). */
export function partOfDayFromText(text?: string | null): 'morning' | 'afternoon' | 'evening' | null {
  const t = (text ?? '').toLowerCase();
  if (/\bmorning\b/.test(t)) return 'morning';
  if (/\bafternoon\b/.test(t)) return 'afternoon';
  if (/\b(evening|tonight|night)\b/.test(t)) return 'evening';
  return null;
}

/**
 * The caller's requested time for the office as a non-committal date + coarse part
 * of day only — never a specific time or window, so nothing implies a booked slot.
 * e.g. "Job logged for August 4, 2026 in the morning". Handles 24-hour and AM/PM
 * times; an explicit "morning/afternoon/evening" word wins over the parsed hour.
 *
 * @param label - leading noun: "Job" for book_job, "Request" for create_lead.
 */
export function resolveWindowText(args: Record<string, unknown>, label = 'Job'): string | null {
  const startRaw = (args.scheduled_start as string | undefined)?.trim();
  const display = (args.slot_display as string | undefined)?.trim();
  const d = formatLocalDate(startRaw);
  if (d) {
    const worded = partOfDayFromText(startRaw) ?? partOfDayFromText(display);
    if (worded) return `${label} logged for ${d.date} in the ${worded}`;
    if (d.hour === 0 && d.minute === 0) return `${label} logged for ${d.date}`;
    return `${label} logged for ${d.date} in the ${partOfDay(d.hour)}`;
  }
  return display ? `${label} logged for ${display}` : null;
}

export interface ResolveNotesOptions {
  /** Leading noun for the timeframe line: "Job" for book_job, "Request" for create_lead. */
  label?: string;
  /**
   * Whether a bare `job_type` argument may stand in for a missing issue.
   * True for book_job, where `job_type` is a legacy alias of the issue text.
   * False for create_lead, where `job_type` is the HCP job-type enum and would
   * otherwise leak a classification into the Issue Description line.
   */
  jobTypeAsIssueFallback?: boolean;
}

/**
 * Builds the office-facing notes block.
 *
 * `issue` is the caller's own words (everything they said); `service_type` is the
 * canonical classification. `service_name` is kept as a legacy fallback for the issue.
 */
export function resolveNotes(
  args: Record<string, unknown>,
  { label = 'Job', jobTypeAsIssueFallback = true }: ResolveNotesOptions = {},
): string {
  const serviceType = (args.service_type as string | undefined)?.trim();
  const issue =
    (args.issue as string | undefined)?.trim() ||
    (args.service_name as string | undefined)?.trim() ||
    (args.reason as string | undefined)?.trim() ||
    (jobTypeAsIssueFallback ? (args.job_type as string | undefined)?.trim() : undefined) ||
    'Service request';

  let notes = '';
  if (serviceType) notes += `Service :- ${serviceType}\n`;
  notes += `Issue Description :- ${issue}`;
  const window = resolveWindowText(args, label);
  if (window) notes += `\n${window}`;
  return notes;
}
