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

/** Human-readable text for the caller's requested time window, or null if none given. */
function resolveWindowText(args: Record<string, unknown>): string | null {
  const display = (args.slot_display as string | undefined)?.trim();
  if (display) return display;
  const start = (args.scheduled_start as string | undefined)?.trim();
  const end = (args.scheduled_end as string | undefined)?.trim();
  if (start && end) return `${start} to ${end}`;
  if (start) return start;
  return null;
}

/**
 * Builds the job notes for the office. HCP receives no line items or schedule,
 * so the issue and the requested window live here:
 *
 *   Issue Description :- <issue>
 *   Job between <start> to <end>
 */
function resolveNotes(args: Record<string, unknown>): string {
  const issue =
    (args.service_name as string | undefined)?.trim() ||
    (args.reason as string | undefined)?.trim() ||
    (args.job_type as string | undefined)?.trim() ||
    'Service request';

  let notes = `Issue Description :- ${issue}`;
  const window = resolveWindowText(args);
  if (window) notes += `\nJob between ${window}`;
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
  const lead = await resolveLeadSource(session.toNumber).catch(() => null);
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
        scheduledStart: requestedStart,
        scheduledEnd: requestedEnd,
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
