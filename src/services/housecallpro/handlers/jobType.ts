/**
 * Retell function handler: set_job_type.
 *
 * Classification is its own tool call so the agent commits to one HCP job type
 * from a fixed enum as soon as it understands the issue, instead of deciding it
 * in the same breath as logging the lead. The resolved `jbt_…` is pinned to the
 * call session and create_lead picks it up from there.
 *
 * The agent only ever handles the NAME. The uuid lives in housecallpro_job_types
 * and never reaches the prompt.
 */

import { resolveJobTypeUuid } from '../db/jobTypes.js';
import { setJobType } from '../db/callsessions.js';
import type { HcpCallSessionRow, RetellFunctionResult } from '../types.js';

export async function handleSetJobType(
  session: HcpCallSessionRow,
  args: Record<string, unknown>,
): Promise<RetellFunctionResult> {
  const name = (args.job_type as string | undefined)?.trim();
  if (!name) {
    return { result: 'error: job_type is required' };
  }

  const uuid = await resolveJobTypeUuid(session.tenantId, name);
  if (!uuid) {
    // Not an error the caller should ever hear about: the lead is still worth
    // creating without a classification, so tell the agent to carry on.
    console.warn('[hcp] set_job_type unknown name', { sessionId: session.sessionId, name });
    return {
      result: JSON.stringify({
        status: 'unknown_job_type',
        job_type: name,
        message: 'Not a configured job type — continue the call and create the lead anyway.',
      }),
    };
  }

  await setJobType(session.sessionId, uuid);
  console.log('[hcp] set_job_type', { sessionId: session.sessionId, name, uuid });

  return { result: JSON.stringify({ status: 'set', job_type: name }) };
}
