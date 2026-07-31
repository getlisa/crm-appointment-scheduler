/**
 * HouseCall Pro routes.
 *
 * Mounted at /api/housecallpro. Mirrors the BuildOps router:
 *   - POST /retell/webhook          — call_inbound (identify+greet) / call_started / call_ended
 *   - POST /fn/*                     — Retell custom-function tools
 *   - POST /admin/token, GET /admin/tokens, POST /sync — onboarding + manual sync
 *
 * Tenant resolution is by the dialed number (`no`) in housecallpro_tokens; the
 * per-tenant `agent_id` is returned as override_agent_id. Auth is a static API key.
 */

import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin as supabase } from '../lib/supabase.js';
import { resolveByInboundNumber, resolveByTenantId } from '../services/housecallpro/db/tokens.js';
import {
  createCallSession,
  getByRetellCallId,
  findActiveByCallerAndTenant,
  setRetellCallId,
  setLeadSourceNumber,
  setMatchedCustomer,
  setStatus,
} from '../services/housecallpro/db/callsessions.js';
import { findCustomersByPhone, buildCustomerRow } from '../services/housecallpro/db/customers.js';
import { normalizePhoneLast10 } from '../services/housecallpro/fuzzy-search.js';
import { diversionNumberFrom } from '../services/housecallpro/sip.js';
import { listCustomers } from '../services/housecallpro/client.js';
import { handleLookupFuzzy } from '../services/housecallpro/handlers/fuzzy-lookup.js';
import {
  handleConfirmCustomer,
  handleCreateCustomer,
  handleMatchAddress,
  handleCreateAddress,
} from '../services/housecallpro/handlers/customer.js';
import { handleBookJob } from '../services/housecallpro/handlers/job.js';
import { handleEscalate } from '../services/housecallpro/handlers/escalate.js';
import type { HcpContext, HcpCallStatus, HcpCallSessionRow } from '../services/housecallpro/types.js';
import type { Request, Response } from 'express';

const router = Router();

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Retell sends function args under body.arguments (args_at_root:false) or at root. */
function normalizedHcpPayload(req: { body?: unknown }): Record<string, unknown> {
  const body = req.body as { arguments?: unknown; args?: unknown } | undefined;
  return (body?.arguments ?? body?.args ?? body ?? {}) as Record<string, unknown>;
}

function logHcpException(context: string, error: unknown): void {
  if (error instanceof z.ZodError) {
    console.error(context, JSON.stringify(error.flatten()));
    return;
  }
  if (error instanceof Error) {
    console.error(context, error.message);
    if (error.stack) console.error(error.stack);
    return;
  }
  console.error(context, String(error));
}

async function resolveSession(callId: string | undefined, fromNumber?: string, toNumber?: string) {
  let session = callId ? await getByRetellCallId(callId) : null;
  console.log('[hcp] resolveSession direct lookup', { callId, found: !!session });

  if (!session && fromNumber && toNumber) {
    const token = await resolveByInboundNumber(toNumber);
    if (token) session = await findActiveByCallerAndTenant(token.tenantId, fromNumber);
    console.log('[hcp] resolveSession fallback lookup', { fromNumber, toNumber, tenantId: token?.tenantId, found: !!session });
  }

  if (!session) {
    console.warn('[hcp] resolveSession failed', { callId, fromNumber, toNumber });
    return null;
  }

  const token = await resolveByTenantId(session.tenantId);
  if (!token) {
    console.warn('[hcp] resolveSession token missing', { sessionId: session.sessionId, tenantId: session.tenantId });
    return null;
  }

  const ctx: HcpContext = {
    apiKey: token.apiKey,
    tenantId: token.tenantId,
    emailTo: token.emailTo,
    ccMail: token.ccMail,
  };
  console.log('[hcp] resolveSession ok', {
    sessionId: session.sessionId,
    retellCallId: session.retellCallId,
    tenantId: session.tenantId,
    matchedCustomerId: session.housecallproCustomerId,
  });
  return { session, ctx };
}

function buildInboundResponse(
  status: 'not_found' | 'error',
  fromNumber: string,
  agentId: string | null,
  newNumberDetected = false,
  leadSourceNumber = '',
): object {
  return {
    call_inbound: {
      override_agent_id: agentId ?? undefined,
      dynamic_variables: {
        status,
        identified: 'false',
        customer_id: '',
        customer_name: '',
        caller_name: '',
        first_name: '',
        last_name: '',
        lead_source_number: leadSourceNumber,
        from_number: fromNumber,
        new_number_detected: String(newNumberDetected),
        multiple_matches: 'false',
        candidates_count: '0',
        candidates: '[]',
      },
    },
  };
}

