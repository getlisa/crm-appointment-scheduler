/**
 * Retell function handler: create_lead (Pierce Electric, Office Hours).
 *
 * Pierce's intake is lead-only: Clara logs an HCP LEAD for every legitimate
 * service call and the office converts it to a job or an estimate by hand. No
 * job, no estimate, no schedule is created here.
 *
 * A lead always belongs to a customer — POST /leads with no customer is rejected
 * with 400 "Customer is required". We never use HCP's inline-customer form: the
 * customer is already pinned to the session by customer_lookup /
 * lookup_customer_fuzzy / confirm_customer / create_customer, which is also what
 * puts them in our cache (a DB foreign key requires that before the session can
 * reference them). So an existing caller and a brand-new caller take the same
 * path here, both carrying a real `cus_…` id.
 *
 * HCP field names verified live on 2026-09-30 — see HcpCreateLeadInput:
 *   `note` is singular, and `job_type_uuid` is top level.
 */

import { createLead } from '../client.js';
import { resolveNotes } from '../requestNotes.js';
import { insertLead } from '../db/leads.js';
import { getCustomerByHcpId } from '../db/customers.js';
import { resolveJobTypeUuid } from '../db/jobTypes.js';
import { resolveLeadSource } from '../db/leadSources.js';
import { setLeadCreated, setSelectedSlot } from '../db/callsessions.js';
import { sendHcpNotification } from '../emailNotificationService.js';
import type {
  HcpCallSessionRow,
  HcpContext,
  HcpCreateLeadInput,
  RetellFunctionResult,
} from '../types.js';

/**
 * Creates the lead, and retries once without `lead_source` when HCP rejects the
 * name ("Lead source not found"). Losing the attribution is better than losing
 * the caller's request.
 */
async function createLeadTolerantOfLeadSource(
  ctx: HcpContext,
  body: HcpCreateLeadInput,
  sessionId: string,
): Promise<Awaited<ReturnType<typeof createLead>>> {
  try {
    return await createLead(ctx, body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!body.lead_source || !/lead source not found/i.test(msg)) throw err;
    console.warn('[hcp] create_lead lead_source rejected by HCP — retrying without it', {
      sessionId,
      leadSource: body.lead_source,
    });
    const { lead_source: _rejected, ...withoutLeadSource } = body;
    return await createLead(ctx, withoutLeadSource);
  }
}

export async function handleCreateLead(
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

  // A lead carries no schedule in HCP, so the caller's part-of-day preference is
  // written into the note alongside the service type and their account.
  const note = resolveNotes(args, { label: 'Request', jobTypeAsIssueFallback: false });

  // The agent picks a job-type NAME from the tool enum; the uuid lives in our
  // table. An unknown name is dropped — never fail the lead over a classification.
  const jobTypeName = (args.job_type as string | undefined)?.trim() || null;
  const jobTypeUuid = await resolveJobTypeUuid(session.tenantId, jobTypeName).catch(() => null);
  if (jobTypeName && !jobTypeUuid) {
    console.warn('[hcp] create_lead unknown job_type — sending lead without one', {
      sessionId: session.sessionId,
      jobTypeName,
    });
  }

  // Attribution: the answer Clara collected when the dialed line is unmapped wins,
  // otherwise the tracking line behind the call.
  //
  // `lead_source` is a lead-source NAME, not an id: HCP looks the string up among
  // the account's configured lead sources and rejects the whole lead with
  // 400 "Lead source not found" when it doesn't match. So an unmapped line (or a
  // row with no lead_name) sends no lead_source at all — never an `lsrc_…` id.
  const spokenLeadSource = (args.lead_source as string | undefined)?.trim() || null;
  const dialedLead = spokenLeadSource
    ? null
    : await resolveLeadSource(session.leadSourceNumber ?? session.toNumber).catch(() => null);
  const leadSource = spokenLeadSource ?? dialedLead?.leadName ?? null;

  const body: HcpCreateLeadInput = {
    customer_id: customerId,
    address_id: addressId,
    note,
    tags: ['Clara'],
    ...(jobTypeUuid ? { job_type_uuid: jobTypeUuid } : {}),
    ...(leadSource ? { lead_source: leadSource } : {}),
  };

  // The caller's requested timeframe is kept for our own records only.
  const requestedStart = (args.scheduled_start as string | undefined)?.trim() || null;
  const requestedEnd = (args.scheduled_end as string | undefined)?.trim() || null;

  try {
    const lead = await createLeadTolerantOfLeadSource(ctx, body, session.sessionId);
    const leadNumber = typeof lead.number === 'number' ? lead.number : null;

    await insertLead(session.tenantId, {
      housecallproLeadId: lead.id,
      leadNumber,
      housecallproCustomerId: customerId,
      addressId,
      jobTypeUuid,
      sessionId: session.sessionId,
      requestedStart,
      requestedEnd,
    });

    await setLeadCreated(session.sessionId, lead.id, leadNumber, jobTypeUuid);
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
      kind: 'lead_created',
      emailTo: ctx.emailTo,
      ccMail: ctx.ccMail,
      details: {
        customerName: session.customerName ?? customer?.name ?? null,
        callbackNumber: session.caller,
        address: session.serviceAddressMap?.addresses?.[addressId]?.formatted ?? null,
        notes: note, // the same Service / Issue Description / timeframe block sent to HCP
        jobType: jobTypeName,
        leadNumber,
        leadId: lead.id,
      },
    }).catch(() => undefined);

    console.log('[hcp] create_lead created', {
      sessionId: session.sessionId,
      leadId: lead.id,
      leadNumber,
      jobTypeUuid,
      leadSource,
    });
    return {
      result: JSON.stringify({
        status: 'created',
        lead_id: lead.id,
        lead_number: leadNumber,
        scheduled: false,
      }),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[hcp] create_lead error', { sessionId: session.sessionId, error: msg });
    return { result: `error: lead creation failed — ${msg}` };
  }
}
