import { supabaseAdmin as supabase } from '../../../lib/supabase.js';
import type { JobRow } from '../types.js';

function mapRow(row: Record<string, unknown>): JobRow {
  return {
    id: row.id as string,
    jobId: row.job_id as string,
    jobNumber: row.job_number as string,
    status: row.status as string,
    customerPropertyId: row.customer_property_id as string | null,
    customerName: row.customer_name as string | null,
    customerId: row.customer_id as string | null,
    jobTypeId: row.job_type_id as string | null,
    jobTypeName: row.job_type_name as string | null,
    priceBookId: row.price_book_id as string | null,
    priority: row.priority as string | null,
    version: row.version as number,
    billingStatus: row.billing_status as string | null,
    reviewStatus: row.review_status as string | null,
    billingType: row.billing_type as string | null,
    amountQuoted: row.amount_quoted as number | null,
    isUseTaxable: row.is_use_taxable as boolean,
    departments: (row.departments as { id: string; name: string }[]) ?? [],
    dueDate: row.due_date as string | null,
    isFlagged: row.is_flagged as boolean,
    tenantId: row.tenant_id as string,
    audit: row.audit as Record<string, unknown> | null,
  };
}

export async function upsertJob(tenantId: string, jobData: {
  jobId: string;
  jobNumber: string;
  status: string;
  customerPropertyId?: string;
  customerName?: string;
  customerId?: string;
  jobTypeId?: string;
  jobTypeName?: string;
  priceBookId?: string;
  priority?: string;
  version?: number;
  billingStatus?: string;
  reviewStatus?: string;
  billingType?: string;
  amountQuoted?: number;
  isUseTaxable?: boolean;
  departments?: { id: string; name: string }[];
  dueDate?: string;
  isFlagged?: boolean;
  audit?: Record<string, unknown>;
}): Promise<void> {
  await supabase.from('jobs').upsert({
    tenant_id: tenantId,
    job_id: jobData.jobId,
    job_number: jobData.jobNumber,
    status: jobData.status,
    customer_property_id: jobData.customerPropertyId ?? null,
    customer_name: jobData.customerName ?? null,
    customer_id: jobData.customerId ?? null,
    job_type_id: jobData.jobTypeId ?? null,
    job_type_name: jobData.jobTypeName ?? null,
    price_book_id: jobData.priceBookId ?? null,
    priority: jobData.priority ?? null,
    version: jobData.version ?? 0,
    billing_status: jobData.billingStatus ?? null,
    review_status: jobData.reviewStatus ?? null,
    billing_type: jobData.billingType ?? null,
    amount_quoted: jobData.amountQuoted ?? null,
    is_use_taxable: jobData.isUseTaxable ?? false,
    departments: jobData.departments ?? [],
    due_date: jobData.dueDate ?? null,
    is_flagged: jobData.isFlagged ?? false,
    audit: jobData.audit ?? null,
  }, { onConflict: 'tenant_id,job_id' });
}

export async function getJobByBuildopsId(
  tenantId: string,
  jobId: string,
): Promise<JobRow | null> {
  const { data, error } = await supabase
    .from('jobs')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('job_id', jobId)
    .single();

  if (error || !data) return null;
  return mapRow(data as Record<string, unknown>);
}
