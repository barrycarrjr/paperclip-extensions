/**
 * Shared vocabulary for the business-records plugin: the allowed values of
 * every enum-like column, the row shapes the database returns, and the API
 * shapes tools and the page see.
 *
 * Pure, no I/O. Imported by the worker, the tests and (type-only) the UI.
 */

export const PLUGIN_ID = "business-records";

// ---- Enums ----

export const RELATIONSHIPS = ["owned", "prospect", "former", "other"] as const;
export type Relationship = (typeof RELATIONSHIPS)[number];

export const OPERATING_STATUSES = ["not_yet_operating", "operating", "ceased", "unknown"] as const;
export const LEGAL_STATUSES = [
  "not_yet_formed",
  "formation_filed",
  "active",
  "dissolution_filed",
  "dissolved",
  "unknown",
] as const;
export const TAX_ACCOUNT_STATUSES = [
  "not_yet_registered",
  "open",
  "final_return_filed",
  "account_closed",
  "unknown",
] as const;

/** The three independent statuses a business carries. */
export const STATUS_FIELDS = ["operating", "legal", "tax_account"] as const;
export type StatusField = (typeof STATUS_FIELDS)[number];

export const STATUS_VALUES: Record<StatusField, readonly string[]> = {
  operating: OPERATING_STATUSES,
  legal: LEGAL_STATUSES,
  tax_account: TAX_ACCOUNT_STATUSES,
};

/** Database column prefix for each status field. */
export const STATUS_COLUMN: Record<StatusField, "operating_status" | "legal_status" | "tax_account_status"> = {
  operating: "operating_status",
  legal: "legal_status",
  tax_account: "tax_account_status",
};

/**
 * Status values that may only be set with a document on file to prove them.
 * A user statement or an agent inference can never set these.
 */
export const PROOF_REQUIRED_STATUS: Record<StatusField, readonly string[]> = {
  operating: [],
  legal: ["active", "dissolved"],
  tax_account: ["open", "final_return_filed", "account_closed"],
};

export const STATUS_SOURCE_KINDS = [
  "document",
  "external_confirmation",
  "user_reported",
  "agent_inference",
] as const;
export type StatusSourceKind = (typeof STATUS_SOURCE_KINDS)[number];

/** Source kinds that carry proof, and so must point at a document on file. */
export const PROOF_SOURCE_KINDS: readonly StatusSourceKind[] = ["document", "external_confirmation"];

export const DOC_TYPES = [
  "articles_of_organization",
  "certificate_of_organization",
  "operating_agreement",
  "bylaws",
  "tax_id_letter",
  "s_corp_election",
  "s_corp_acceptance",
  "state_registration",
  "fictitious_name",
  "license_or_permit",
  "annual_report",
  "insurance_certificate",
  "bank_resolution",
  "tax_return",
  "filing_confirmation",
  "government_notice",
  "extension_confirmation",
  "compliance_review",
  "professional_advice",
  "other",
] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const PREPARERS = ["cpa", "owner", "agent_drafts", "other"] as const;
export type Preparer = (typeof PREPARERS)[number];

export const FILING_STATUSES = [
  "upcoming",
  "in_preparation",
  "extension_filed",
  "filed",
  "accepted",
  "not_required",
] as const;
export type FilingStatus = (typeof FILING_STATUSES)[number];

/** Statuses that close a filing. Anything else is still open and keeps being reported. */
export const CLOSED_FILING_STATUSES: readonly FilingStatus[] = ["filed", "accepted", "not_required"];

/** Filing statuses that need a proof document on file. */
export const PROOF_REQUIRED_FILING_STATUSES: readonly FilingStatus[] = ["filed", "accepted", "extension_filed"];

export const NOT_REQUIRED_SOURCE_KINDS = ["document", "professional_advice", "official_guidance"] as const;
export type NotRequiredSourceKind = (typeof NOT_REQUIRED_SOURCE_KINDS)[number];

