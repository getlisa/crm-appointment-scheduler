/**
 * Shared types for the HouseCall Pro (HCP) integration.
 *
 * Auth model differs from BuildOps: HCP uses a static per-tenant API key
 * (`Authorization: Token <api_key>`) stored in housecallpro_tokens, keyed by
 * `no` (the dialed Retell number). There is no OAuth token refresh.
 */

// ── Resolution / auth ──────────────────────────────────────────────────────

/** A row from housecallpro_tokens resolved by dialed number or tenant id. */
export interface HcpTokenRow {
  no: string;
  tenantId: string;
  apiKey: string;
  agentId: string | null;
  emailTo: string | null;
  ccMail: string | null;
}

/** Context passed to the API client + handlers for every HCP request. */
export interface HcpContext {
  apiKey: string;
  tenantId: string;
  emailTo: string | null;
  ccMail: string | null;
}

// ── HCP API models ──────────────────────────────────────────────────────────

export interface HcpApiAddress {
  id: string;
  type?: string | null;
  street?: string | null;
  street_line_2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string | null;
}

export interface HcpApiCustomer {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  mobile_number?: string | null;
  home_number?: string | null;
  work_number?: string | null;
  company?: string | null;
  notifications_enabled?: boolean;
  lead_source?: string | null;
  notes?: string | null;
  kind?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  company_name?: string | null;
  company_id?: string | null;
  tags?: string[];
  addresses?: HcpApiAddress[];
}

export interface HcpCustomersListResponse {
  page: number;
  page_size: number;
  total_pages: number;
  total_items: number;
  customers: HcpApiCustomer[];
}

export interface HcpAddressesListResponse {
  page: number;
  page_size: number;
  total_pages: number;
  total_items: number;
  addresses: HcpApiAddress[];
}

/** Body sent to POST /customers (create customer). */
export interface HcpCreateCustomerInput {
  first_name: string;
  last_name: string;
  email?: string;
  company?: string;
  notifications_enabled?: boolean;
  mobile_number?: string;
  home_number?: string;
  work_number?: string;
  tags?: string[];
  lead_source?: string;
  notes?: string;
}

/** Body sent to POST /customers/{id}/addresses (create address). */
export interface HcpCreateAddressInput {
  street: string;
  street_line_2?: string;
  city: string;
  state: string;
  zip: string;
  country?: string;
  latitude?: number;
  longitude?: number;
}

/** Body sent to POST /jobs (create job). */
export interface HcpCreateJobInput {
  customer_id: string;
  address_id: string;
  schedule?: {
    scheduled_start?: string;
    scheduled_end?: string;
    arrival_window?: number;
  };
  line_items?: { name: string; description?: string; unit_price?: number; quantity?: number }[];
  assigned_employee_ids?: string[];
  tags?: string[];
  lead_source?: string;
  notes?: string;
}

/** POST /jobs response (loose — only the fields we read/persist are typed). */
export interface HcpJobResponse {
  id: string;
  invoice_number?: string | null;
  work_status?: string | null;
  schedule?: {
    scheduled_start?: string | null;
    scheduled_end?: string | null;
    arrival_window?: number | null;
  } | null;
  [key: string]: unknown;
}

// ── Supabase row shapes (camelCase mapped from snake_case) ───────────────────

/** A normalized address hydrated at call time for Scenario-B fuzzy matching. */
export interface HcpAddressLite {
  id: string;
  street: string | null;
  streetLine2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  /** "street, city, state zip" for display + scoring. */
  formatted: string;
}

/** A row from housecallpro_customers, mapped to camelCase. */
export interface HcpCustomerRow {
  id: string;
  tenantId: string;
  housecallproCustomerId: string;
  firstName: string | null;
  lastName: string | null;
  /** Computed `${firstName} ${lastName}` — used by the fuzzy scorer + greeting. */
  name: string;
  companyName: string | null;
  email: string | null;
  mobileNumber: string | null;
  /** Last-10 of mobile_number (from the generated column). */
  normalizedMobile: string | null;
  /** All normalized numbers for this customer (currently just the mobile). */
  allNumbers: string[];
  notificationsEnabled: boolean;
  leadSource: string | null;
  notes: string | null;
  tags: string[];
  doNotService: boolean | null;
  addressIds: string[];
  housecallproCreatedAt: string | null;
  housecallproUpdatedAt: string | null;
  /** Hydrated at call time (GET /customers/{id}/addresses); empty for cache rows. */
  addresses: HcpAddressLite[];
}

export type HcpCallStatus =
  | 'active'
  | 'job_created'
  | 'escalated'
  | 'handed_off'
  | 'ended'
  | 'user_hangup'
  | 'agent_hangup'
  | 'call_transfer'
  | 'voicemail_reached'
  | 'inactivity'
  | 'machine_detected'
  | 'max_duration_reached'
  | 'concurrency_limit_reached'
  | 'dial_busy'
  | 'dial_failed'
  | 'dial_no_answer'
  | 'error_inbound_webhook';

/** A row from housecallpro_callsessions, mapped to camelCase. */
export interface HcpCallSessionRow {
  id: string;
  sessionId: string;
  tenantId: string;
  retellCallId: string | null;
  caller: string;
  toNumber: string | null;
  housecallproCustomerId: string | null;
  customerName: string | null;
  matchTier: string | null;
  selectedSlotStart: string | null;
  selectedSlotEnd: string | null;
  selectedSlotDisplay: string | null;
  selectedTechnicianId: string | null;
  housecallproJobId: string | null;
  housecallproJobNumber: string | null;
  escalationType: string | null;
  escalationSummary: string | null;
  status: HcpCallStatus;
  serviceAddressMap: HcpServiceAddressMap | null;
}

/** Shape stored in housecallpro_callsessions.service_address_map (jsonb). */
export interface HcpServiceAddressMap {
  /** address_id → normalized address, cached from GET /customers/{id}/addresses. */
  addresses: Record<string, HcpAddressLite>;
  /** The address_id chosen via match_address / create_address. */
  selectedAddressId?: string | null;
}

// ── Fuzzy search ──────────────────────────────────────────────────────────────

export interface FuzzyQuery {
  name?: string;
  address?: string;
  zip?: string;
  oldPhone?: string;
}

export interface ScoredCandidate {
  customer: HcpCustomerRow;
  score: number;
}

export type LookupDecision =
  | { band: 'accept'; candidate: HcpCustomerRow }
  | { band: 'disambiguate'; candidates: HcpCustomerRow[] }
  | { band: 'handoff' };

// ── Retell payloads ───────────────────────────────────────────────────────────

export interface RetellFunctionResult {
  result: string;
}
