import type {
  BuildOpsContext,
  BuildOpsJobResponse,
  CreateJobInput,
  TaskEntry,
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

export async function getJobTypes(ctx: BuildOpsContext): Promise<JobTypeItem[]> {
  const data = await request<{ data?: JobTypeItem[] } | JobTypeItem[]>(
    ctx, 'GET', `/v1/job-types?tenantId=${ctx.buildopsTenantId}`,
  );
  return Array.isArray(data) ? data : (data as { data?: JobTypeItem[] }).data ?? [];
}

// ── Jobs ──────────────────────────────────────────────────────────────────────

export async function createJob(
  ctx: BuildOpsContext,
  input: CreateJobInput,
): Promise<{ jobId: string; jobNumber: string }> {
  const job = await request<BuildOpsJobResponse>(ctx, 'POST', '/v1/jobs', input);
  return { jobId: job.id, jobNumber: job.jobNumber };
}

export async function getJob(ctx: BuildOpsContext, jobId: string): Promise<BuildOpsJobResponse> {
  return request<BuildOpsJobResponse>(ctx, 'GET', `/v1/jobs/${jobId}`);
}

export async function updateJob(
  ctx: BuildOpsContext,
  jobId: string,
  body: Partial<CreateJobInput> & { version: number },
): Promise<void> {
  await request(ctx, 'PUT', `/v1/jobs/${jobId}`, body);
}

export async function createJobTag(
  ctx: BuildOpsContext,
  jobId: string,
  tagData: unknown,
): Promise<void> {
  await request(ctx, 'POST', `/v1/jobs/${jobId}/tags`, tagData);
}

export async function createTask(
  ctx: BuildOpsContext,
  jobId: string,
  name: string,
  entries: TaskEntry[],
): Promise<void> {
  await request(ctx, 'POST', `/v1/jobs/${jobId}/tasks`, { name, entries });
}

// ── Customers ─────────────────────────────────────────────────────────────────

export interface BuildOpsCustomerResponse {
  id: string;
  name: string;
  phonePrimary?: string;
  phoneSecondary?: string;
  addresses?: AddressObj[];
}

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


export async function updateCustomer(
  ctx: BuildOpsContext,
  customerId: string,
  body: unknown,
): Promise<void> {
  await request(ctx, 'PUT', `/v1/customers/${customerId}`, body);
}

// ── Properties ────────────────────────────────────────────────────────────────

export async function getProperty(
  ctx: BuildOpsContext,
  propertyId: string,
): Promise<unknown> {
  return request(ctx, 'GET', `/v1/properties/${propertyId}?tenantId=${ctx.buildopsTenantId}`);
}

export async function getPropertiesByTenant(ctx: BuildOpsContext): Promise<PropertyRow[]> {
  const data = await request<{ data?: PropertyRow[] } | PropertyRow[]>(
    ctx, 'GET', `/v1/properties?tenantId=${ctx.buildopsTenantId}`,
  );
  return Array.isArray(data) ? data : (data as { data?: PropertyRow[] }).data ?? [];
}

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

export async function createCustomerRepresentative(
  ctx: BuildOpsContext,
  buildopsCustomerId: string,
  data: { firstName: string; lastName: string; cellPhone?: string | null; landlinePhone?: string | null },
): Promise<{ id: string }> {
  return request<{ id: string }>(
    ctx, 'POST', `/v1/customers/${buildopsCustomerId}/representatives`, data,
  );
}

// ── Paginated customer list (used by cron, not mid-call) ──────────────────────

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
