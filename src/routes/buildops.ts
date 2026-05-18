import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin as supabase } from '../lib/supabase.js';
import { env } from '../config/env.js';
import { resolveByInboundNumber, resolveByTenantId } from '../services/buildops/db/tenants.js';
import {
  createInboundCall,
  findActiveByCallerAndTenant,
  getInboundCall,
  setCallStatus,
  setMatchedCustomer,
  updateRetellCallId,
} from '../services/buildops/db/inbound-calls.js';
import { findCustomersByPhone } from '../services/buildops/db/customers.js';
import { getPropertiesByIds } from '../services/buildops/db/properties.js';
import { normalizePhoneLast10, pickPrimaryAddress } from '../services/buildops/fuzzy-search.js';
import { handleLookupFuzzy } from '../services/buildops/handlers/fuzzy-lookup.js';
import {
  handleConfirmCustomer,
  handleMatchProperty,
} from '../services/buildops/handlers/customer.js';
import { handlePrepareJob } from '../services/buildops/handlers/job.js';
import { handleAddRepresentative } from '../services/buildops/handlers/representative.js';
import type { BuildOpsContext, InboundCallStatus } from '../services/buildops/types.js';

const router = Router();

// ── Shared helpers (following ServiceTitan router conventions) ────────────────

/** Retell / custom function runners sometimes send fields under `body.arguments`; otherwise use root. */
function normalizedBuildopsPayload(req: { body?: unknown }): unknown {
  const body = req.body as { arguments?: unknown } | undefined;
  return body?.arguments ?? body ?? {};
}

function logBuildopsException(context: string, error: unknown): void {
  if (error instanceof z.ZodError) {
    console.error(context, JSON.stringify(error.flatten()));
    return;
  }
  if (error instanceof Error) {
    console.error(context, error.message);
    if (error.stack) console.error(error.stack);
    return;
  }
  try {
    console.error(context, JSON.stringify(error));
  } catch {
    console.error(context, String(error));
  }
}

async function resolveSession(callId: string | undefined, fromNumber?: string, toNumber?: string) {
  let session = callId ? await getInboundCall(callId) : null;
  console.log('[buildops] resolveSession direct lookup', { callId, found: !!session });

  if (!session && fromNumber && toNumber) {
    const tenantRes = await resolveByInboundNumber(toNumber);
    if (tenantRes) {
      session = await findActiveByCallerAndTenant(tenantRes.buildops_tenant_id, fromNumber);
      console.log('[buildops] resolveSession fallback lookup', { fromNumber, toNumber, tenantId: tenantRes.buildops_tenant_id, found: !!session });
    }
  }

  if (!session) {
    console.warn('[buildops] resolveSession failed', { callId, fromNumber, toNumber });
    return null;
  }
  const resolution = await resolveByTenantId(session.tenantId);
  if (!resolution) return null;
  const ctx: BuildOpsContext = {
    accessToken: resolution.access_token,
    buildopsTenantId: resolution.buildops_tenant_id,
    apiUrl: env.buildopsApiUrl,
  };
  console.log('[buildops] resolveSession ok', { retellCallId: session.retellCallId, tenantId: session.tenantId, matchedCustomerId: session.matchedCustomerId });
  return { session, ctx };
}

// ── Admin: register / update a tenant ────────────────────────────────────────

const TenantUpsertSchema = z.object({
  no: z.string().regex(/^\+[1-9]\d{1,14}$/, 'Must be E.164 format, e.g. +15551234567'),
  buildops_tenant_id: z.string().min(1),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  access_token: z.string().min(1),
});

router.post('/admin/tenant', async (req, res) => {
  const parsed = TenantUpsertSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.format() });
    return;
  }

  const d = parsed.data;

  const { error } = await supabase
    .from('buildops_tenants')
    .upsert(
      {
        no: d.no,
        buildops_tenant_id: d.buildops_tenant_id,
        client_id: d.client_id,
        client_secret: d.client_secret,
        access_token: d.access_token,
      },
      { onConflict: 'no' },
    );

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ ok: true, no: d.no, buildops_tenant_id: d.buildops_tenant_id });
});