// ── Admin: register / update a tenant token ───────────────────────────────────

const TokenUpsertSchema = z.object({
  no: z.string().min(1),
  tenant_id: z.string().uuid().optional(),
  api_key: z.string().min(1),
  agent_id: z.string().min(1).optional(),
  name: z.string().optional(),
  emailto: z.string().optional(),
  ccMail: z.string().optional(),
});

router.post('/admin/token', async (req, res) => {
  const parsed = TokenUpsertSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.format() });
    return;
  }
  const d = parsed.data;
  const row: Record<string, unknown> = { no: d.no, api_key: d.api_key };
  if (d.tenant_id) row.tenant_id = d.tenant_id;
  if (d.agent_id) row.agent_id = d.agent_id;
  if (d.name) row.name = d.name;
  if (d.emailto !== undefined) row.emailto = d.emailto;
  if (d.ccMail !== undefined) row.ccMail = d.ccMail;

  const { error } = await supabase.from('housecallpro_tokens').upsert(row, { onConflict: 'no' });
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ ok: true, no: d.no });
});

router.get('/admin/tokens', async (_req, res) => {
  const { data, error } = await supabase
    .from('housecallpro_tokens')
    .select('no, tenant_id, agent_id, name')
    .order('no');
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ tokens: data });
});

// ── Admin: sync progress (cached counts + cursor per tenant) ──────────────────

router.get('/admin/sync-status', async (_req, res) => {
  const { data: tokens, error } = await supabase
    .from('housecallpro_tokens')
    .select('no, tenant_id, name, sync_customer_page')
    .order('no');
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  const tenants = await Promise.all(
    (tokens ?? []).map(async (t: Record<string, unknown>) => {
      const tenantId = t.tenant_id as string;
      const { count } = await supabase
        .from('housecallpro_customers')
        .select('*', { count: 'exact', head: true })
        .eq('tenant_id', tenantId);
      return {
        no: t.no as string,
        name: (t.name as string | null) ?? null,
        tenant_id: tenantId,
        sync_customer_page: (t.sync_customer_page as number | null) ?? 1,
        cached_customers: count ?? 0,
      };
    }),
  );

  res.json({ tenants });
});

// ── Admin: manual full customer ingestion (first-time / on-demand) ────────────

