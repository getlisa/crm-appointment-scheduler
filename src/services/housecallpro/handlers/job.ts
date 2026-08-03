/**
 * Retell function handler: book_job (Office-Hours).
 *
 * Creates the service request in HCP as an UNSCHEDULED "new job" — no schedule
 * and no line items are sent, so HCP lands it in the office's New pipeline to
 * schedule themselves. The issue description and the caller's requested time
 * window are captured as free text in the job `notes` (for the office's
 * reference). The job's `lead_source` is resolved from the dialed tracking line
 * (session.toNumber) via housecallpro_lead_sources.
 *
 * The row is persisted to housecallpro_jobs (the caller's requested window is
 * kept there as our internal record only — it is NOT sent to HCP) and the job +
 * requested slot are recorded on the call session.
 */

import { createJob } from '../client.js';
import { insertJob } from '../db/jobs.js';
import { getCustomerByHcpId } from '../db/customers.js';
import { resolveLeadSource } from '../db/leadSources.js';
import { setJobCreated, setSelectedSlot } from '../db/callsessions.js';
import { sendHcpNotification } from '../emailNotificationService.js';
import type {
  HcpCallSessionRow,
  HcpContext,
  HcpCreateJobInput,
  RetellFunctionResult,
} from '../types.js';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Parses a local ISO wall time ("2026-08-04T09:00:00", already in the tenant's
 * timezone) into a friendly date plus its hour/minute — e.g.
 * { date: "August 4, 2026", hour: 9, minute: 0 }. No timezone conversion.
 */
/**
 * Parses a local time string into a friendly date plus its hour (0-23) and minute.
 * Accepts 24-hour ISO ("2026-08-04T14:00:00") and tolerates a single-digit hour
 * and an explicit AM/PM suffix ("2026-08-04T2:00 PM" → hour 14). No tz conversion.
 */
function formatLocalDate(iso?: string | null): { date: string; hour: number; minute: number } | null {
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
function partOfDay(hour: number): 'morning' | 'afternoon' | 'evening' {
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}

/** A part-of-day word if the text explicitly says one (wins over a parsed hour). */
function partOfDayFromText(text?: string | null): 'morning' | 'afternoon' | 'evening' | null {
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
 */
function resolveWindowText(args: Record<string, unknown>): string | null {
  const startRaw = (args.scheduled_start as string | undefined)?.trim();
  const display = (args.slot_display as string | undefined)?.trim();
  const d = formatLocalDate(startRaw);
  if (d) {
    const worded = partOfDayFromText(startRaw) ?? partOfDayFromText(display);
    if (worded) return `Job logged for ${d.date} in the ${worded}`;
    if (d.hour === 0 && d.minute === 0) return `Job logged for ${d.date}`;
    return `Job logged for ${d.date} in the ${partOfDay(d.hour)}`;
  }
  return display ? `Job logged for ${display}` : null;
}

/**
 * Builds the job notes for the office. HCP receives no line items or schedule,
 * so the classified service, the caller's full account, and the requested window
 * live here:
 *
 *   Service :- <canonical service type>            (omitted if not classified)
 *   Issue Description :- <caller's complete account>
 *   Job logged for <date> in the <morning/afternoon/evening>
 *
 * `issue` is the caller's own words (everything they said); `service_type` is the
 * canonical classification. `service_name` is kept as a legacy fallback for the issue.
 */
function resolveNotes(args: Record<string, unknown>): string {
  const serviceType = (args.service_type as string | undefined)?.trim();
  const issue =
    (args.issue as string | undefined)?.trim() ||
    (args.service_name as string | undefined)?.trim() ||
    (args.reason as string | undefined)?.trim() ||
    (args.job_type as string | undefined)?.trim() ||
    'Service request';

  let notes = '';
  if (serviceType) notes += `Service :- ${serviceType}\n`;
  notes += `Issue Description :- ${issue}`;
  const window = resolveWindowText(args);
  if (window) notes += `\n${window}`;
  return notes;
}

export async function handleBookJob(
  session: HcpCallSessionRow,
  ctx: HcpContext,
  args: Record<string, unknown>,
): Promise<RetellFunctionResult> {
  const customerId = session.housecallproCustomerId;
  if (!customerId) {
    return { result: 'error: no customer identified — complete lookup or create the customer first' };
  }

  const addressId =
    (args.address_id as string | undefined)?.trim() ||
    session.serviceAddressMap?.selectedAddressId ||
    undefined;
  if (!addressId) {
    return { result: 'error: no address selected — call match_address or create_address first' };
  }

  const notes = resolveNotes(args);

  // Attribute the job to the HCP lead source behind the dialed tracking line.
  // Prefer the SIP Diversion tracking line (the actual lead source); fall back to
  // to_number (the shared DID) only when the diversion wasn't captured.
  const lead = await resolveLeadSource(session.leadSourceNumber ?? session.toNumber).catch(() => null);
  const leadSource = lead?.leadName ?? lead?.leadSourceId ?? 'Clara';

  // Unscheduled "new job": no `schedule`, no `line_items` — the issue + requested
  // window are in `notes`. HCP returns work_status "new job".
  const body: HcpCreateJobInput = {
    customer_id: customerId,
    address_id: addressId,
    notes,
    lead_source: leadSource,
  };

  // The caller's requested window is kept for our own records only (not sent to HCP).
  const requestedStart = (args.scheduled_start as string | undefined)?.trim() || null;
  const requestedEnd = (args.scheduled_end as string | undefined)?.trim() || null;

  try {
    const job = await createJob(ctx, body);
    const jobNumber = (job.invoice_number as string | null) ?? null;
    const workStatus = (job.work_status as string | null) ?? 'new job';

    await insertJob(session.tenantId, {
      housecallproJobId: job.id,
      housecallproCustomerId: customerId,
      addressId,
      sessionId: session.sessionId,
      scheduledStart: requestedStart,
      scheduledEnd: requestedEnd,
      arrivalWindow: null,
      lineItems: null,
    });

    await setJobCreated(session.sessionId, job.id, jobNumber);
    if (requestedStart) {
      await setSelectedSlot(session.sessionId, {
        start: requestedStart,
        end: requestedEnd,
        display: (args.slot_display as string | undefined)?.trim() || null,
      }).catch(() => undefined);
    }

    // Best-effort notification
    const customer = await getCustomerByHcpId(session.tenantId, customerId).catch(() => null);
    sendHcpNotification({
      kind: 'job_booked',
      emailTo: ctx.emailTo,
      ccMail: ctx.ccMail,
      details: {
        customerName: session.customerName ?? customer?.name ?? null,
        callbackNumber: session.caller,
        address: session.serviceAddressMap?.addresses?.[addressId]?.formatted ?? null,
        notes, // same Service / Issue Description / schedule block sent to HCP
        jobNumber,
        jobId: job.id,
      },
    }).catch(() => undefined);

    console.log('[hcp] book_job created', {
      sessionId: session.sessionId,
      jobId: job.id,
      jobNumber,
      workStatus,
      leadSource,
    });
    return {
      result: JSON.stringify({
        status: 'created',
        job_id: job.id,
        invoice_number: jobNumber,
        work_status: workStatus,
        scheduled: false,
      }),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[hcp] book_job error', { sessionId: session.sessionId, error: msg });
    return { result: `error: job creation failed — ${msg}` };
  }
}