// ── Admin: list tenants (no secrets) ─────────────────────────────────────────

router.get('/admin/tenants', async (_req, res) => {
  const { data, error } = await supabase
    .from('buildops_tenants')
    .select('no, buildops_tenant_id')
    .order('no');

  if (error) {
    console.error('error:', error);
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ tenants: data });
});

// ── Retell lifecycle webhook ──────────────────────────────────────────────────

function buildInboundResponse(status: 'not_found' | 'error', fromNumber: string): object {
  return {
    call_inbound: {
      override_agent_id: env.retellLlmId ?? undefined,
      dynamic_variables: {
        status,
        identified: 'false',
        confidence: '0',
        customer_id: '',
        customer_name: '',
        from_number: fromNumber,
        new_number_detected: 'false',
        address_count: '0',
        addresses: '[]',
        multiple_matches: 'false',
      },
    },
  };
}

/**
 * POST /api/buildops/retell/webhook
 * Handles call_inbound / call_started (phone lookup → dynamic variables) and call_ended.
 *
 * @body { event: 'call_inbound' | 'call_started' | 'call_ended', call: { call_id, to_number, from_number } }
 */
router.post('/retell/webhook', async (req, res) => {
  try {
    const body = req.body as {
      event?: string;
      call?: { call_id?: string; to_number?: string; from_number?: string };
      call_inbound?: { from_number?: string; to_number?: string; agent_id?: string };
    };
    const event = body?.event ?? '';

    if (event === 'call_started') {
      const callId = body.call?.call_id ?? '';
      const toNumber = body.call?.to_number ?? '';
      const fromNumber = body.call?.from_number ?? '';
      console.log('[buildops] call_started', { callId, fromNumber, toNumber });

      if (callId && fromNumber && toNumber) {
        const resolution = await resolveByInboundNumber(toNumber);
        if (resolution) {
          const session = await findActiveByCallerAndTenant(
            resolution.buildops_tenant_id,
            fromNumber,
          );
          const needsSwap = session && session.retellCallId !== callId;
          console.log('[buildops] session swap', { found: !!session, oldId: session?.retellCallId, newId: callId, swapped: needsSwap });
          if (needsSwap) {
            await updateRetellCallId(session.retellCallId, callId);
          }
        }
      }
      res.json({ ok: true });
      return;
    }

    if (event === 'call_inbound') {
      const toNumber = body.call_inbound?.to_number ?? '';
      const fromNumber = body.call_inbound?.from_number ?? '';
      const callId = body.call?.call_id || crypto.randomUUID();
      console.log('[buildops] call_inbound', { callId, fromNumber, toNumber });

      const resolution = await resolveByInboundNumber(toNumber);
      console.log('[buildops] call_inbound tenant resolved', { toNumber, resolved: !!resolution, tenantId: resolution?.buildops_tenant_id });

      if (!resolution) {
        console.error(`[buildops] unknown inbound number: ${toNumber}`);
        res.json(buildInboundResponse('error', fromNumber));
        return;
      }

      await createInboundCall({
        retellCallId: callId,
        tenantId: resolution.buildops_tenant_id,
        caller: fromNumber,
      });
      console.log('[buildops] session created', { retellCallId: callId, tenantId: resolution.buildops_tenant_id, caller: fromNumber });

      const phoneLast10 = normalizePhoneLast10(fromNumber);
      const matches = phoneLast10
        ? await findCustomersByPhone(resolution.buildops_tenant_id, phoneLast10)
        : [];
      console.log('[buildops] phone lookup', { phoneLast10, matchCount: matches.length });

      if (matches.length === 0) {
        console.log('[buildops] call_inbound response', { status: 'not_found' });
        res.json(buildInboundResponse('not_found', fromNumber));
        return;
      }

      if (matches.length === 1) {
        await setMatchedCustomer(callId, matches[0].id);
        const customer = matches[0];
        const properties = await getPropertiesByIds(customer.propertyIds);
        const primary = pickPrimaryAddress(customer, properties);
        console.log('[buildops] call_inbound response', { status: 'found', customerId: customer.id, customerName: customer.name, propertyCount: properties.length });
        res.json({
          call_inbound: {
            override_agent_id: env.retellLlmId ?? undefined,
            dynamic_variables: {
              status: 'found',
              identified: 'true',
              confidence: '1.0',
              customer_id: customer.id,
              customer_name: customer.name,
              from_number: fromNumber,
              new_number_detected: 'false',
              address: primary.address ?? '',
              address_source: primary.addressSource ?? '',
              multiple_matches: 'false',
              property_count: String(properties.length),
              property_id: properties.length === 1 ? properties[0].id : '',
            },
          },
        });
        return;
      }

      console.log('[buildops] call_inbound response', { status: 'multiple_matches', matchCount: matches.length });
      res.json({
        call_inbound: {
          override_agent_id: env.retellLlmId ?? undefined,
          dynamic_variables: {
            status: 'multiple_matches',
            identified: 'false',
            confidence: '0',
            customer_id: '',
            customer_name: '',
            from_number: fromNumber,
            new_number_detected: 'false',
            address_count: '0',
            addresses: JSON.stringify(
              matches.map(m => ({
                name: m.name,
                id: m.id,
                address: m.businessAddress ?? m.billingAddress ?? null,
              })),
            ),
            multiple_matches: 'true',
            candidates_count: String(matches.length),
          },
        },
      });
      return;
    }

    if (event === 'call_ended') {
      const callId = body.call?.call_id;
      const fromNumber = body.call?.from_number ?? '';
      const toNumber = body.call?.to_number ?? '';
      const disconnectionReason = (body.call as Record<string, unknown> | undefined)?.disconnection_reason as string | undefined;
      const newStatus = (disconnectionReason ?? 'ended') as InboundCallStatus;
      console.log('[buildops] call_ended', { callId, fromNumber, toNumber, disconnectionReason, newStatus });
      if (callId) {
        await setCallStatus(callId, newStatus).catch(() => undefined);
      } else if (fromNumber && toNumber) {
        const resolution = await resolveByInboundNumber(toNumber);
        if (resolution) {
          const session = await findActiveByCallerAndTenant(resolution.buildops_tenant_id, fromNumber);
          if (session) await setCallStatus(session.retellCallId, newStatus).catch(() => undefined);
        }
      }
      res.json({ ok: true });
      return;
    }

    res.json({ ok: true });
  } catch (err) {
    logBuildopsException('[buildops] retell/webhook', err);
    res.json({ ok: true });
  }
});

