// ── Resolution / auth ────────────────────────────────────────────────────────

export interface ResolutionRow {
  no: string;
  client_id: string;
  client_secret: string;
  access_token: string;
  buildops_tenant_id: string;
  email_to: string[];
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
  propertyAddresses?: AddressObj[];
  normalizedPhonePrimary: string | null;
  normalizedPhoneSecondary: string | null;
  priceBookId: string | null;
  allNumbers: string[];
  /** Parallel to allNumbers — source tag for each phone (e.g. "rep:cellPhone:John Smith:prop:uuid") */
  allNumbersSources: string[];
  /** FK → buildops_properties.id. IDs only — use getPropertiesByIds() to load full data. */
  propertyIds: string[];
  /** FK → buildops_representatives.id. IDs only — use a representatives lookup to load full data. */
  representativeIds: string[];
  billingAddress: string | null;
  businessAddress: string | null;
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
  sessionId: string;
  retellCallId: string | null;
  tenantId: string;
  caller: string | null;
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
  createdAt: number | null;
  lastUpdatedAt: number | null;
  issueDescription: string | null;
  customerProvidedJobNumber: string | null;
  customerProvidedPoNumber: string | null;
  billingCustomerId: string | null;
  billingCustomerName: string | null;
  invoiceStatus: string | null;
  serviceAgreementId: string | null;
  completedDate: number | null;
  isDeleted: boolean;
  /** Full name of the property rep who called in and triggered this job. Set at creation or after add_representative opt-in. */
  propertyRepName: string | null;
  /** Supabase UUID from buildops_representatives for the property rep. Null if rep was not in the system at job creation time. */
  propertyRepId: string | null;
}

// ── Shared value types ────────────────────────────────────────────────────────

export interface AddressObj {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  zip?: string;
}

export type InboundCallStatus =
  | 'active'
  | 'job_created'
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

// ── Fuzzy search ──────────────────────────────────────────────────────────────

export interface FuzzyQuery {
  name?: string;
  address?: string;
  zip?: string;
  oldPhone?: string;
  propertyAddress?: string;
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

export type JobStatus = 'Open' | 'In Progress' | 'On Hold' | 'Canceled' | 'Complete';

export interface PendingJobData {
  customerPropertyId: string;
  jobTypeId: string;
  priceBookId: string;
  isUseTaxable: boolean;
  status: JobStatus;
  propertyAddress?: AddressObj;
  needsReview?: boolean;
  departmentId?: string | null;
  issueDescription?: string;
}

export interface CreateJobInput {
  customerPropertyId: string;
  jobTypeId: string;
  priceBookId: string;
  customerId: string;
  isUseTaxable: boolean;
  status: JobStatus;
  departmentIds?: string[] | null;
  issueDescription?: string;
}

export interface BuildOpsJobResponse {
  id: string;
  jobNumber: string;
  status: string;
  customerId: string;
  customerPropertyId: string;
  customerName?: string | null;
  jobTypeId: string;
  jobTypeName?: string | null;
  priceBookId: string;
  priority?: string | null;
  version: number;
  isUseTaxable: boolean;
  tenantId: string;
  departments: { id: string; name: string }[];
  billingStatus?: string | null;
  reviewStatus?: string | null;
  billingType?: string | null;
  amountQuoted?: number | null;
  isFlagged?: boolean;
  dueDate?: string | null;
  issueDescription?: string | null;
  customerProvidedJobNumber?: string | null;
  customerProvidedPONumber?: string | null;
  billingCustomerId?: string | null;
  billingCustomerName?: string | null;
  invoiceStatus?: string | null;
  serviceAgreementId?: string | null;
  completedDate?: number | null;
  audit: {
    createdDate?: string | null;
    createdDateTime?: number | null;
    lastUpdatedDate?: string | null;
    lastUpdatedDateTime?: number | null;
    deletedDate?: string | null;
    deletedDateTime?: number | null;
  };
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
  args?: Record<string, unknown>;
  arguments?: Record<string, unknown>;
}

export interface RetellFunctionResult {
  result: string;
}
