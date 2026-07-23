/**
 * Retell function handler: book_job (Office-Hours).
 * Creates a job in HCP for the identified customer + resolved address, persists it
 * to housecallpro_jobs, and records the slot + job on the call session.
 */

import { createJob } from '../client.js';
import { insertJob } from '../db/jobs.js';
import { getCustomerByHcpId } from '../db/customers.js';
import { setJobCreated, setSelectedSlot } from '../db/callsessions.js';
import { sendHcpNotification } from '../emailNotificationService.js';
import type {
  HcpCallSessionRow,
  HcpContext,
  HcpCreateJobInput,
  RetellFunctionResult,
} from '../types.js';

/** Coerces the line_items arg into HCP line items; always yields at least one named item. */
function resolveLineItems(args: Record<string, unknown>): { name: string; description?: string }[] {
  const raw = args.line_items;
  if (Array.isArray(raw)) {
    const items = raw
      .map(it => {
        if (typeof it === 'string') return { name: it.trim() };
        const obj = it as Record<string, unknown>;
        const name = (obj.name as string | undefined)?.trim();
        return name ? { name, description: (obj.description as string | undefined)?.trim() || undefined } : null;
      })
      .filter((x): x is { name: string; description?: string } => !!x);
    if (items.length > 0) return items;
  }
  const single =
    (args.service_name as string | undefined)?.trim() ||
    (args.reason as string | undefined)?.trim() ||
    (args.job_type as string | undefined)?.trim();
  return [{ name: single || 'Service Request' }];
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

  const scheduledStart = (args.scheduled_start as string | undefined)?.trim();
  const scheduledEnd = (args.scheduled_end as string | undefined)?.trim();
  const arrivalWindowRaw = args.arrival_window;
  const arrivalWindow =
    typeof arrivalWindowRaw === 'number'
      ? arrivalWindowRaw
      : typeof arrivalWindowRaw === 'string' && arrivalWindowRaw.trim()
        ? Number(arrivalWindowRaw)
        : undefined;

  const lineItems = resolveLineItems(args);

  const body: HcpCreateJobInput = {
    customer_id: customerId,
    address_id: addressId,
    line_items: lineItems,
    ...(scheduledStart
      ? {
          schedule: {
            scheduled_start: scheduledStart,
            ...(scheduledEnd ? { scheduled_end: scheduledEnd } : {}),
            ...(arrivalWindow && Number.isFinite(arrivalWindow) ? { arrival_window: arrivalWindow } : {}),
          },
        }
      : {}),
    lead_source: 'Clara',
  };

  try {
    const job = await createJob(ctx, body);
    const jobNumber = (job.invoice_number as string | null) ?? null;

    await insertJob(session.tenantId, {
      housecallproJobId: job.id,
      housecallproCustomerId: customerId,
      addressId,
      sessionId: session.sessionId,
      scheduledStart: scheduledStart ?? null,
      scheduledEnd: scheduledEnd ?? null,
      arrivalWindow: arrivalWindow && Number.isFinite(arrivalWindow) ? arrivalWindow : null,
      lineItems,
    });

    await setJobCreated(session.sessionId, job.id, jobNumber);
    if (scheduledStart) {
      await setSelectedSlot(session.sessionId, {
        start: scheduledStart,
        end: scheduledEnd ?? null,
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
        scheduledStart: scheduledStart ?? null,
        scheduledEnd: scheduledEnd ?? null,
        jobNumber,
        jobId: job.id,
      },
    }).catch(() => undefined);

    console.log('[hcp] book_job created', { sessionId: session.sessionId, jobId: job.id, jobNumber });
    return {
      result: JSON.stringify({
        status: 'created',
        job_id: job.id,
        invoice_number: jobNumber,
        scheduled_start: scheduledStart ?? null,
        scheduled_end: scheduledEnd ?? null,
      }),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[hcp] book_job error', { sessionId: session.sessionId, error: msg });
    return { result: `error: job creation failed — ${msg}` };
  }
}
