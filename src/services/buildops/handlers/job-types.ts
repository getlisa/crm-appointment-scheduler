import { getJobTypes } from '../client.js';
import { getDepartments } from '../db/departments.js';
import type { BuildOpsContext, InboundCallRow, RetellFunctionResult } from '../types.js';

export async function handleGetJobTypes(
  session: InboundCallRow,
  ctx: BuildOpsContext,
): Promise<RetellFunctionResult> {
  const jobTypes = await getJobTypes(ctx);

  if (jobTypes.length === 0) {
    return {
      result: JSON.stringify({ status: 'no_results', message: 'No job types found.' }),
    };
  }

  return {
    result: JSON.stringify({
      status: 'ok',
      jobTypes: jobTypes.map(jt => ({
        id: jt.id,
        name: jt.name,
        tagName: jt.tagName,
      })),
    }),
  };
}

export async function handleGetDepartments(
  session: InboundCallRow,
): Promise<RetellFunctionResult> {
  const departments = await getDepartments(session.tenantId);

  if (departments.length === 0) {
    return {
      result: JSON.stringify({ status: 'no_results', message: 'No departments found.' }),
    };
  }

  return {
    result: JSON.stringify({
      status: 'ok',
      departments: departments.map(d => ({
        id: d.id,
        name: d.tagName,
        email: d.email,
      })),
    }),
  };
}
