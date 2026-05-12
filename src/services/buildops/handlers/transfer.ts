import { setCallStatus } from '../db/inbound-calls.js';
import type { InboundCallRow, RetellFunctionResult } from '../types.js';

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
