/**
 * BuildOps REST API client.
 * All requests are authenticated with a Bearer token + tenantId header.
 * Non-2xx responses throw an Error with the status code and response body.
 * Base URL and credentials are provided via BuildOpsContext passed to each function.
 */

import type {
  BuildOpsContext,
  BuildOpsJobResponse,
  CreateJobInput,
  PropertyRow,
  AddressObj,
} from './types.js';

function buildHeaders(ctx: BuildOpsContext): Record<string, string> {
  return {
    'Authorization': `Bearer ${ctx.accessToken}`,
    'tenantId': ctx.buildopsTenantId,
    'Content-Type': 'application/json',
  };
}

async function request<T>(
  ctx: BuildOpsContext,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${ctx.apiUrl}${path}`;
  const res = await fetch(url, {
    method,
    headers: buildHeaders(ctx),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`BuildOps ${method} ${path} → ${res.status}: ${text}`);
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return res.json() as Promise<T>;
  }
  return undefined as unknown as T;
}

// ── Job types ─────────────────────────────────────────────────────────────────

export interface JobTypeItem {
  id: string;
  name: string;
  tagName?: string;
  isActive?: boolean;
}

/**
 * Lists all job types for the tenant. Used during config/admin to find the UUID for "Time & Material".
 *
 * @param ctx - BuildOps API context
 * @returns Array of JobTypeItem with id, name, and isActive
 */
export async function getJobTypes(ctx: BuildOpsContext): Promise<JobTypeItem[]> {
  const data = await request<{ data?: JobTypeItem[] } | JobTypeItem[]>(
    ctx, 'GET', `/v1/job-types?tenantId=${ctx.buildopsTenantId}`,
  );
  return Array.isArray(data) ? data : (data as { data?: JobTypeItem[] }).data ?? [];
}

// ── Jobs ──────────────────────────────────────────────────────────────────────

/**
 * Creates a new job in BuildOps.
 *
 * @param ctx   - BuildOps API context
 * @param input - Job creation payload (customerPropertyId, jobTypeId, priceBookId, etc.)
 * @returns BuildOps job UUID and human-readable job number
 */
export async function createJob(
  ctx: BuildOpsContext,
  input: CreateJobInput,
): Promise<{
  jobId: string;
  jobNumber: string;
  customerName: string | null;
  jobTypeName: string | null;
  departments: { id: string; name: string }[];
}> {
  const job = await request<BuildOpsJobResponse>(ctx, 'POST', '/v1/jobs', input);
  return {
    jobId: job.id,
    jobNumber: job.jobNumber,
    customerName: job.customerName ?? null,
    jobTypeName: job.jobTypeName ?? null,
    departments: job.departments ?? [],
  };
}

/**
 * Fetches a single job by BuildOps job UUID.
 *
 * @param ctx   - BuildOps API context
 * @param jobId - BuildOps job UUID
 * @returns Full BuildOpsJobResponse
 */
export async function getJob(ctx: BuildOpsContext, jobId: string): Promise<BuildOpsJobResponse> {
  return request<BuildOpsJobResponse>(ctx, 'GET', `/v1/jobs/${jobId}`);
}

/**
 * Updates an existing job. Requires version for optimistic locking.
 *
 * @param ctx   - BuildOps API context
 * @param jobId - BuildOps job UUID
 * @param body  - Fields to update plus the current version number
 */
export async function updateJob(
  ctx: BuildOpsContext,
  jobId: string,
  body: Partial<CreateJobInput> & { version: number },
): Promise<void> {
  await request(ctx, 'PUT', `/v1/jobs/${jobId}`, body);
}

/**
 * Adds a tag to an existing job (for department assignment or review flagging).
 *
 * @param ctx     - BuildOps API context
 * @param jobId   - BuildOps job UUID
 * @param tagData - Tag payload as required by the BuildOps API
 */
export async function createJobTag(
  ctx: BuildOpsContext,
  jobId: string,
  tagData: unknown,
): Promise<void> {
  await request(ctx, 'POST', `/v1/jobs/${jobId}/tags`, tagData);
}

// ── Customers ─────────────────────────────────────────────────────────────────

export interface BuildOpsCustomerResponse {
  id: string;
  name: string;
  phonePrimary?: string;
  phoneSecondary?: string;
  addresses?: AddressObj[];
}

/**
 * Fetches a single customer by BuildOps customer UUID.
 * Called mid-call in handlePrepareJob to read the live account status before creating a job.
 *
 * @param ctx         - BuildOps API context
 * @param customerId  - BuildOps customer UUID
 * @param addressType - Optional filter (e.g. 'billingAddress') to scope returned addresses
 * @returns Customer data including live status field
 */
export async function getCustomer(
  ctx: BuildOpsContext,
  customerId: string,
  addressType?: string,
): Promise<BuildOpsCustomerResponse> {
  const qs = addressType ? `?addressType=${encodeURIComponent(addressType)}` : '';
  return request<BuildOpsCustomerResponse>(
    ctx, 'GET', `/v1/customers/${customerId}${qs}`,
  );
}


/**
 * Updates a customer record in BuildOps.
 *
 * @param ctx        - BuildOps API context
 * @param customerId - BuildOps customer UUID
 * @param body       - Fields to update
 */
export async function updateCustomer(
  ctx: BuildOpsContext,
  customerId: string,
  body: unknown,
): Promise<void> {
  await request(ctx, 'PUT', `/v1/customers/${customerId}`, body);
}

// ── Properties ────────────────────────────────────────────────────────────────

/**
 * Fetches a single property by BuildOps property UUID.
 *
 * @param ctx        - BuildOps API context
 * @param propertyId - BuildOps property UUID
 * @returns Raw property object from the API
 */
export async function getProperty(
  ctx: BuildOpsContext,
  propertyId: string,
): Promise<unknown> {
  return request(ctx, 'GET', `/v1/properties/${propertyId}?tenantId=${ctx.buildopsTenantId}`);
}

/**
 * Fetches all properties for the tenant (first page only, no pagination).
 * Intended for admin/config tooling; use the cron sync for full property mirroring.
 *
 * @param ctx - BuildOps API context
 * @returns Array of PropertyRow
 */
export async function getPropertiesByTenant(ctx: BuildOpsContext): Promise<PropertyRow[]> {
  const data = await request<{ data?: PropertyRow[] } | PropertyRow[]>(
    ctx, 'GET', `/v1/properties?tenantId=${ctx.buildopsTenantId}`,
  );
  return Array.isArray(data) ? data : (data as { data?: PropertyRow[] }).data ?? [];
}

/**
 * Creates a new service location property in BuildOps.
 * BuildOps requires coordinates on creation; address fields can be added separately.
 *
 * @param ctx        - BuildOps API context
 * @param customerId - BuildOps customer UUID to associate the property with
 * @param latitude   - Property latitude
 * @param longitude  - Property longitude
 * @returns BuildOps property UUID
 */
export async function createProperty(
  ctx: BuildOpsContext,
  customerId: string,
  latitude: number,
  longitude: number,
): Promise<{ propertyId: string }> {
  const res = await request<{ id: string }>(ctx, 'POST', '/v1/properties', {
    customerId,
    latitude,
    longitude,
  });
  return { propertyId: res.id };
}

// ── Representatives ───────────────────────────────────────────────────────────

export interface RepresentativePhoneItem {
  id: string;
  cellPhone: string | null;
  landlinePhone: string | null;
}

/**
 * Fetches all representatives for a customer, paginated.
 * Used during sync to collect rep phone numbers for the all_numbers aggregation.
 *
 * @param ctx                - BuildOps API context
 * @param buildopsCustomerId - BuildOps customer UUID
 * @returns All representative phone items (auto-paginated, 100/page)
 */
export async function getCustomerRepresentatives(
  ctx: BuildOpsContext,
  buildopsCustomerId: string,
): Promise<RepresentativePhoneItem[]> {
  const PAGE_SIZE = 100;
  const results: RepresentativePhoneItem[] = [];
  let page = 0;

  while (true) {
    const data = await request<{ totalCount?: number; items?: RepresentativePhoneItem[] }>(
      ctx, 'GET', `/v1/customers/${buildopsCustomerId}/our-representatives?page=${page}&page_size=${PAGE_SIZE}`,
    );
    const items = data.items ?? [];
    results.push(...items);
    if (items.length < PAGE_SIZE) break;
    page++;
  }

  return results;
}

/**
 * Creates a new representative on a BuildOps customer account.
 * Called mid-call when add_representative fires and the customer confirmed.
 *
 * @param ctx                - BuildOps API context
 * @param buildopsCustomerId - BuildOps customer UUID
 * @param data               - Representative data: firstName, lastName, and optionally cellPhone/landlinePhone
 * @returns Object containing the new representative's BuildOps UUID
 */
export async function createCustomerRepresentative(
  ctx: BuildOpsContext,
  buildopsCustomerId: string,
  data: { firstName: string; lastName: string; cellPhone?: string | null; landlinePhone?: string | null },
): Promise<{ id: string }> {
  return request<{ id: string }>(
    ctx, 'POST', `/v1/customers/${buildopsCustomerId}/representatives`, data,
  );
}

// ── Paginated jobs list (used by cron incremental sync) ───────────────────────

/**
 * Fetches all jobs updated since a given Unix-millisecond timestamp (incremental sync).
 * Paginates automatically until an empty page is returned.
 *
 * @param ctx      - BuildOps API context
 * @param since    - Unix ms watermark; pass 0 to fetch all jobs
 * @param page     - Starting page index (default 0)
 * @param pageSize - Items per page (default 200)
 * @returns All BuildOpsJobResponse records updated after the watermark
 */
export async function listJobsSince(
  ctx: BuildOpsContext,
  since: number,
  page = 0,
  pageSize = 200,
): Promise<BuildOpsJobResponse[]> {
  const all: BuildOpsJobResponse[] = [];
  let currentPage = page;

  while (true) {
    const qs = new URLSearchParams({
      page: String(currentPage),
      page_size: String(pageSize),
      ...(since > 0 ? { lastUpdatedDateStart: new Date(since).toISOString() } : {}),
    });
    const data = await request<{ totalCount?: number; items?: BuildOpsJobResponse[] }>(
      ctx, 'GET', `/v1/jobs?${qs}`,
    );
    const items = data.items ?? [];
    all.push(...items);
    if (items.length < pageSize) break;
    currentPage++;
  }

  return all;
}

// ── Paginated customer list (used by cron, not mid-call) ──────────────────────

/**
 * Fetches all customers for the tenant (paginated, 200/page). Used by the cron sync.
 * Not called mid-call — all customer data is read from the local Supabase mirror.
 *
 * @param ctx - BuildOps API context
 * @returns All customer records as raw API objects
 */
export async function getAllCustomers(ctx: BuildOpsContext): Promise<unknown[]> {
  const results: unknown[] = [];
  let page = 1;
  const limit = 200;

  while (page <= 200) {
    const data = await request<{ data?: unknown[]; hasMore?: boolean } | unknown[]>(
      ctx, 'GET', `/v1/customers?tenantId=${ctx.buildopsTenantId}&limit=${limit}&page=${page}`,
    );

    const items = Array.isArray(data) ? data : (data as { data?: unknown[] }).data ?? [];
    results.push(...items);

    const hasMore = Array.isArray(data)
      ? items.length === limit
      : (data as { hasMore?: boolean }).hasMore ?? false;

    if (!hasMore || items.length === 0) break;
    page++;
  }

  return results;
}
