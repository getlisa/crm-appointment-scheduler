/**
 * Express router for the BuildOps Retell webhook endpoint (POST /api/buildops/retell/webhook).
 * Handles three event types:
 *   call_inbound / call_started — resolves tenant, runs phone lookup, sets dynamic variables
 *   call_ended                  — marks the call session as ended
 *   tool_call / agent_function  — delegates to handleFunctionCall in src/lib/retell.ts
 */

import { Router } from 'express';
import { env } from '../../../config/env.js';
import { resolveByInboundNumber } from '../db/tenants.js';
import { findCustomersByPhone } from '../db/customers.js';
import { getPropertiesForCustomer } from '../db/properties.js';
import {
  createInboundCall,
  getInboundCall,
  setCallStatus,
  setMatchedCustomer,
} from '../db/inbound-calls.js';
import { normalizePhoneLast10 } from '../fuzzy-search.js';
import { handleFunctionCall } from '../../../lib/retell.js';
import type { RetellWebhookBody } from '../types.js';

const retellRouter = Router();

function buildContext(resolution: { access_token: string; buildops_tenant_id: string }) {
  return {
    accessToken: resolution.access_token,
    buildopsTenantId: resolution.buildops_tenant_id,
    apiUrl: env.buildopsApiUrl,
  };
}

retellRouter.post('/webhook', async (req, res) => {
  try {
    const body = req.body as RetellWebhookBody;
    const event = body?.event ?? '';

    // ── Inbound call: resolve tenant, phone-lookup caller, set dynamic vars ──
    if (event === 'call_inbound' || event === 'call_started') {
      const { call_id: callId, to_number: toNumber, from_number: fromNumber } = body.call;

      const resolution = await resolveByInboundNumber(toNumber);
      if (!resolution) {
        console.error(`[retell] unknown inbound number: ${toNumber}`);
        // Still return a structured response so Retell agent can proceed
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

      // No phone match — agent will run tiered fuzzy search
      if (matches.length === 0) {
        res.json(buildInboundResponse('not_found', fromNumber));
        return;
      }

      // Single match — auto-confirm customer so agent skips confirm step
      if (matches.length === 1) {
        await setMatchedCustomer(callId, matches[0].id);
        const customer = matches[0];
        const properties = await getPropertiesForCustomer(customer.id);
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
              address_count: String(customer.addresses?.length ?? 0),
              addresses: JSON.stringify(customer.addresses ?? []),
              multiple_matches: 'false',
              property_count: String(properties.length),
              property_id: properties.length === 1 ? properties[0].id : '',
            },
          },
        });
        return;
      }

      // Multiple matches — agent will call confirm_customer to disambiguate
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
            addresses: JSON.stringify(matches.map(m => ({
              name: m.name,
              id: m.id,
              address: m.addresses?.[0] ?? null,
            }))),
            multiple_matches: 'true',
            candidates_count: String(matches.length),
          },
        },
      });
      return;
    }

    // ── Call ended ────────────────────────────────────────────────────────────
    if (event === 'call_ended') {
      const callId = body.call?.call_id;
      if (callId) {
        await setCallStatus(callId, 'ended').catch(() => undefined);
      }
      res.json({ ok: true });
      return;
    }

    // ── Tool / function calls ──────────────────────────────────────────────────
    if (event === 'tool_call' || event === 'agent_function' || body.name !== undefined) {
      const result = await handleFunctionCall(body);
      res.json(result);
      return;
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[retell] webhook error:', err);
    res.json({ ok: true });
  }
});

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

export default retellRouter;
