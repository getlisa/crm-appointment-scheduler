/**
 * Retell webhook dispatcher for BuildOps function calls.
 * Receives tool_call / agent_function events, retrieves the active call session,
 * resolves fresh tenant credentials, and routes to the appropriate handler by function name.
 * Also handles call_started and call_ended lifecycle events.
 */

import { env } from '../config/env.js';
import { resolveByInboundNumber, resolveByTenantId } from '../services/buildops/db/tenants.js';
import {
  createInboundCall,
  getInboundCall,
  setCallStatus,
} from '../services/buildops/db/inbound-calls.js';
import { handleLookupByPhone } from '../services/buildops/handlers/phone-lookup.js';
import { handleLookupFuzzy } from '../services/buildops/handlers/fuzzy-lookup.js';
import {
  handleConfirmCustomer,
  handleGetProperties,
  handleMatchProperty,
} from '../services/buildops/handlers/customer.js';
import {
  handlePrepareJob,
  handleAddTaskToJob,
} from '../services/buildops/handlers/job.js';
import {
  handleSaveCallerNumber,
  handleAddRepresentative,
} from '../services/buildops/handlers/representative.js';
import { handleTransferCall } from '../services/buildops/handlers/transfer.js';
import type {
  RetellWebhookBody,
  RetellFunctionResult,
  BuildOpsContext,
} from '../services/buildops/types.js';

function buildContext(resolution: {
  access_token: string;
  buildops_tenant_id: string;
}): BuildOpsContext {
  return {
    accessToken: resolution.access_token,
    buildopsTenantId: resolution.buildops_tenant_id,
    apiUrl: env.buildopsApiUrl,
  };
}

async function handleCallStarted(
  body: RetellWebhookBody,
): Promise<{ ok: boolean; message?: string }> {
  const { call_id: callId, to_number: toNumber, from_number: fromNumber } = body.call;

  const resolution = await resolveByInboundNumber(toNumber);
  if (!resolution) {
    console.error(`[retell] unknown inbound number: ${toNumber}`);
    return { ok: false, message: 'Tenant not configured for this number.' };
  }

  await createInboundCall({
    retellCallId: callId,
    tenantId: resolution.buildops_tenant_id,
    caller: fromNumber,
  });

  return { ok: true };
}

/**
 * Dispatches a Retell function/tool call to the appropriate buildops handler.
 * Looks up the call session by call_id and resolves tenant credentials before dispatching.
 *
 * @param body - Raw Retell webhook payload (tool_call or agent_function event)
 * @returns RetellFunctionResult with a JSON-serialized result string
 */
export async function handleFunctionCall(body: RetellWebhookBody): Promise<RetellFunctionResult> {
  const callId = body.call.call_id;
  const functionName = body.name ?? '';
  const args = (body.args ?? body.arguments ?? {}) as Record<string, unknown>;

  const session = await getInboundCall(callId);
  if (!session) {
    return { result: 'error: session not found — call may not have been initialized' };
  }

  const resolution = await resolveByTenantId(session.tenantId);
  if (!resolution) {
    return { result: 'error: tenant configuration not found' };
  }
  const ctx = buildContext(resolution);

  switch (functionName) {
    case 'lookup_customer_by_phone':
      return handleLookupByPhone(session);

    case 'lookup_customer_fuzzy':
      return handleLookupFuzzy(session, args);

    case 'confirm_customer':
      return handleConfirmCustomer(session, args);

    case 'get_properties_for_customer':
      return handleGetProperties(session);

    case 'match_property':
      return handleMatchProperty(session, args);

    case 'prepare_job':
      return handlePrepareJob(session, ctx, args);

    case 'save_caller_number':
      return handleSaveCallerNumber(session, ctx, args);

    case 'add_representative':
      return handleAddRepresentative(session, ctx, args);

    case 'transfer_call':
      return handleTransferCall(session, args);

    case 'add_task_to_job':
      return handleAddTaskToJob(session, ctx, args);

    default:
      return { result: `error: unknown function "${functionName}"` };
  }
}

/**
 * Top-level webhook handler. Routes call lifecycle events and function calls.
 * Used by server routes that don't go through the retell/index.ts Express router.
 *
 * @param rawBody - Raw request body parsed from the Retell webhook
 * @returns Function result or {ok, message} for lifecycle events
 */
export async function handleRetellWebhook(
  rawBody: unknown,
): Promise<RetellFunctionResult | { ok: boolean; message?: string }> {
  const body = rawBody as RetellWebhookBody;
  const event = body?.event ?? '';

  if (event === 'call_started' || event === 'call_inbound') {
    return handleCallStarted(body);
  }

  if (event === 'call_ended') {
    const callId = body.call?.call_id;
    if (callId) {
      await setCallStatus(callId, 'ended').catch(() => undefined);
    }
    return { ok: true };
  }

  // Function/tool call events
  if (event === 'tool_call' || event === 'agent_function' || body.name !== undefined) {
    return handleFunctionCall(body);
  }

  return { ok: true };
}
