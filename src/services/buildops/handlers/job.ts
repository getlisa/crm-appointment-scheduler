/**
 * Retell function handler: prepare_job.
 * The central job-creation handler. Validates the account status live (blocking
 * on creditHold/inactive/suspended/collections), then creates the job in BuildOps
 * and writes it to buildops_jobs — all during the call before returning to Retell.
 */

import { createJob, getCustomer } from '../client.js';
import { getCustomerById } from '../db/customers.js';
import { getPropertyById } from '../db/properties.js';
import { setJobCreated } from '../db/inbound-calls.js';
import { resolveByTenantId } from '../db/tenants.js';
import { upsertJob } from '../db/jobs.js';
import { env } from '../../../config/env.js';
import type {
  BuildOpsContext,
  InboundCallRow,
  RetellFunctionResult,
  JobStatus,
  PendingJobData,
} from '../types.js';

const DEFAULT_JOB_TYPE_ID    = '04df1a40-16b1-43f4-aa9b-8eafcec812ad';
const DEFAULT_JOB_TYPE_NAME  = 'Time & Material';
const DEFAULT_DEPARTMENT_ID  = 'd87c1a38-4acd-459f-9b3f-446a810fae10';
const DEFAULT_DEPARTMENT_NAME = 'D2 Service Calls (T&M)';

const ALLOWED_STATUSES: JobStatus[] = ['Open', 'In Progress', 'On Hold', 'Canceled', 'Complete'];

const BLOCKED_STATUSES = new Set(['creditHold', 'inactive', 'suspended', 'collections']);

const BLOCK_REASON: Record<string, string> = {
  creditHold:  'This account is on credit hold. Please contact our billing team to resolve the balance before scheduling service.',
  inactive:    'This account is inactive and cannot have new jobs created.',
  suspended:   'This account is suspended. Please contact our office to reinstate service.',
  collections: 'This account is in collections. Please contact our billing team before scheduling.',
};

function buildCtx(resolution: { access_token: string; buildops_tenant_id: string }): BuildOpsContext {
  return {
    accessToken: resolution.access_token,
    buildopsTenantId: resolution.buildops_tenant_id,
    apiUrl: env.buildopsApiUrl,
  };
}

// ── Internal: create job in BuildOps + write to local DB ──────────────────────

/**
 * Creates a job in BuildOps, writes it to buildops_jobs, and creates all task line items.
 * Called by handlePrepareJob after all pre-checks pass.
 *
 * @param session - Current call session (matchedCustomerId must be set)
 * @param ctx     - BuildOps API context (access token + tenant ID + base URL)
 * @param data    - Fully resolved job data including priceBookId, tasks, and department
 * @returns BuildOps job UUID and human-readable job number
 * @throws If the BuildOps API call fails
 */
export async function executeJobCreation(
  session: InboundCallRow,
  ctx: BuildOpsContext,
  data: PendingJobData,
): Promise<{ jobId: string; jobNumber: string }> {
  const customer = await getCustomerById(session.tenantId, session.matchedCustomerId!);
  if (!customer) throw new Error('customer record not found');

  const jobResult = await createJob(ctx, {
    customerPropertyId: data.customerPropertyId,
    jobTypeId: data.jobTypeId,
    priceBookId: data.priceBookId,
    customerId: customer.buildopsCustomerId,
    isUseTaxable: data.isUseTaxable,
    status: data.status,
    departmentIds: data.departmentId ? [data.departmentId] : null,
    issueDescription: data.issueDescription,
  });

  await setJobCreated(session.retellCallId, jobResult.jobId);

  await upsertJob(session.tenantId, {
    jobId: jobResult.jobId,
    jobNumber: jobResult.jobNumber,
    status: data.status,
    customerPropertyId: data.customerPropertyId,
    customerId: customer.buildopsCustomerId,
    customerName: jobResult.customerName ?? customer.name,
    jobTypeName: jobResult.jobTypeName ?? DEFAULT_JOB_TYPE_NAME,
    jobTypeId: data.jobTypeId,
    priceBookId: data.priceBookId,
    isUseTaxable: data.isUseTaxable,
    departments: jobResult.departments.length > 0
      ? jobResult.departments
      : data.departmentId ? [{ id: data.departmentId, name: DEFAULT_DEPARTMENT_NAME }] : [],
    issueDescription: data.issueDescription,
  });

  return jobResult;
}

