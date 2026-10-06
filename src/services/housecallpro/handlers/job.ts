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
import { resolveNotes } from '../requestNotes.js';
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

/**
 * Creates the job, and retries once without `lead_source` when HCP rejects the
 * stored lead name ("Lead source not found"). Losing the attribution is better
 * than losing the caller's job.
 */
async function createJobTolerantOfLeadSource(
  ctx: HcpContext,
  body: HcpCreateJobInput,
  sessionId: string,
): Promise<Awaited<ReturnType<typeof createJob>>> {
  try {
    return await createJob(ctx, body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!body.lead_source || !/lead source not found/i.test(msg)) throw err;
    console.warn('[hcp] book_job lead_source rejected by HCP — retrying without it', {
      sessionId,
      leadSource: body.lead_source,
    });
    const { lead_source: _rejected, ...withoutLeadSource } = body;
    return await createJob(ctx, withoutLeadSource);
  }
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
  // `lead_source` is a lead-source NAME, not an id: HCP looks the string up among
  // the account's configured lead sources and rejects the whole job with
  // 400 "Lead source not found" when it doesn't match. So an unmapped line (or a
  // row with no lead_name) sends no lead_source at all — never an `lsrc_…` id.
  const leadSource = lead?.leadName ?? null;

  // Unscheduled "new job": no `schedule`, no `line_items` — the issue + requested
  // window are in `notes`. HCP returns work_status "new job".
  const body: HcpCreateJobInput = {
    customer_id: customerId,
    address_id: addressId,
    notes,
    ...(leadSource ? { lead_source: leadSource } : {}),
  };

  // The caller's requested window is kept for our own records only (not sent to HCP).
  const requestedStart = (args.scheduled_start as string | undefined)?.trim() || null;
  const requestedEnd = (args.scheduled_end as string | undefined)?.trim() || null;

  try {
    const job = await createJobTolerantOfLeadSource(ctx, body, session.sessionId);
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
