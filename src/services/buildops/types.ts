// ── Resolution / auth ────────────────────────────────────────────────────────

export interface ResolutionRow {
  no: string;
  client_id: string;
  client_secret: string;
  access_token: string;
  buildops_tenant_id: string;
}

export interface BuildOpsContext {
  accessToken: string;
  buildopsTenantId: string;
  apiUrl: string;
}

// ── Supabase row shapes (camelCase mapped from snake_case) ───────────────────

export interface TenantRow {
  id: string;
  buildopsTenantId: string;
  companyName: string;
  isActive: boolean;
  e164No: string;
  businessAddress: AddressObj | null;
  billingAddress: AddressObj | null;
}

export interface CustomerRow {
  id: string;
  tenantId: string;
  buildopsCustomerId: string;
  name: string;
  phonePrimary: string | null;
  phoneSecondary: string | null;
  isActive: boolean;
  addresses: AddressObj[];
  normalizedPhonePrimary: string | null;
  normalizedPhoneSecondary: string | null;
}

export interface RepresentativeRow {
  id: string;
  tenantId: string;
  customerId: string;
  propertyId: string;
  firstName: string;
  lastName: string;
  cellPhone: string | null;
  landlinePhone: string | null;
  normalizedCellPhone: string | null;
  normalizedLandlinePhone: string | null;
  email: string | null;
  isActive: boolean;
  isDoNotCall: boolean;
  isEmailOptOut: boolean;
  isSmsOptOut: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface PropertyRow {
  id: string;
  name: string | null;
  phonePrimary: string | null;
  customerId: string;
  address: AddressObj;
}

export interface DepartmentRow {
  id: string;
  tagName: string;
  tenantId: string;
  phonePrimary: string | null;
  email: string | null;
  isActive: boolean;
}

export interface InboundCallRow {
  id: string;
  retellCallId: string;
  tenantId: string;
  caller: string | null;
  receiver: string;
  matchedCustomerId: string | null;
  status: InboundCallStatus;
  buildopsJobId: string | null;
}

export interface PricebookRow {
  id: string;
  tenantId: string;
  productId: string;
  name: string;
  description: string | null;
  unitPrice: number | null;
  taxable: boolean;
  isActive: boolean;
}

export interface JobRow {
  id: string;
  jobId: string;
  jobNumber: string;
  status: string;
  customerPropertyId: string | null;
  customerName: string | null;
  customerId: string | null;
  jobTypeId: string | null;
  jobTypeName: string | null;
  priceBookId: string | null;
  priority: string | null;
  version: number;
  billingStatus: string | null;
  reviewStatus: string | null;
  billingType: string | null;
  amountQuoted: number | null;
  isUseTaxable: boolean;
  departments: { id: string; name: string }[];
  dueDate: string | null;
  isFlagged: boolean;
  tenantId: string;
  audit: Record<string, unknown> | null;
}

// ── Shared value types ────────────────────────────────────────────────────────

export interface AddressObj {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  zip?: string;
}

export type InboundCallStatus = 'active' | 'job_created' | 'handed_off' | 'ended';

// ── Fuzzy search ──────────────────────────────────────────────────────────────

export interface FuzzyQuery {
  name?: string;
  address?: string;
  zip?: string;
  oldPhone?: string;
}

export interface ScoredCandidate {
  customer: CustomerRow;
  score: number;
}

export type LookupDecision =
  | { band: 'accept'; candidate: CustomerRow }
  | { band: 'disambiguate'; candidates: CustomerRow[] }
  | { band: 'handoff' };

// ── Job creation ──────────────────────────────────────────────────────────────

export type JobStatus = 'Open' | 'In Progress' | 'On Hold' | 'Cancelled';

export interface CreateJobInput {
  customerPropertyId: string;
  jobTypeId: string;
  priceBookId: string;
  customerId: string;
  isUseTaxable: boolean;
  status: JobStatus;
}

export interface TaskEntry {
  productId: string;
  description?: string;
  quantity: number;
}

export interface BuildOpsJobResponse {
  id: string;
  jobNumber: string;
  status: string;
  customerId: string;
  customerPropertyId: string;
  jobTypeId: string;
  priceBookId: string;
  version: number;
  isUseTaxable: boolean;
  tenantId: string;
  departments: { id: string; name: string }[];
  audit: { createdDate: string; lastUpdatedDate: string };
}

// ── Retell webhook payloads ───────────────────────────────────────────────────

export interface RetellCallPayload {
  call_id: string;
  to_number: string;
  from_number: string;
}

export interface RetellWebhookBody {
  event: string;
  call: RetellCallPayload;
  name?: string;
  arguments?: Record<string, unknown>;
}

export interface RetellFunctionResult {
  result: string;
}
