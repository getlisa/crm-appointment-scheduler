/**
 * Retell function handler: escalate (After-Hours).
 * Captures a service request / message and marks the session escalated. No job is
 * booked (office closed). Fires a best-effort notification to the tenant's inbox.
 */

import { setEscalation } from '../db/callsessions.js';
import { sendHcpNotification } from '../emailNotificationService.js';
import type { HcpCallSessionRow, HcpContext, RetellFunctionResult } from '../types.js';

export async function handleEscalate(
  session: HcpCallSessionRow,
  ctx: HcpContext,
  args: Record<string, unknown>,
): Promise<RetellFunctionResult> {
  const escalationType = (args.escalation_type as string | undefined)?.trim() || 'general';
  const summary = (args.summary as string | undefined)?.trim()
    || (args.message as string | undefined)?.trim()
    || '';
  const callerName = (args.caller_name as string | undefined)?.trim() || session.customerName || null;

  await setEscalation(session.sessionId, escalationType, summary);

  sendHcpNotification({
    kind: 'escalation',
    emailTo: ctx.emailTo,
    ccMail: ctx.ccMail,
    details: {
      customerName: callerName,
      callbackNumber: (args.callback_number as string | undefined)?.trim() || session.caller,
      escalationType,
      summary,
    },
  }).catch(() => undefined);

  console.log('[hcp] escalate', { sessionId: session.sessionId, escalationType });
  return {
    result: JSON.stringify({
      status: 'captured',
      escalation_type: escalationType,
      message: 'Your request has been logged. Our team will follow up during business hours.',
    }),
  };
}