// ── Custom function endpoints ─────────────────────────────────────────────────

/**
 * POST /api/buildops/fn/lookup_customer_fuzzy
 * @body { call: { call_id }, args: { name?, address?, property_address?, zip?, old_phone? } }
 * @returns { result: string } — JSON: status found | multiple_matches | not_found
 */
router.post('/fn/lookup_customer_fuzzy', async (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    const call = body?.call as Record<string, unknown> | undefined;
    const callId = call?.call_id as string | undefined;
    const fromNumber = call?.from_number as string | undefined;
    const toNumber = call?.to_number as string | undefined;
    console.log('[buildops] fn/lookup_customer_fuzzy called', { callId, fromNumber, toNumber });
    const args = normalizedBuildopsPayload(req) as Record<string, unknown>;
    const resolved = await resolveSession(callId, fromNumber, toNumber);
    if (!resolved) { res.json({ result: 'error: session not found' }); return; }
    res.json(await handleLookupFuzzy(resolved.session, args));
  } catch (err) {
    logBuildopsException('[buildops] fn/lookup_customer_fuzzy', err);
    res.json({ result: 'error: internal' });
  }
});

/**
 * POST /api/buildops/fn/confirm_customer
 * @body { call: { call_id }, args: { candidate_id: string } }
 * @returns { result: string } — JSON: status confirmed, customer, property_count
 */
