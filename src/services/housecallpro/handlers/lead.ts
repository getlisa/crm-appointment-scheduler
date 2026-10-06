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

import { createAddress, createLead } from '../client.js';
import { resolveNotes } from '../requestNotes.js';
import { normalizeEmail } from '../email.js';
import { insertLead } from '../db/leads.js';
import { getCustomerByHcpId, upsertCustomer } from '../db/customers.js';
import { resolveJobTypeName, resolveJobTypeUuid } from '../db/jobTypes.js';
import { setLeadCreated, setMatchedCustomer, setSelectedSlot } from '../db/callsessions.js';
import { sendHcpNotification } from '../emailNotificationService.js';
import type {
  HcpCallSessionRow,
  HcpContext,
  HcpCreateLeadInput,
  RetellFunctionResult,
} from '../types.js';

/**
 * Lead source stamped on a lead whose dialed line maps to no configured source.
 * Must exist in the tenant's HCP lead sources; if it doesn't, HCP rejects the
 * name and the lead is retried without it.
 */
const AGENT_LEAD_SOURCE = 'Clara';

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

  // A new caller has no customer yet: HCP creates one from an inline object as a
  // side effect of the lead, which is why there is no separate create_customer step.
  const firstName = (args.first_name as string | undefined)?.trim();
  const lastName = (args.last_name as string | undefined)?.trim();
  if (!customerId && !firstName && !lastName) {
    return { result: 'error: no customer — identify the caller first, or pass first_name and last_name' };
  }

  const addressId =
    (args.address_id as string | undefined)?.trim() ||
    session.serviceAddressMap?.selectedAddressId ||
    undefined;

  const street = (args.street as string | undefined)?.trim();
  const city = (args.city as string | undefined)?.trim();
  const state = (args.state as string | undefined)?.trim();
  const zip = (args.zip as string | undefined)?.trim();
  const hasInlineAddress = Boolean(street && city && state && zip);

  if (!addressId && !hasInlineAddress) {
    return {
      result: customerId
        ? 'error: no address selected — call match_address or create_address first'
        : 'error: no address — pass street, city, state and zip',
    };
  }

  // A lead carries no schedule in HCP, so the caller's part-of-day preference is
  // written into the note alongside the service type and their account.
  let note = resolveNotes(args, { label: 'Request', jobTypeAsIssueFallback: false });

  // Classification normally arrives earlier in the call via set_job_type, which
  // pins the uuid to the session. A job_type argument is still honoured as a
  // fallback when that call was skipped. Either way an unresolved name is
  // dropped — never fail the lead over a classification.
  const spokenJobType = (args.job_type as string | undefined)?.trim() || null;
  const jobTypeUuid =
    session.jobTypeUuid ??
    (await resolveJobTypeUuid(session.tenantId, spokenJobType).catch(() => null));
  if (!jobTypeUuid) {
    console.warn('[hcp] create_lead has no job type — sending lead without one', {
      sessionId: session.sessionId,
      spokenJobType,
    });
  }
  const jobTypeName =
    spokenJobType ?? (await resolveJobTypeName(session.tenantId, jobTypeUuid).catch(() => null));

  // Attribution. `lead_source` is a lead-source NAME, not an id: HCP looks the
  // string up among the account's configured lead sources and rejects the whole
  // lead with 400 "Lead source not found" when it doesn't match. So only a name
  // the account actually has is ever sent — and never an `lsrc_…` id.
  //
  // The dialed tracking line is the authority: it is a fact about which number
  // rang, resolved once at call start and pinned to the session, and it beats
  // anything said on the call.
  //
  // When that line maps to nothing, the attribution is stamped AGENT_LEAD_SOURCE —
  // one fixed name meaning "this call came in through Clara, not a tracked line".
  // Clara also asks the caller where they heard of us; their answer is free text
  // that cannot be trusted as an HCP name, so it goes on the note instead, where
  // the office reads it.
  const spokenLeadSource = (args.lead_source as string | undefined)?.trim() || null;

  // The spoken answer is deliberately NOT used as attribution, even when it
  // names a configured source exactly.
  //
  // On call_69ba94bf the agent sent lead_source "Google" having never asked the
  // question — the caller said no such thing. An invented answer written into
  // HCP's lead_source is marketing data Laura would act on; the same answer in
  // the note is visibly a note. Only the dialed tracking line, which is a fact
  // about which number rang, is trusted as attribution.
  const leadSource = session.leadSourceName ?? AGENT_LEAD_SOURCE;

  if (spokenLeadSource) {
    note += `\nHeard about us :- ${spokenLeadSource}`;
  }

  const body: HcpCreateLeadInput = {
    ...(customerId
      ? { customer_id: customerId }
      : {
          customer: {
            ...(firstName ? { first_name: firstName } : {}),
            ...(lastName ? { last_name: lastName } : {}),
            // Dropped rather than sent raw: a spoken email is a 400 from HCP.
            ...(normalizeEmail(args.email as string | undefined)
              ? { email: normalizeEmail(args.email as string | undefined)! }
              : {}),
            mobile_number:
              (args.mobile_number as string | undefined)?.trim() || session.caller,
            ...((args.company as string | undefined)?.trim()
              ? { company: (args.company as string).trim() }
              : {}),
          },
        }),
    ...(addressId
      ? { address_id: addressId }
      : { address: { street: street!, city: city!, state: state!, zip: zip! } }),
    note,
    tags: ['Clara'],
    ...(jobTypeUuid ? { job_type_uuid: jobTypeUuid } : {}),
    lead_source: leadSource,
  };

  // The caller's requested timeframe is kept for our own records only.
  const requestedStart = (args.scheduled_start as string | undefined)?.trim() || null;
  const requestedEnd = (args.scheduled_end as string | undefined)?.trim() || null;

  try {
    const lead = await createLeadTolerantOfLeadSource(ctx, body, session.sessionId);
    const leadNumber = typeof lead.number === 'number' ? lead.number : null;

    // HCP created the customer as a side effect. Adopt it before anything else:
    // housecallpro_leads has a foreign key onto the customer cache, and
    // customer_lookup reads that cache, so without this the caller is a stranger
    // on their next call and gets a duplicate.
    let effectiveCustomerId = customerId;
    let savedAddressId: string | null = addressId ?? null;
    if (!effectiveCustomerId && lead.customer?.id) {
      effectiveCustomerId = lead.customer.id;
      await upsertCustomer(session.tenantId, lead.customer).catch(() => null);
      const createdName = [lead.customer.first_name, lead.customer.last_name]
        .filter(Boolean)
        .join(' ')
        .trim();
      await setMatchedCustomer(session.sessionId, lead.customer.id, createdName, 'new_customer')
        .catch(() => undefined);

      // The inline `address` lives on the lead as text only — HCP saves no
      // customer address record for it. Create one so the office has a real
      // address to dispatch to when the lead is converted.
      if (hasInlineAddress) {
        const addr = await createAddress(ctx, lead.customer.id, {
          street: street!,
          city: city!,
          state: state!,
          zip: zip!,
          // HCP rejects an address with 422 "Country is required" without this.
          country: (args.country as string | undefined)?.trim() || 'US',
        }).catch((err) => {
          console.warn('[hcp] create_lead could not save the address on the new customer', {
            sessionId: session.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        });
        savedAddressId = addr?.id ?? null;
      }
    }

    if (!effectiveCustomerId) {
      console.error('[hcp] create_lead has no customer id to persist', {
        sessionId: session.sessionId,
        leadId: lead.id,
      });
    }

    await insertLead(session.tenantId, {
      housecallproLeadId: lead.id,
      leadNumber,
      housecallproCustomerId: effectiveCustomerId!,
      addressId: savedAddressId,
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
    const customer = effectiveCustomerId
      ? await getCustomerByHcpId(session.tenantId, effectiveCustomerId).catch(() => null)
      : null;
    sendHcpNotification({
      kind: 'lead_created',
      emailTo: ctx.emailTo,
      ccMail: ctx.ccMail,
      details: {
        customerName: session.customerName ?? customer?.name ?? null,
        callbackNumber: session.caller,
        address:
          (addressId ? session.serviceAddressMap?.addresses?.[addressId]?.formatted : null) ??
          (hasInlineAddress ? `${street}, ${city}, ${state} ${zip}` : null),
        notes: note, // the same Service / Issue Description / timeframe block sent to HCP
        jobType: jobTypeName,
        leadNumber,
        leadId: lead.id,
      },
    }).catch(() => undefined);

    // POST /leads does NOT reject an unconfigured lead source the way POST /jobs
    // does — it accepts the request and returns the lead with lead_source null.
    // The retry above can therefore never fire for that case, so compare what came
    // back: a mismatch means the name is missing from the account's lead sources.
    if (leadSource && lead.lead_source !== leadSource) {
      console.warn('[hcp] create_lead lead source silently dropped by HCP — not configured on the account', {
        sessionId: session.sessionId,
        leadId: lead.id,
        sent: leadSource,
        returned: lead.lead_source ?? null,
      });
    }

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
