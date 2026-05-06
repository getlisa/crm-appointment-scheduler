import { createJob, createTask } from '../client.js';
import { getCustomerById } from '../db/customers.js';
import { getPropertyById } from '../db/properties.js';
import { setJobCreated } from '../db/inbound-calls.js';
import { upsertJob } from '../db/jobs.js';
import type {
  BuildOpsContext,
  InboundCallRow,
  RetellFunctionResult,
  JobStatus,
  TaskEntry,
} from '../types.js';

const ALLOWED_STATUSES: JobStatus[] = ['Open', 'In Progress', 'On Hold', 'Cancelled'];

export async function handleCreateJob(
  session: InboundCallRow,
  ctx: BuildOpsContext,
  args: Record<string, unknown>,
): Promise<RetellFunctionResult> {
  if (!session.matchedCustomerId) {
    return { result: 'error: no customer confirmed — complete customer lookup first' };
  }

  const customerPropertyId = args.customer_property_id as string | undefined;
  const jobTypeId = args.job_type_id as string | undefined;
  const priceBookId = args.price_book_id as string | undefined;
  const isUseTaxable = (args.is_use_taxable as boolean | undefined) ?? false;
  const rawStatus = (args.status as string | undefined) ?? 'Open';

  if (!customerPropertyId || !jobTypeId || !priceBookId) {
    return {
      result:
        'error: customer_property_id, job_type_id, and price_book_id are all required',
    };
  }

  const status: JobStatus = ALLOWED_STATUSES.includes(rawStatus as JobStatus)
    ? (rawStatus as JobStatus)
    : 'Open';

  // Resolve BuildOps customer ID from our internal customer row
  const customer = await getCustomerById(session.tenantId, session.matchedCustomerId);
  if (!customer) {
    return { result: 'error: could not load customer record' };
  }

  // Verify property belongs to us (optional guard)
  const property = await getPropertyById(customerPropertyId);
  if (!property || property.customerId !== session.matchedCustomerId) {
    return { result: 'error: property not found or does not belong to this customer' };
  }

  let jobResult: { jobId: string; jobNumber: string };
  try {
    jobResult = await createJob(ctx, {
      customerPropertyId,
      jobTypeId,
      priceBookId,
      customerId: customer.buildopsCustomerId,
      isUseTaxable,
      status,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { result: `error: job creation failed — ${msg}` };
  }

  await setJobCreated(session.retellCallId, jobResult.jobId);

  // Mirror into our jobs table
  await upsertJob(session.tenantId, {
    jobId: jobResult.jobId,
    jobNumber: jobResult.jobNumber,
    status,
    customerPropertyId,
    customerId: customer.buildopsCustomerId,
    jobTypeId,
    priceBookId,
    isUseTaxable,
  });

  return {
    result: JSON.stringify({
      status: 'created',
      job_id: jobResult.jobId,
      job_number: jobResult.jobNumber,
    }),
  };
}

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
