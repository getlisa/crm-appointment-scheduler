import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin as supabase } from '../lib/supabase.js';
import { env } from '../config/env.js';
import { resolveByInboundNumber, resolveByTenantId } from '../services/buildops/db/tenants.js';
import {
  createInboundCall,
  getInboundCall,
  setCallStatus,
  setMatchedCustomer,
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
import type { BuildOpsContext } from '../services/buildops/types.js';

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

async function resolveSession(callId: string) {
  const session = await getInboundCall(callId);
  if (!session) return null;
  const resolution = await resolveByTenantId(session.tenantId);
  if (!resolution) return null;
  const ctx: BuildOpsContext = {
    accessToken: resolution.access_token,
    buildopsTenantId: resolution.buildops_tenant_id,
    apiUrl: env.buildopsApiUrl,
  };
  return { session, ctx };
}

// ── Admin: register / update a tenant ────────────────────────────────────────

const TenantUpsertSchema = z.object({
  buildops_tenant_id: z.string().min(1),
  company_name: z.string().min(1),
  e164_no: z.string().regex(/^\+[1-9]\d{1,14}$/, 'Must be E.164 format, e.g. +15551234567'),
  is_active: z.boolean().optional().default(true),
  business_address: z.record(z.unknown()).optional(),
  billing_address: z.record(z.unknown()).optional(),
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

  const { error } = await supabase.from('buildops_tenants').upsert(
    {
      no: d.e164_no,
      buildops_tenant_id: d.buildops_tenant_id,
      company_name: d.company_name,
      is_active: d.is_active,
      business_address: d.business_address ?? null,
      billing_address: d.billing_address ?? null,
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

  res.json({ ok: true, buildops_tenant_id: d.buildops_tenant_id });
});

// ── Admin: list tenants (no secrets) ─────────────────────────────────────────

router.get('/admin/tenants', async (_req, res) => {
  const { data, error } = await supabase
    .from('buildops_tenants')
    .select('no, buildops_tenant_id, company_name, is_active')
    .order('company_name');

  if (error) {
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
    };
    const event = body?.event ?? '';

    if (event === 'call_inbound' || event === 'call_started') {
      const callId = body.call?.call_id ?? '';
      const toNumber = body.call?.to_number ?? '';
      const fromNumber = body.call?.from_number ?? '';

      const resolution = await resolveByInboundNumber(toNumber);
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

      const phoneLast10 = normalizePhoneLast10(fromNumber);
      const matches = phoneLast10
        ? await findCustomersByPhone(resolution.buildops_tenant_id, phoneLast10)
        : [];

      if (matches.length === 0) {
        res.json(buildInboundResponse('not_found', fromNumber));
        return;
      }

      if (matches.length === 1) {
        await setMatchedCustomer(callId, matches[0].id);
        const customer = matches[0];
        const properties = await getPropertiesByIds(customer.propertyIds);
        const primary = pickPrimaryAddress(customer, properties);
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
      if (callId) {
        await setCallStatus(callId, 'ended').catch(() => undefined);
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
    const payload = normalizedBuildopsPayload(req) as Record<string, unknown>;
    const callId = (payload?.call as Record<string, unknown>)?.call_id as string | undefined;
    const args = (payload?.args ?? payload?.arguments ?? {}) as Record<string, unknown>;
    if (!callId) { res.json({ result: 'error: call_id is required' }); return; }
    const resolved = await resolveSession(callId);
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
    const payload = normalizedBuildopsPayload(req) as Record<string, unknown>;
    const callId = (payload?.call as Record<string, unknown>)?.call_id as string | undefined;
    const args = (payload?.args ?? payload?.arguments ?? {}) as Record<string, unknown>;
    if (!callId) { res.json({ result: 'error: call_id is required' }); return; }
    const resolved = await resolveSession(callId);
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
    const payload = normalizedBuildopsPayload(req) as Record<string, unknown>;
    const callId = (payload?.call as Record<string, unknown>)?.call_id as string | undefined;
    const args = (payload?.args ?? payload?.arguments ?? {}) as Record<string, unknown>;
    if (!callId) { res.json({ result: 'error: call_id is required' }); return; }
    const resolved = await resolveSession(callId);
    if (!resolved) { res.json({ result: 'error: session not found' }); return; }
    res.json(await handleMatchProperty(resolved.session, args));
  } catch (err) {
    logBuildopsException('[buildops] fn/match_property', err);
    res.json({ result: 'error: internal' });
  }
});

/**
 * POST /api/buildops/fn/prepare_job
 * @body { call: { call_id }, args: { customer_property_id, status?, needs_review?, tasks? } }
 * @returns { result: string } — JSON: status created (job_id, job_number) | blocked (reason, message)
 */
router.post('/fn/prepare_job', async (req, res) => {
  try {
    const payload = normalizedBuildopsPayload(req) as Record<string, unknown>;
    const callId = (payload?.call as Record<string, unknown>)?.call_id as string | undefined;
    const args = (payload?.args ?? payload?.arguments ?? {}) as Record<string, unknown>;
    if (!callId) { res.json({ result: 'error: call_id is required' }); return; }
    const resolved = await resolveSession(callId);
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
    const payload = normalizedBuildopsPayload(req) as Record<string, unknown>;
    const callId = (payload?.call as Record<string, unknown>)?.call_id as string | undefined;
    const args = (payload?.args ?? payload?.arguments ?? {}) as Record<string, unknown>;
    if (!callId) { res.json({ result: 'error: call_id is required' }); return; }
    const resolved = await resolveSession(callId);
    if (!resolved) { res.json({ result: 'error: session not found' }); return; }
    res.json(await handleAddRepresentative(resolved.session, resolved.ctx, args));
  } catch (err) {
    logBuildopsException('[buildops] fn/add_representative', err);
    res.json({ result: 'error: internal' });
  }
});

export default router;