export const HISTORY_KINDS = [
  "status_change",
  "filing_status_change",
  "document_added",
  "document_replaced",
  "business_created",
  "business_updated",
] as const;
export type HistoryKind = (typeof HISTORY_KINDS)[number];

// ---- Shapes ----

export interface Contact {
  role: string;
  name?: string;
  email?: string;
  phone?: string;
  notes?: string;
}

export interface StatusSource {
  kind: string;
  documentId?: string;
  url?: string;
  note?: string;
}

export interface Actor {
  agentId?: string | null;
  runId?: string | null;
  userId?: string | null;
}

export interface BusinessRow {
  id: string;
  company_id: string;
  name: string;
  other_names: string[] | null;
  relationship: Relationship;
  legal_form: string | null;
  formation_state: string | null;
  registration_states: string[] | null;
  tax_classification: string | null;
  tax_classification_effective: string | null;
  linked_company_ids: string[] | null;
  contacts: Contact[] | null;
  notes: string | null;
  tax_id_last4: string | null;
  operating_status: string;
  operating_status_as_of: string | null;
  operating_status_source: StatusSource | null;
  legal_status: string;
  legal_status_as_of: string | null;
  legal_status_source: StatusSource | null;
  tax_account_status: string;
  tax_account_status_as_of: string | null;
  tax_account_status_source: StatusSource | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface StatusApi {
  value: string;
  asOf: string | null;
  source: StatusSource | null;
}

export interface BusinessApi {
  id: string;
  companyId: string;
  name: string;
  otherNames: string[];
  relationship: Relationship;
  legalForm: string | null;
  formationState: string | null;
  registrationStates: string[];
  taxClassification: string | null;
  taxClassificationEffective: string | null;
  linkedCompanyIds: string[];
  contacts: Contact[];
  notes: string | null;
  taxIdLast4: string | null;
  statuses: Record<StatusField, StatusApi>;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentRow {
  id: string;
  company_id: string;
  business_id: string;
  doc_type: DocType;
  title: string;
  issuing_body: string | null;
  document_date: string | null;
  renewal_date: string | null;
  issue_id: string;
  attachment_ref: string | null;
  replaced_by: string | null;
  idempotency_key: string | null;
  notes: string | null;
  created_at: string | Date;
  business_name?: string;
}

export interface DocumentApi {
  id: string;
  businessId: string;
  businessName?: string;
  docType: DocType;
  title: string;
  issuingBody: string | null;
  documentDate: string | null;
  renewalDate: string | null;
  issueId: string;
  attachmentRef: string | null;
  replacedBy: string | null;
  notes: string | null;
  createdAt: string;
}

export interface FilingRow {
  id: string;
  company_id: string;
  business_id: string;
  filing: string;
  authority: string;
  period_label: string;
  period_start: string | null;
  period_end: string | null;
  due_date: string;
  extended_due_date: string | null;
  preparer: Preparer | null;
  status: FilingStatus;
  proof_document_id: string | null;
  not_required_reason: string | null;
  not_required_source: StatusSource | null;
  issue_id: string | null;
  notes: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  business_name?: string;
  proof_title?: string | null;
}

export interface FilingApi {
  id: string;
  businessId: string;
  businessName?: string;
  filing: string;
  authority: string;
  periodLabel: string;
  periodStart: string | null;
  periodEnd: string | null;
  dueDate: string;
  extendedDueDate: string | null;
  /** The date that actually applies: the extended one when an extension is on file. */
  effectiveDueDate: string;
  preparer: Preparer | null;
  status: FilingStatus;
  proofDocumentId: string | null;
  proofTitle: string | null;
  notRequiredReason: string | null;
  notRequiredSource: StatusSource | null;
  issueId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LinkRow {
  company_id: string;
  business_id: string;
  issue_id: string;
  role: string;
  created_at: string | Date;
}

export interface LinkApi {
  businessId: string;
  issueId: string;
  role: string;
  createdAt: string;
  issue?: { title: string; status: string; identifier: string | null; dueDate: string | null } | null;
}

export interface HistoryRow {
  id: string;
  company_id: string;
  business_id: string;
  kind: HistoryKind;
  subject_id: string | null;
  field: string | null;
  old_value: string | null;
  new_value: string | null;
  as_of: string | null;
  source: StatusSource | Record<string, unknown> | null;
  actor: Actor | null;
  created_at: string | Date;
  business_name?: string;
}

export interface HistoryApi {
  id: string;
  businessId: string;
  businessName?: string;
  kind: HistoryKind;
  subjectId: string | null;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  asOf: string | null;
  source: StatusSource | Record<string, unknown> | null;
  actor: Actor | null;
  createdAt: string;
}

// ---- Mappers ----

export function toIso(value: string | Date | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function businessToApi(row: BusinessRow): BusinessApi {
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    otherNames: row.other_names ?? [],
    relationship: row.relationship,
    legalForm: row.legal_form,
    formationState: row.formation_state,
    registrationStates: row.registration_states ?? [],
    taxClassification: row.tax_classification,
    taxClassificationEffective: row.tax_classification_effective,
    linkedCompanyIds: row.linked_company_ids ?? [],
    contacts: row.contacts ?? [],
    notes: row.notes,
    taxIdLast4: row.tax_id_last4,
    statuses: {
      operating: {
        value: row.operating_status,
        asOf: row.operating_status_as_of,
        source: row.operating_status_source,
      },
      legal: {
        value: row.legal_status,
        asOf: row.legal_status_as_of,
        source: row.legal_status_source,
      },
      tax_account: {
        value: row.tax_account_status,
        asOf: row.tax_account_status_as_of,
        source: row.tax_account_status_source,
      },
    },
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function documentToApi(row: DocumentRow): DocumentApi {
  const api: DocumentApi = {
    id: row.id,
    businessId: row.business_id,
    docType: row.doc_type,
    title: row.title,
    issuingBody: row.issuing_body,
    documentDate: row.document_date,
    renewalDate: row.renewal_date,
    issueId: row.issue_id,
    attachmentRef: row.attachment_ref,
    replacedBy: row.replaced_by,
    notes: row.notes,
    createdAt: toIso(row.created_at),
  };
  if (row.business_name !== undefined) api.businessName = row.business_name;
  return api;
}

export function filingToApi(row: FilingRow): FilingApi {
  const api: FilingApi = {
    id: row.id,
    businessId: row.business_id,
    filing: row.filing,
    authority: row.authority,
    periodLabel: row.period_label,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    dueDate: row.due_date,
    extendedDueDate: row.extended_due_date,
    effectiveDueDate: row.extended_due_date ?? row.due_date,
    preparer: row.preparer,
    status: row.status,
    proofDocumentId: row.proof_document_id,
    proofTitle: row.proof_title ?? null,
    notRequiredReason: row.not_required_reason,
    notRequiredSource: row.not_required_source,
    issueId: row.issue_id,
    notes: row.notes,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
  if (row.business_name !== undefined) api.businessName = row.business_name;
  return api;
}

export function linkToApi(row: LinkRow): LinkApi {
  return {
    businessId: row.business_id,
    issueId: row.issue_id,
    role: row.role,
    createdAt: toIso(row.created_at),
  };
}

export function historyToApi(row: HistoryRow): HistoryApi {
  const api: HistoryApi = {
    id: row.id,
    businessId: row.business_id,
    kind: row.kind,
    subjectId: row.subject_id,
    field: row.field,
    oldValue: row.old_value,
    newValue: row.new_value,
    asOf: row.as_of,
    source: row.source,
    actor: row.actor,
    createdAt: toIso(row.created_at),
  };
  if (row.business_name !== undefined) api.businessName = row.business_name;
  return api;
}
