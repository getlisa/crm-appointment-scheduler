import { createJob, createTask, getCustomer } from '../client.js';
import { getCustomerById } from '../db/customers.js';
import { getPropertyById } from '../db/properties.js';
import { setJobCreated, appendPendingJob } from '../db/inbound-calls.js';
import { upsertJob } from '../db/jobs.js';
import type {
  BuildOpsContext,
  InboundCallRow,
  RetellFunctionResult,
  JobStatus,
  TaskEntry,
  PendingJobData,
  PendingTaskData,
} from '../types.js';

const DEFAULT_JOB_TYPE_ID = '04df1a40-16b1-43f4-aa9b-8eafcec812ad';
const DEFAULT_DEPARTMENT_ID = 'd87c1a38-4acd-459f-9b3f-446a810fae10'; // D2 Service Calls (T&M)

const ALLOWED_STATUSES: JobStatus[] = ['Open', 'In Progress', 'On Hold', 'Cancelled'];

const BLOCKED_STATUSES = new Set(['creditHold', 'inactive', 'suspended', 'collections']);

const BLOCK_REASON: Record<string, string> = {
  creditHold:  'This account is on credit hold. Please contact our billing team to resolve the balance before scheduling service.',
  inactive:    'This account is inactive and cannot have new jobs created.',
  suspended:   'This account is suspended. Please contact our office to reinstate service.',
  collections: 'This account is in collections. Please contact our billing team before scheduling.',
};

// ── Internal: called post-call by call_ended handler ─────────────────────────

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
    departments: data.departmentId ? [{ id: data.departmentId }] : [],
  });

  await setJobCreated(session.retellCallId, jobResult.jobId);

  await upsertJob(session.tenantId, {
    jobId: jobResult.jobId,
    jobNumber: jobResult.jobNumber,
    status: data.status,
    customerPropertyId: data.customerPropertyId,
    customerId: customer.buildopsCustomerId,
    jobTypeId: data.jobTypeId,
    priceBookId: data.priceBookId,
    isUseTaxable: data.isUseTaxable,
  });

  for (const task of data.tasks) {
    await createTask(ctx, jobResult.jobId, task.name, task.entries);
  }

  return jobResult;
}

// ── Retell-facing: collect + validate job details, store as pending ───────────

export async function handlePrepareJob(
  session: InboundCallRow,
  ctx: BuildOpsContext,
  args: Record<string, unknown>,
): Promise<RetellFunctionResult> {
  if (!session.matchedCustomerId) {
    return { result: 'error: no customer confirmed — complete customer lookup first' };
  }

  const customerPropertyId = args.customer_property_id as string | undefined;
  const rawStatus = (args.status as string | undefined) ?? 'Open';
  const rawTasks   = (args.tasks as unknown[] | undefined) ?? [];
  const needsReview = !!(args.needs_review);

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
  if (accountStatus && BLOCKED_STATUSES.has(accountStatus)) {
    return {
      result: JSON.stringify({
        status: 'blocked',
        reason: accountStatus,
        message: BLOCK_REASON[accountStatus] ?? `This account has a status of "${accountStatus}" and cannot have new jobs created.`,
      }),
    };
  }

  const property = await getPropertyById(customerPropertyId);
  if (!property || property.customerId !== session.matchedCustomerId) {
    return { result: 'error: property not found or does not belong to this customer' };
  }

  const tasks: PendingTaskData[] = rawTasks.map((t: unknown) => {
    const task = t as Record<string, unknown>;
    const entries: TaskEntry[] = ((task.entries as unknown[]) ?? []).map((e: unknown) => {
      const entry = e as Record<string, unknown>;
      return {
        productId: entry.product_id as string,
        description: entry.description as string | undefined,
        quantity: Number(entry.quantity ?? 1),
      };
    });
    return { name: task.name as string, entries };
  });

  const pendingJob: PendingJobData = {
    customerPropertyId,
    jobTypeId: DEFAULT_JOB_TYPE_ID,
    priceBookId,
    isUseTaxable,
    status,
    propertyAddress: property.address,
    needsReview,
    departmentId: DEFAULT_DEPARTMENT_ID || null,
    tasks,
  };

  await appendPendingJob(session.retellCallId, pendingJob);

  return {
    result: JSON.stringify({
      status: 'ready',
      needs_review: needsReview,
      summary: {
        property_address: property.address,
        job_status: status,
        task_count: tasks.length,
      },
    }),
  };
}

// ── Keep add_task_to_job for any direct task operations (admin/testing) ───────

export async function handleAddTaskToJob(
  _session: InboundCallRow,
  ctx: BuildOpsContext,
  args: Record<string, unknown>,
): Promise<RetellFunctionResult> {
  const jobId = args.job_id as string | undefined;
  const name = args.name as string | undefined;
  const rawEntries = args.entries as unknown[] | undefined;

  if (!jobId || !name || !rawEntries?.length) {
    return { result: 'error: job_id, name, and entries are required' };
  }

  const entries: TaskEntry[] = rawEntries.map((e: unknown) => {
    const entry = e as Record<string, unknown>;
    return {
      productId: entry.product_id as string,
      description: entry.description as string | undefined,
      quantity: Number(entry.quantity ?? 1),
    };
  });

  try {
    await createTask(ctx, jobId, name, entries);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { result: `error: task creation failed — ${msg}` };
  }

  return {
    result: JSON.stringify({
      status: 'task_added',
      job_id: jobId,
      task_name: name,
    }),
  };
}
