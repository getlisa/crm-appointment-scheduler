/**
 * Supabase queries for the buildops_jobs table.
 * Jobs are written immediately during the call (via prepare_job) and kept
 * in sync with BuildOps via the incremental jobs sync watermark strategy.
 */

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
    createdAt: row.created_at as number | null,
    lastUpdatedAt: row.last_updated_at as number | null,
    issueDescription: row.issue_description as string | null,
    customerProvidedJobNumber: row.customer_provided_job_number as string | null,
    customerProvidedPoNumber: row.customer_provided_po_number as string | null,
    billingCustomerId: row.billing_customer_id as string | null,
    billingCustomerName: row.billing_customer_name as string | null,
    invoiceStatus: row.invoice_status as string | null,
    serviceAgreementId: row.service_agreement_id as string | null,
    completedDate: row.completed_date as number | null,
    isDeleted: (row.is_deleted as boolean) ?? false,
    audit: row.audit as Record<string, unknown> | null,
  };
}

/**
 * Upserts a job row into buildops_jobs.
 * On conflict (tenant_id, job_id) all fields are overwritten — used both for
 * the initial write during prepare_job and for cron sync updates.
 *
 * @param tenantId - BuildOps tenant UUID
 * @param jobData  - Job fields to write; all fields except jobId are optional
 */
export async function upsertJob(tenantId: string, jobData: {
  jobId: string;
  jobNumber?: string;
  status?: string;
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
  createdAt?: number;
  lastUpdatedAt?: number;
  issueDescription?: string;
  customerProvidedJobNumber?: string;
  customerProvidedPoNumber?: string;
  billingCustomerId?: string;
  billingCustomerName?: string;
  invoiceStatus?: string;
  serviceAgreementId?: string;
  completedDate?: number;
  isDeleted?: boolean;
  audit?: Record<string, unknown>;
}): Promise<void> {
  await supabase.from('buildops_jobs').upsert({
    tenant_id: tenantId,
    job_id: jobData.jobId,
    job_number: jobData.jobNumber ?? null,
    status: jobData.status ?? null,
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
    created_at: jobData.createdAt ?? null,
    last_updated_at: jobData.lastUpdatedAt ?? null,
    issue_description: jobData.issueDescription ?? null,
    customer_provided_job_number: jobData.customerProvidedJobNumber ?? null,
    customer_provided_po_number: jobData.customerProvidedPoNumber ?? null,
    billing_customer_id: jobData.billingCustomerId ?? null,
    billing_customer_name: jobData.billingCustomerName ?? null,
    invoice_status: jobData.invoiceStatus ?? null,
    service_agreement_id: jobData.serviceAgreementId ?? null,
    completed_date: jobData.completedDate ?? null,
    is_deleted: jobData.isDeleted ?? false,
    audit: jobData.audit ?? null,
  }, { onConflict: 'tenant_id,job_id' });
}

/**
 * Fetches a job row by BuildOps job UUID, scoped to the tenant.
 *
 * @param tenantId - BuildOps tenant UUID
 * @param jobId    - BuildOps job UUID
 * @returns The JobRow, or null if not found
 */
export async function getJobByBuildopsId(
  tenantId: string,
  jobId: string,
): Promise<JobRow | null> {
  const { data, error } = await supabase
    .from('buildops_jobs')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('job_id', jobId)
    .single();

  if (error || !data) return null;
  return mapRow(data as Record<string, unknown>);
}