router.post('/fn/confirm_customer', async (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    const call = body?.call as Record<string, unknown> | undefined;
    const callId = call?.call_id as string | undefined;
    const fromNumber = call?.from_number as string | undefined;
    const toNumber = call?.to_number as string | undefined;
    console.log('[buildops] fn/confirm_customer called', { callId, fromNumber, toNumber });
    const args = normalizedBuildopsPayload(req) as Record<string, unknown>;
    const resolved = await resolveSession(callId, fromNumber, toNumber);
    if (!resolved) { res.json({ result: 'error: session not found' }); return; }
    res.json(await handleConfirmCustomer(resolved.session, args));
  } catch (err) {
    logBuildopsException('[buildops] fn/confirm_customer', err);
    res.json({ result: 'error: internal' });
  }
});

/**
 * POST /api/buildops/fn/match_property
 * @body { call: { call_id }, args: { spoken_address: string } }
 * @returns { result: string } — JSON: status matched | ambiguous | not_found
 */
router.post('/fn/match_property', async (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    const call = body?.call as Record<string, unknown> | undefined;
    const callId = call?.call_id as string | undefined;
    const fromNumber = call?.from_number as string | undefined;
    const toNumber = call?.to_number as string | undefined;
    console.log('[buildops] fn/match_property called', { callId, fromNumber, toNumber });
    const args = normalizedBuildopsPayload(req) as Record<string, unknown>;
    const resolved = await resolveSession(callId, fromNumber, toNumber);
    if (!resolved) { res.json({ result: 'error: session not found' }); return; }
    res.json(await handleMatchProperty(resolved.session, args));
  } catch (err) {
    logBuildopsException('[buildops] fn/match_property', err);
    res.json({ result: 'error: internal' });
  }
});

/**
 * POST /api/buildops/fn/prepare_job
 * @body { call: { call_id }, args: { customer_property_id, status?, needs_review?, issue_description? } }
 * @returns { result: string } — JSON: status created (job_id, job_number) | blocked (reason, message)
 */
router.post('/fn/prepare_job', async (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    const call = body?.call as Record<string, unknown> | undefined;
    const callId = call?.call_id as string | undefined;
    const fromNumber = call?.from_number as string | undefined;
    const toNumber = call?.to_number as string | undefined;
    console.log('[buildops] fn/prepare_job called', { callId, fromNumber, toNumber });
    const args = normalizedBuildopsPayload(req) as Record<string, unknown>;
    const resolved = await resolveSession(callId, fromNumber, toNumber);
    if (!resolved) { res.json({ result: 'error: session not found' }); return; }
    res.json(await handlePrepareJob(resolved.session, resolved.ctx, args));
  } catch (err) {
    logBuildopsException('[buildops] fn/prepare_job', err);
    res.json({ result: 'error: internal' });
  }
});

/**
 * POST /api/buildops/fn/add_representative
 * @body { call: { call_id }, args: { first_name, last_name, phone?, email?, property_id? } }
 * @returns { result: string } — JSON: status added, representative_id, name
 */
router.post('/fn/add_representative', async (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    const call = body?.call as Record<string, unknown> | undefined;
    const callId = call?.call_id as string | undefined;
    const fromNumber = call?.from_number as string | undefined;
    const toNumber = call?.to_number as string | undefined;
    console.log('[buildops] fn/add_representative called', { callId, fromNumber, toNumber });
    const args = normalizedBuildopsPayload(req) as Record<string, unknown>;
    const resolved = await resolveSession(callId, fromNumber, toNumber);
    if (!resolved) { res.json({ result: 'error: session not found' }); return; }
    res.json(await handleAddRepresentative(resolved.session, resolved.ctx, args));
  } catch (err) {
    logBuildopsException('[buildops] fn/add_representative', err);
    res.json({ result: 'error: internal' });
  }
});

export default router;
