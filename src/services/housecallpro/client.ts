/**
 * HouseCall Pro REST API client.
 * Authenticated with a static per-tenant API key: `Authorization: Token <api_key>`.
 * Base URL is fixed; credentials come from the HcpContext passed to each function.
 * Non-2xx responses throw an Error with the status code and response body.
 */

import type {
  HcpContext,
  HcpApiAddress,
  HcpApiCustomer,
  HcpCustomersListResponse,
  HcpAddressesListResponse,
  HcpCreateCustomerInput,
  HcpCreateAddressInput,
  HcpCreateJobInput,
  HcpJobResponse,
} from './types.js';

const BASE_URL = 'https://api.housecallpro.com';

/** HCP rejects page_size > 200. */
export const MAX_PAGE_SIZE = 200;

function buildHeaders(ctx: HcpContext, withBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Token ${ctx.apiKey}`,
    Accept: 'application/json',
  };
  if (withBody) headers['Content-Type'] = 'application/json';
  return headers;
}

/** Retries on network errors and 5xx (not 4xx). */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = 2,
  delayMs = 1000,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.ok || res.status < 500) return res;
    } catch (err) {
      lastErr = err;
    }
    if (attempt < retries) await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
  }
  if (lastErr) throw lastErr;
  return fetch(url, options);
}

async function request<T>(
  ctx: HcpContext,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetchWithRetry(`${BASE_URL}${path}`, {
    method,
    headers: buildHeaders(ctx, body !== undefined),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HCP ${method} ${path} → ${res.status}: ${text}`);
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return res.json() as Promise<T>;
  }
  return undefined as unknown as T;
}

// ── Customers ─────────────────────────────────────────────────────────────────

/**
 * Lists customers for the tenant, one page at a time (used by the sync).
 * Each customer includes its `addresses[]` inline.
 *
 * @param page     1-based page index
 * @param pageSize items per page (capped at 200 by the API)
 */
export async function listCustomers(
  ctx: HcpContext,
  page: number,
  pageSize = 100,
): Promise<HcpCustomersListResponse> {
  const size = Math.min(pageSize, MAX_PAGE_SIZE);
  return request<HcpCustomersListResponse>(
    ctx, 'GET', `/customers?page=${page}&page_size=${size}`,
  );
}

/** Fetches a single customer by HCP customer id (cus_...). */
export async function getCustomer(ctx: HcpContext, customerId: string): Promise<HcpApiCustomer> {
  return request<HcpApiCustomer>(ctx, 'GET', `/customers/${customerId}`);
}

/** Lists all addresses attached to a customer. */
export async function getCustomerAddresses(
  ctx: HcpContext,
  customerId: string,
  page = 1,
  pageSize = 100,
): Promise<HcpAddressesListResponse> {
  const size = Math.min(pageSize, MAX_PAGE_SIZE);
  return request<HcpAddressesListResponse>(
    ctx, 'GET', `/customers/${customerId}/addresses?page=${page}&page_size=${size}`,
  );
}

/** Fetches a single address on a customer. */
export async function getAddress(
  ctx: HcpContext,
  customerId: string,
  addressId: string,
): Promise<HcpApiAddress> {
  return request<HcpApiAddress>(ctx, 'GET', `/customers/${customerId}/addresses/${addressId}`);
}

/** Creates a new customer. Returns the created customer (id = cus_...). */
export async function createCustomer(
  ctx: HcpContext,
  body: HcpCreateCustomerInput,
): Promise<HcpApiCustomer> {
  return request<HcpApiCustomer>(ctx, 'POST', '/customers', body);
}

/** Creates a new address on a customer. Returns the created address (id = adr_...). */
export async function createAddress(
  ctx: HcpContext,
  customerId: string,
  body: HcpCreateAddressInput,
): Promise<HcpApiAddress> {
  return request<HcpApiAddress>(ctx, 'POST', `/customers/${customerId}/addresses`, body);
}

// ── Jobs ──────────────────────────────────────────────────────────────────────

/** Creates a job. Returns the created job (id + work_status + schedule). */
export async function createJob(
  ctx: HcpContext,
  body: HcpCreateJobInput,
): Promise<HcpJobResponse> {
  return request<HcpJobResponse>(ctx, 'POST', '/jobs', body);
}
