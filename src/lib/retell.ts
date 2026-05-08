import { env } from '../config/env.js';
import { resolveByInboundNumber } from '../services/buildops/db/tenants.js';
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
import { handleGetPricebookItems } from '../services/buildops/handlers/pricebook.js';
import {
  handleGetJobTypes,
  handleGetDepartments,
} from '../services/buildops/handlers/job-types.js';
import {
  handlePrepareJob,
  handleAddTaskToJob,
} from '../services/buildops/handlers/job.js';
import {
  handleSaveCallerNumber,
  handleAddRepresentative,
} from '../services/buildops/handlers/representative.js';
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
    receiver: toNumber,
  });

  return { ok: true };
}

export async function handleFunctionCall(body: RetellWebhookBody): Promise<RetellFunctionResult> {
  const callId = body.call.call_id;
  const functionName = body.name ?? '';
  const args = (body.arguments ?? {}) as Record<string, unknown>;

  const session = await getInboundCall(callId);
  if (!session) {
    return { result: 'error: session not found — call may not have been initialized' };
  }

  const resolution = await resolveByInboundNumber(session.receiver);
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

    case 'get_pricebook_items':
      return handleGetPricebookItems(session, args);

    case 'get_job_types':
      return handleGetJobTypes(session, ctx);

    case 'get_departments':
      return handleGetDepartments(session);

    case 'prepare_job':
      return handlePrepareJob(session, ctx, args);

    case 'save_caller_number':
      return handleSaveCallerNumber(session, args);

    case 'add_representative':
      return handleAddRepresentative(session, args);

    case 'add_task_to_job':
      return handleAddTaskToJob(session, ctx, args);

    default:
      return { result: `error: unknown function "${functionName}"` };
  }
}

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