router.post('/sync', async (req, res) => {
  try {
    const no = (req.query.no as string | undefined) ?? (req.body?.no as string | undefined);
    if (!no) {
      res.status(400).json({ error: 'no (dialed number) is required' });
      return;
    }
    const token = await resolveByInboundNumber(no);
    if (!token) {
      res.status(404).json({ error: `unknown number: ${no}` });
      return;
    }
    const ctx: HcpContext = { apiKey: token.apiKey, tenantId: token.tenantId, emailTo: token.emailTo, ccMail: token.ccMail };

    let page = 1;
    let totalPages = 1;
    let upserted = 0;
    do {
      const resp = await listCustomers(ctx, page, 100);
      totalPages = resp.total_pages ?? 1;
      const rows = (resp.customers ?? []).map(c => buildCustomerRow(token.tenantId, c));
      if (rows.length > 0) {
        for (let i = 0; i < rows.length; i += 200) {
          const { error } = await supabase
            .from('housecallpro_customers')
            .upsert(rows.slice(i, i + 200), { onConflict: 'tenant_id,housecallpro_customer_id' });
          if (error) throw new Error(error.message);
        }
        upserted += rows.length;
      }
      page++;
    } while (page <= totalPages);

    res.json({ ok: true, tenant_id: token.tenantId, pages: totalPages, customers_upserted: upserted });
  } catch (err) {
    logHcpException('[hcp] sync', err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Retell lifecycle webhook ──────────────────────────────────────────────────

router.post('/retell/webhook', async (req, res) => {
  try {
    const body = req.body as {
      event?: string;
      call?: {
        call_id?: string;
        to_number?: string;
        from_number?: string;
        disconnection_reason?: string;
        custom_sip_headers?: Record<string, unknown>;
        retell_llm_dynamic_variables?: Record<string, unknown>;
      };
      call_inbound?: {
        from_number?: string;
        to_number?: string;
        agent_id?: string;
        custom_sip_headers?: Record<string, unknown>;
      };
    };
    const event = body?.event ?? '';

    if (event === 'call_started') {
      // TEMP (remove after verifying diversion payload shape — see plan Step 0):
      console.log('[hcp] RAW call_started', JSON.stringify(req.body));
      const callId = body.call?.call_id ?? '';
      const toNumber = body.call?.to_number ?? '';
      const fromNumber = body.call?.from_number ?? '';
      console.log('[hcp] call_started req', { callId, fromNumber, toNumber });
      if (callId && fromNumber && toNumber) {
        const token = await resolveByInboundNumber(toNumber);
        if (token) {
          const session = await findActiveByCallerAndTenant(token.tenantId, fromNumber);
          if (session) {
            if (session.retellCallId !== callId) {
              await setRetellCallId(session.sessionId, callId);
            }
            // The SIP Diversion header (the real HCP tracking line) is reliably
            // present as a dynamic variable by call_started. Backfill it onto the
            // session for lead-source attribution if call_inbound didn't capture it.
            if (!session.leadSourceNumber) {
              const leadSourceNumber =
                diversionNumberFrom(body.call?.retell_llm_dynamic_variables) ??
                diversionNumberFrom(body.call?.custom_sip_headers);
              if (leadSourceNumber) {
                console.log('[hcp] call_started captured lead_source_number', { callId, leadSourceNumber });
                await setLeadSourceNumber(session.sessionId, leadSourceNumber);
              }
            }
          }
        }
      }
      console.log('[hcp] call_started resp', { ok: true });
      res.json({ ok: true });
      return;
    }

    if (event === 'call_inbound') {
      // TEMP (remove after verifying diversion payload shape — see plan Step 0):
      console.log('[hcp] RAW call_inbound', JSON.stringify(req.body));
      const toNumber = body.call_inbound?.to_number ?? '';
      const fromNumber = body.call_inbound?.from_number ?? '';
      const callId = body.call?.call_id;

      // The dialed HCP tracking line (the lead source) rides in the SIP Diversion
      // header, not to_number (which is the shared DID). Parse it if present; the
      // call_started handler backfills it if it's not available yet here.
      const leadSourceNumber =
        diversionNumberFrom(body.call_inbound?.custom_sip_headers) ??
        diversionNumberFrom(body.call?.custom_sip_headers) ??
        diversionNumberFrom(body.call?.retell_llm_dynamic_variables);
      // The value surfaced to the agent + used for attribution downstream.
      const resolvedLeadSourceNumber = leadSourceNumber ?? toNumber;
      console.log('[hcp] call_inbound req', { callId, fromNumber, toNumber, leadSourceNumber });

      const token = await resolveByInboundNumber(toNumber);
      if (!token) {
        console.error(`[hcp] unknown inbound number: ${toNumber}`);
        const errorResp = buildInboundResponse('error', fromNumber, null, false, resolvedLeadSourceNumber);
        console.log('[hcp] call_inbound resp', errorResp);
        res.json(errorResp);
        return;
      }

      const session = await createCallSession({
        tenantId: token.tenantId,
        caller: fromNumber,
        toNumber,
        leadSourceNumber,
        retellCallId: callId ?? null,
      });

      const phoneLast10 = fromNumber ? normalizePhoneLast10(fromNumber) : '';
      const matches = phoneLast10 ? await findCustomersByPhone(token.tenantId, phoneLast10) : [];
      console.log('[hcp] phone lookup', { phoneLast10, matchCount: matches.length });

      if (matches.length === 0) {
        const notFoundResp = buildInboundResponse('not_found', fromNumber, token.agentId, true, resolvedLeadSourceNumber);
        console.log('[hcp] call_inbound resp', notFoundResp);
        res.json(notFoundResp);
        return;
      }

      if (matches.length === 1) {
        const customer = matches[0];
        await setMatchedCustomer(session.sessionId, customer.housecallproCustomerId, customer.name, 'phone');
        const foundResp = {
          call_inbound: {
            override_agent_id: token.agentId ?? undefined,
            dynamic_variables: {
              status: 'found',
              identified: 'true',
              customer_id: customer.housecallproCustomerId,
              customer_name: customer.name,
              caller_name: customer.firstName ?? customer.name,
              first_name: customer.firstName ?? '',
              last_name: customer.lastName ?? '',
              lead_source_number: resolvedLeadSourceNumber,
              from_number: fromNumber,
              new_number_detected: 'false',
              multiple_matches: 'false',
              candidates_count: '0',
              candidates: '[]',
            },
          },
        };
        console.log('[hcp] call_inbound resp', foundResp);
        res.json(foundResp);
        return;
      }

      // 2+ matches — let the agent disambiguate
      const multiResp = {
        call_inbound: {
          override_agent_id: token.agentId ?? undefined,
          dynamic_variables: {
            status: 'multiple_matches',
            identified: 'false',
            customer_id: '',
            customer_name: '',
            caller_name: '',
            first_name: '',
            last_name: '',
            lead_source_number: resolvedLeadSourceNumber,
            from_number: fromNumber,
            new_number_detected: 'false',
            multiple_matches: 'true',
            candidates_count: String(matches.length),
            candidates: JSON.stringify(
              matches.map(m => ({ id: m.housecallproCustomerId, name: m.name })),
            ),
          },
        },
      };
      console.log('[hcp] call_inbound resp', multiResp);
      res.json(multiResp);
      return;
    }

    if (event === 'call_ended') {
      const callId = body.call?.call_id;
      const fromNumber = body.call?.from_number ?? '';
      const toNumber = body.call?.to_number ?? '';
      const disconnectionReason = body.call?.disconnection_reason;
      const newStatus = (disconnectionReason ?? 'ended') as HcpCallStatus;
      console.log('[hcp] call_ended req', { callId, fromNumber, toNumber, disconnectionReason, newStatus });

      let session = callId ? await getByRetellCallId(callId) : null;
      if (!session && fromNumber && toNumber) {
        const token = await resolveByInboundNumber(toNumber);
        if (token) session = await findActiveByCallerAndTenant(token.tenantId, fromNumber);
      }
      if (session) await setStatus(session.sessionId, newStatus).catch(() => undefined);
      console.log('[hcp] call_ended resp', { ok: true, sessionFound: !!session });
      res.json({ ok: true });
      return;
    }

    res.json({ ok: true });
  } catch (err) {
    logHcpException('[hcp] retell/webhook', err);
    res.json({ ok: true });
  }
});

// ── Custom function endpoints ─────────────────────────────────────────────────

/** Shared wrapper: resolve session → run handler → return { result }. */
function fnRoute(
  name: string,
  handler: (
    resolved: { session: HcpCallSessionRow; ctx: HcpContext },
    args: Record<string, unknown>,
  ) => Promise<{ result: string }>,
) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const body = req.body as Record<string, unknown>;
      const call = body?.call as Record<string, unknown> | undefined;
      const callId = call?.call_id as string | undefined;
      const fromNumber = call?.from_number as string | undefined;
      const toNumber = call?.to_number as string | undefined;
      const args = normalizedHcpPayload(req);
      console.log(`[hcp] fn/${name} req`, { callId, fromNumber, toNumber, args });

      const resolved = await resolveSession(callId, fromNumber, toNumber);
      if (!resolved) {
        console.log(`[hcp] fn/${name} resp`, { result: 'error: session not found' });
        res.json({ result: 'error: session not found' });
        return;
      }
      const result = await handler(resolved, args);
      console.log(`[hcp] fn/${name} resp`, { callId, result: result.result });
      res.json(result);
    } catch (err) {
      logHcpException(`[hcp] fn/${name}`, err);
      res.json({ result: 'error: internal' });
    }
  };
}

router.post('/fn/lookup_customer_fuzzy', fnRoute('lookup_customer_fuzzy', ({ session }, args) => handleLookupFuzzy(session, args)));
router.post('/fn/confirm_customer', fnRoute('confirm_customer', ({ session }, args) => handleConfirmCustomer(session, args)));
router.post('/fn/create_customer', fnRoute('create_customer', ({ session, ctx }, args) => handleCreateCustomer(session, ctx, args)));
router.post('/fn/match_address', fnRoute('match_address', ({ session, ctx }, args) => handleMatchAddress(session, ctx, args)));
router.post('/fn/create_address', fnRoute('create_address', ({ session, ctx }, args) => handleCreateAddress(session, ctx, args)));
router.post('/fn/book_job', fnRoute('book_job', ({ session, ctx }, args) => handleBookJob(session, ctx, args)));
router.post('/fn/escalate', fnRoute('escalate', ({ session, ctx }, args) => handleEscalate(session, ctx, args)));

export default router;