// ── Retell-facing: validate + immediately create job ──────────────────────────

/**
 * Handles the prepare_job Retell function call.
 * Runs pre-checks (customer confirmed, property valid, account not blocked), then
 * delegates to executeJobCreation. Returns a blocked message if the account status
 * is creditHold, inactive, suspended, or collections.
 *
 * @param session - Current call session
 * @param ctx     - BuildOps API context
 * @param args    - Function arguments: customer_property_id (required), status, needs_review, tasks
 * @returns RetellFunctionResult — status: created (with job_id/job_number) | blocked (with message)
 */
export async function handlePrepareJob(
  session: InboundCallRow,
  ctx: BuildOpsContext,
  args: Record<string, unknown>,
): Promise<RetellFunctionResult> {
  const customerPropertyId = args.customer_property_id as string | undefined;
  console.log('[buildops] prepare_job start', { retellCallId: session.retellCallId, matchedCustomerId: session.matchedCustomerId, customerPropertyId });

  if (!session.matchedCustomerId) {
    return { result: 'error: no customer confirmed — complete customer lookup first' };
  }
  const rawStatus = (args.status as string | undefined) ?? 'Open';
  const needsReview = !!(args.needs_review);
  const rawIssueDescription = (args.issue_description as string | undefined)?.trim() ?? '';
  const issueDescription = rawIssueDescription
    ? `[Job Created by Clara]\n${rawIssueDescription}`
    : '[Job Created by Clara]';

  if (!customerPropertyId) {
    return { result: 'error: customer_property_id is required' };
  }

  const isUseTaxable = false;

  const status: JobStatus = ALLOWED_STATUSES.includes(rawStatus as JobStatus)
    ? (rawStatus as JobStatus)
    : 'Open';

  const customer = await getCustomerById(session.tenantId, session.matchedCustomerId);
  if (!customer) {
    return { result: 'error: could not load customer record' };
  }

  const priceBookId = customer.priceBookId;
  if (!priceBookId) {
    return { result: 'error: no priceBookId on customer record — re-run getcustomers.ts sync' };
  }

  const liveCustomer = await getCustomer(ctx, customer.buildopsCustomerId).catch(() => null);
  const accountStatus = (liveCustomer as Record<string, unknown> | null)?.['status'] as string | null ?? null;
  console.log('[buildops] prepare_job customer check', { customerId: customer.id, buildopsCustomerId: customer.buildopsCustomerId, accountStatus });
  if (accountStatus && BLOCKED_STATUSES.has(accountStatus)) {
    console.log('[buildops] prepare_job blocked', { reason: accountStatus, customerId: customer.id });
    return {
      result: JSON.stringify({
        status: 'blocked',
        reason: accountStatus,
        message: BLOCK_REASON[accountStatus] ?? `This account has a status of "${accountStatus}" and cannot have new jobs created.`,
      }),
    };
  }

  const property = await getPropertyById(customerPropertyId);
  if (!property || property.customerId !== customer.buildopsCustomerId) {
    return { result: 'error: property not found or does not belong to this customer' };
  }

  const pendingJob: PendingJobData = {
    customerPropertyId,
    jobTypeId: DEFAULT_JOB_TYPE_ID,
    priceBookId,
    isUseTaxable,
    status,
    propertyAddress: property.address,
    needsReview,
    departmentId: DEFAULT_DEPARTMENT_ID,
    issueDescription,
  };

  // Resolve a fresh context if the passed ctx may have a stale token
  let activeCtx = ctx;
  const freshResolution = await resolveByTenantId(session.tenantId).catch(() => null);
  if (freshResolution) activeCtx = buildCtx(freshResolution);

  try {
    const jobResult = await executeJobCreation(session, activeCtx, pendingJob);
    console.log('[buildops] prepare_job result', { status: 'created', jobId: jobResult.jobId, jobNumber: jobResult.jobNumber, retellCallId: session.retellCallId });
    return {
      result: JSON.stringify({
        status: 'created',
        job_id: jobResult.jobId,
        job_number: jobResult.jobNumber,
        needs_review: needsReview,
        summary: {
          property_address: property.address,
          job_status: status,
        },
      }),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[buildops] prepare_job error', { retellCallId: session.retellCallId, error: msg });
    return { result: `error: job creation failed — ${msg}` };
  }
}

