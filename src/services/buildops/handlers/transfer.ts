/**
 * Retell function handler: transfer_call.
 * Marks the call as handed_off in the DB so the session reflects the final disposition.
 * The actual warm-transfer is performed by Retell using a separate transfer_call_<Name> tool.
 */

import { setCallStatus } from '../db/inbound-calls.js';
import type { InboundCallRow, RetellFunctionResult } from '../types.js';

/**
 * Records a transfer disposition and returns a signal for the Retell agent to proceed with the transfer.
 *
 * @param session - Current call session
 * @param args    - Optional: reason string describing why the transfer was initiated
 * @returns RetellFunctionResult — status: transfer_initiated, reason
 */
export async function handleTransferCall(
  session: InboundCallRow,
  args: Record<string, unknown>,
): Promise<RetellFunctionResult> {
  const reason = (args.reason as string | undefined) ?? 'unspecified';
  await setCallStatus(session.retellCallId, 'handed_off').catch(() => undefined);
  return {
    result: JSON.stringify({ status: 'transfer_initiated', reason }),
  };
}
