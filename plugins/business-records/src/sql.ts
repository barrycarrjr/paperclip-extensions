/**
 * SQL builders. Pure: each returns {text, params} for ctx.db.query or
 * ctx.db.execute.
 *
 * READ THIS BEFORE CHANGING A BUILDER.
 *
 * Every builder takes companyId as its first data argument, binds it as $1 and
 * filters on company_id. That is the company isolation model: an id on its own
 * never reaches a row in another company, so a business id from company A
 * looks exactly like "not found" to company B. sql.test.ts fails if a builder
 * stops doing this.
 *
 * Host constraints these builders respect (see the host's plugin-database.ts):
 * - ctx.db.query takes one SELECT (or WITH) and no mutation keywords.
 * - ctx.db.execute takes exactly one INSERT, UPDATE or DELETE against the
 *   plugin namespace, with no references to any other schema. No RETURNING is
 *   relied on and there are no transactions, so ids are generated in the
 *   worker and rows are read back after writing.
 * - Every parameter must be referenced by a $n placeholder.
 * - Parameters cross a JSON boundary, so arrays and objects are sent as JSON
 *   text and converted in SQL, and dates are read back as text (YYYY-MM-DD)
 *   rather than as driver Date objects that would shift with the time zone.
 */

import type { DocType, FilingStatus, Preparer, StatusField } from "./domain.js";
import { STATUS_COLUMN } from "./domain.js";

export interface SqlStatement {
  text: string;
  params: unknown[];
}

class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

function start(companyId: string): { p: Params; c: string } {
  const p = new Params();
  const c = p.add(companyId);
  return { p, c };
}

function jsonText(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

/** SQL for a text[] built from a JSON array parameter. */
function textArray(placeholder: string): string {
  return `ARRAY(SELECT jsonb_array_elements_text(${placeholder}::jsonb))`;
}

function uuidArray(placeholder: string): string {
  return `ARRAY(SELECT jsonb_array_elements_text(${placeholder}::jsonb))::uuid[]`;
}

/** Escape LIKE wildcards so a search for "50%" matches literally. */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

// ---- Businesses ----

const BUSINESS_COLUMNS = `b.id, b.company_id, b.name, to_jsonb(b.other_names) AS other_names, b.relationship,
  b.legal_form, b.formation_state, to_jsonb(b.registration_states) AS registration_states,
  b.tax_classification, b.tax_classification_effective::text AS tax_classification_effective,
  to_jsonb(b.linked_company_ids) AS linked_company_ids, b.contacts, b.notes, b.tax_id_last4,
  b.operating_status, b.operating_status_as_of::text AS operating_status_as_of, b.operating_status_source,
  b.legal_status, b.legal_status_as_of::text AS legal_status_as_of, b.legal_status_source,
  b.tax_account_status, b.tax_account_status_as_of::text AS tax_account_status_as_of, b.tax_account_status_source,
  b.created_at, b.updated_at`;

export function buildGetBusiness(ns: string, companyId: string, businessId: string): SqlStatement {
  const { p, c } = start(companyId);
  const id = p.add(businessId);
  return {
    text: `SELECT ${BUSINESS_COLUMNS} FROM ${ns}.businesses b WHERE b.company_id = ${c} AND b.id = ${id}`,
    params: p.values,
  };
}

export function buildFindBusinessByName(ns: string, companyId: string, name: string): SqlStatement {
  const { p, c } = start(companyId);
  const n = p.add(name);
  return {
    text: `SELECT ${BUSINESS_COLUMNS} FROM ${ns}.businesses b WHERE b.company_id = ${c} AND lower(b.name) = lower(${n})`,
    params: p.values,
  };
}

export function buildListBusinesses(
  ns: string,
  companyId: string,
  filter: { relationship?: string; query?: string } = {},
): SqlStatement {
  const { p, c } = start(companyId);
  const where = [`b.company_id = ${c}`];
  if (filter.relationship) where.push(`b.relationship = ${p.add(filter.relationship)}`);
  if (filter.query) {
    const q = p.add(`%${escapeLike(filter.query)}%`);
    where.push(
      `(b.name ILIKE ${q} ESCAPE '\\' OR array_to_string(b.other_names, ' ') ILIKE ${q} ESCAPE '\\')`,
    );
  }
  return {
    text: `SELECT ${BUSINESS_COLUMNS} FROM ${ns}.businesses b WHERE ${where.join(" AND ")} ORDER BY lower(b.name) LIMIT 500`,
    params: p.values,
  };
}

export interface BusinessInsert {
  id: string;
  name: string;
  otherNames: string[];
  relationship: string;
  legalForm: string | null;
  formationState: string | null;
  registrationStates: string[];
  taxClassification: string | null;
  taxClassificationEffective: string | null;
  linkedCompanyIds: string[];
  contacts: unknown[];
  notes: string | null;
  taxIdLast4: string | null;
  statuses: Partial<Record<StatusField, { value: string; asOf: string; source: unknown }>>;
}

/**
 * Insert a business. ON CONFLICT DO NOTHING: when two calls race to create the
 * same name, the second inserts nothing and the service reads the winner back.
 */
export function buildInsertBusiness(ns: string, companyId: string, b: BusinessInsert): SqlStatement {
  const { p, c } = start(companyId);
  const cols = [
    "id",
    "company_id",
    "name",
    "other_names",
    "relationship",
    "legal_form",
    "formation_state",
    "registration_states",
    "tax_classification",
    "tax_classification_effective",
    "linked_company_ids",
    "contacts",
    "notes",
    "tax_id_last4",
  ];
  const vals = [
    p.add(b.id),
    c,
    p.add(b.name),
    textArray(p.add(jsonText(b.otherNames))),
    p.add(b.relationship),
    p.add(b.legalForm),
    p.add(b.formationState),
    textArray(p.add(jsonText(b.registrationStates))),
    p.add(b.taxClassification),
    `${p.add(b.taxClassificationEffective)}::date`,
    uuidArray(p.add(jsonText(b.linkedCompanyIds))),
    `${p.add(jsonText(b.contacts))}::jsonb`,
    p.add(b.notes),
    p.add(b.taxIdLast4),
  ];
  for (const field of Object.keys(b.statuses) as StatusField[]) {
    const s = b.statuses[field]!;
    const col = STATUS_COLUMN[field];
    cols.push(col, `${col}_as_of`, `${col}_source`);
    vals.push(p.add(s.value), `${p.add(s.asOf)}::date`, `${p.add(jsonText(s.source))}::jsonb`);
  }
  return {
    text: `INSERT INTO ${ns}.businesses (${cols.join(", ")}) VALUES (${vals.join(", ")}) ON CONFLICT DO NOTHING`,
    params: p.values,
  };
}

/** Columns business_upsert may change, and how each is written. */
export const BUSINESS_PATCH_COLUMNS = {
  name: { col: "name", kind: "text" },
  otherNames: { col: "other_names", kind: "text[]" },
  relationship: { col: "relationship", kind: "text" },
  legalForm: { col: "legal_form", kind: "text" },
  formationState: { col: "formation_state", kind: "text" },
  registrationStates: { col: "registration_states", kind: "text[]" },
  taxClassification: { col: "tax_classification", kind: "text" },
  taxClassificationEffective: { col: "tax_classification_effective", kind: "date" },
  linkedCompanyIds: { col: "linked_company_ids", kind: "uuid[]" },
  contacts: { col: "contacts", kind: "jsonb" },
  notes: { col: "notes", kind: "text" },
  taxIdLast4: { col: "tax_id_last4", kind: "text" },
} as const;

export type BusinessPatchKey = keyof typeof BUSINESS_PATCH_COLUMNS;
export type BusinessPatch = Partial<Record<BusinessPatchKey, unknown>>;

export function buildUpdateBusiness(
  ns: string,
  companyId: string,
  businessId: string,
  patch: BusinessPatch,
): SqlStatement | null {
  const { p, c } = start(companyId);
  const sets: string[] = [];
  for (const key of Object.keys(patch) as BusinessPatchKey[]) {
    const spec = BUSINESS_PATCH_COLUMNS[key];
    if (!spec) continue;
    const value = patch[key];
    switch (spec.kind) {
      case "text":
        sets.push(`${spec.col} = ${p.add(value ?? null)}`);
        break;
      case "date":
        sets.push(`${spec.col} = ${p.add(value ?? null)}::date`);
        break;
      case "text[]":
        sets.push(`${spec.col} = ${textArray(p.add(jsonText(value ?? [])))}`);
        break;
      case "uuid[]":
        sets.push(`${spec.col} = ${uuidArray(p.add(jsonText(value ?? [])))}`);
        break;
      case "jsonb":
        sets.push(`${spec.col} = ${p.add(jsonText(value ?? []))}::jsonb`);
        break;
    }
  }
  if (sets.length === 0) return null;
  sets.push("updated_at = now()");
  const id = p.add(businessId);
  return {
    text: `UPDATE ${ns}.businesses SET ${sets.join(", ")} WHERE company_id = ${c} AND id = ${id}`,
    params: p.values,
  };
}

/**
 * Set one status. The WHERE clause repeats the value the service read, so if
 * somebody else changed it in between, nothing is updated (rowCount 0) and
 * the history row can never record the wrong "old value".
 */
export function buildSetStatus(
  ns: string,
  companyId: string,
  businessId: string,
  field: StatusField,
  next: { value: string; asOf: string; source: unknown },
  expectedCurrent: string,
): SqlStatement {
  const { p, c } = start(companyId);
  const col = STATUS_COLUMN[field];
  const v = p.add(next.value);
  const a = p.add(next.asOf);
  const s = p.add(jsonText(next.source));
  const id = p.add(businessId);
  const e = p.add(expectedCurrent);
  return {
    text: `UPDATE ${ns}.businesses SET ${col} = ${v}, ${col}_as_of = ${a}::date, ${col}_source = ${s}::jsonb, updated_at = now() WHERE company_id = ${c} AND id = ${id} AND ${col} = ${e}`,
    params: p.values,
  };
}

// ---- Documents ----

const DOCUMENT_COLUMNS = `d.id, d.company_id, d.business_id, d.doc_type, d.title, d.issuing_body,
  d.document_date::text AS document_date, d.renewal_date::text AS renewal_date, d.issue_id,
  d.attachment_ref, d.replaced_by, d.idempotency_key, d.notes, d.created_at, d.removed_at, b.name AS business_name`;

function documentFrom(ns: string): string {
  return `${ns}.business_documents d JOIN ${ns}.businesses b ON b.id = d.business_id AND b.company_id = d.company_id`;
}

export function buildGetDocument(ns: string, companyId: string, documentId: string): SqlStatement {
  const { p, c } = start(companyId);
  const id = p.add(documentId);
  return {
    text: `SELECT ${DOCUMENT_COLUMNS} FROM ${documentFrom(ns)} WHERE d.company_id = ${c} AND d.id = ${id} AND d.removed_at IS NULL`,
    params: p.values,
  };
}

/**
 * Find a document that an add_document call would duplicate: same idempotency
 * key, or same attachment filed as the same type on the same issue, or (when
 * there is no attachment reference) same issue, type, title and date.
 *
 * Removed documents are included on purpose: the unique indexes still hold
 * their slot, so adding the same file again brings the removed row back.
 */
export function buildFindDuplicateDocument(
  ns: string,
  companyId: string,
  d: {
    businessId: string;
    issueId: string;
    docType: string;
    attachmentRef: string | null;
    title: string;
    documentDate: string | null;
    idempotencyKey: string | null;
  },
): SqlStatement {
  const { p, c } = start(companyId);
  const bid = p.add(d.businessId);
  const alternatives: string[] = [];
  if (d.idempotencyKey) alternatives.push(`d.idempotency_key = ${p.add(d.idempotencyKey)}`);
  const iid = p.add(d.issueId);
  const dt = p.add(d.docType);
  if (d.attachmentRef) {
    alternatives.push(`(d.issue_id = ${iid} AND d.doc_type = ${dt} AND d.attachment_ref = ${p.add(d.attachmentRef)})`);
  } else {
    const t = p.add(d.title);
    const dd = p.add(d.documentDate);
    alternatives.push(
      `(d.issue_id = ${iid} AND d.doc_type = ${dt} AND d.attachment_ref IS NULL AND lower(d.title) = lower(${t}) AND d.document_date IS NOT DISTINCT FROM ${dd}::date)`,
    );
  }
  return {
    text: `SELECT ${DOCUMENT_COLUMNS} FROM ${documentFrom(ns)} WHERE d.company_id = ${c} AND d.business_id = ${bid} AND (${alternatives.join(" OR ")}) ORDER BY d.created_at LIMIT 1`,
    params: p.values,
  };
}

export interface DocumentInsert {
  id: string;
  businessId: string;
  docType: DocType;
  title: string;
  issuingBody: string | null;
  documentDate: string | null;
  renewalDate: string | null;
  issueId: string;
  attachmentRef: string | null;
  idempotencyKey: string | null;
  notes: string | null;
}

export function buildInsertDocument(ns: string, companyId: string, d: DocumentInsert): SqlStatement {
  const { p, c } = start(companyId);
  const vals = [
    p.add(d.id),
    c,
    p.add(d.businessId),
    p.add(d.docType),
    p.add(d.title),
    p.add(d.issuingBody),
    `${p.add(d.documentDate)}::date`,
    `${p.add(d.renewalDate)}::date`,
    p.add(d.issueId),
    p.add(d.attachmentRef),
    p.add(d.idempotencyKey),
    p.add(d.notes),
  ];
  return {
    text: `INSERT INTO ${ns}.business_documents (id, company_id, business_id, doc_type, title, issuing_body, document_date, renewal_date, issue_id, attachment_ref, idempotency_key, notes) VALUES (${vals.join(", ")}) ON CONFLICT DO NOTHING`,
    params: p.values,
  };
}

/** Point an old document at its replacement. Only ever sets replaced_by once. */
export function buildMarkReplaced(
  ns: string,
  companyId: string,
  businessId: string,
  oldId: string,
  newId: string,
): SqlStatement {
  const { p, c } = start(companyId);
  const b = p.add(businessId);
  const o = p.add(oldId);
  const n = p.add(newId);
  return {
    text: `UPDATE ${ns}.business_documents SET replaced_by = ${n} WHERE company_id = ${c} AND business_id = ${b} AND id = ${o} AND replaced_by IS NULL AND id <> ${n}`,
    params: p.values,
  };
}

export interface DocumentFilter {
  businessId?: string;
  docType?: string;
  /** Only documents whose renewal date is on or before this date (includes lapsed ones). */
  renewalOnOrBefore?: string;
  includeReplaced?: boolean;
}

export function buildListDocuments(ns: string, companyId: string, f: DocumentFilter = {}): SqlStatement {
  const { p, c } = start(companyId);
  const where = [`d.company_id = ${c}`, "d.removed_at IS NULL"];
  if (f.businessId) where.push(`d.business_id = ${p.add(f.businessId)}`);
  if (f.docType) where.push(`d.doc_type = ${p.add(f.docType)}`);
  if (!f.includeReplaced) where.push("d.replaced_by IS NULL");
  let order = "d.document_date DESC NULLS LAST, d.created_at DESC";
  if (f.renewalOnOrBefore) {
    where.push(`d.renewal_date IS NOT NULL AND d.renewal_date <= ${p.add(f.renewalOnOrBefore)}::date`);
    order = "d.renewal_date ASC, d.created_at DESC";
  }
  return {
    text: `SELECT ${DOCUMENT_COLUMNS} FROM ${documentFrom(ns)} WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT 500`,
    params: p.values,
  };
}

export interface DocumentUpdate {
  docType?: DocType;
  title?: string;
  issuingBody?: string | null;
  documentDate?: string | null;
  renewalDate?: string | null;
  notes?: string | null;
}

/** Edit the descriptive fields of a document still on the record. */
export function buildUpdateDocument(ns: string, companyId: string, documentId: string, u: DocumentUpdate): SqlStatement {
  const { p, c } = start(companyId);
  const sets: string[] = [];
  if (u.docType !== undefined) sets.push(`doc_type = ${p.add(u.docType)}`);
  if (u.title !== undefined) sets.push(`title = ${p.add(u.title)}`);
  if (u.issuingBody !== undefined) sets.push(`issuing_body = ${p.add(u.issuingBody)}`);
  if (u.documentDate !== undefined) sets.push(`document_date = ${p.add(u.documentDate)}::date`);
  if (u.renewalDate !== undefined) sets.push(`renewal_date = ${p.add(u.renewalDate)}::date`);
  if (u.notes !== undefined) sets.push(`notes = ${p.add(u.notes)}`);
  if (sets.length === 0) throw new Error("buildUpdateDocument needs at least one field");
  const id = p.add(documentId);
  return {
    text: `UPDATE ${ns}.business_documents SET ${sets.join(", ")} WHERE company_id = ${c} AND id = ${id} AND removed_at IS NULL`,
    params: p.values,
  };
}

/** Take a document off the record. The row and the file stay; only the record stops showing it. */
export function buildRemoveDocument(ns: string, companyId: string, documentId: string, reason: string | null): SqlStatement {
  const { p, c } = start(companyId);
  const r = p.add(reason);
  const id = p.add(documentId);
  return {
    text: `UPDATE ${ns}.business_documents SET removed_at = now(), removed_reason = ${r} WHERE company_id = ${c} AND id = ${id} AND removed_at IS NULL`,
    params: p.values,
  };
}

/** Bring a removed document back, with the details it is being added with this time. */
export function buildRestoreDocument(
  ns: string,
  companyId: string,
  documentId: string,
  d: { title: string; issuingBody: string | null; documentDate: string | null; renewalDate: string | null; notes: string | null },
): SqlStatement {
  const { p, c } = start(companyId);
  const t = p.add(d.title);
  const ib = p.add(d.issuingBody);
  const dd = p.add(d.documentDate);
  const rd = p.add(d.renewalDate);
  const n = p.add(d.notes);
  const id = p.add(documentId);
  return {
    text: `UPDATE ${ns}.business_documents SET removed_at = NULL, removed_reason = NULL, title = ${t}, issuing_body = ${ib}, document_date = ${dd}::date, renewal_date = ${rd}::date, notes = ${n} WHERE company_id = ${c} AND id = ${id} AND removed_at IS NOT NULL`,
    params: p.values,
  };
}

/** When a replacing document is removed, the one it replaced is current again. */
export function buildClearReplacedBy(ns: string, companyId: string, replacedById: string): SqlStatement {
  const { p, c } = start(companyId);
  const id = p.add(replacedById);
  return {
    text: `UPDATE ${ns}.business_documents SET replaced_by = NULL WHERE company_id = ${c} AND replaced_by = ${id}`,
    params: p.values,
  };
}

/** Filings that cite a document, as proof of filing or as the reason it is not required. */
export function buildFilingsCitingDocument(ns: string, companyId: string, documentId: string): SqlStatement {
  const { p, c } = start(companyId);
  const id = p.add(documentId);
  return {
    text: `SELECT f.id, f.filing, f.period_label FROM ${ns}.business_filings f WHERE f.company_id = ${c} AND (f.proof_document_id = ${id} OR f.not_required_source->>'documentId' = ${id}::text) ORDER BY f.due_date LIMIT 20`,
    params: p.values,
  };
}


// ---- Filings ----

const FILING_COLUMNS = `f.id, f.company_id, f.business_id, f.filing, f.authority, f.period_label,
  f.period_start::text AS period_start, f.period_end::text AS period_end, f.due_date::text AS due_date,
  f.extended_due_date::text AS extended_due_date, f.preparer, f.status, f.proof_document_id,
  f.not_required_reason, f.not_required_source, f.issue_id, f.notes, f.created_at, f.updated_at,
  b.name AS business_name, pd.title AS proof_title`;

function filingFrom(ns: string): string {
  return `${ns}.business_filings f
    JOIN ${ns}.businesses b ON b.id = f.business_id AND b.company_id = f.company_id
    LEFT JOIN ${ns}.business_documents pd ON pd.id = f.proof_document_id AND pd.company_id = f.company_id`;
}

export function buildGetFiling(ns: string, companyId: string, filingId: string): SqlStatement {
  const { p, c } = start(companyId);
  const id = p.add(filingId);
  return {
    text: `SELECT ${FILING_COLUMNS} FROM ${filingFrom(ns)} WHERE f.company_id = ${c} AND f.id = ${id}`,
    params: p.values,
  };
}

/** Look a filing up by its natural key, the same one the unique index uses. */
export function buildFindFilingByKey(
  ns: string,
  companyId: string,
  k: { businessId: string; filing: string; authority: string; periodLabel: string },
): SqlStatement {
  const { p, c } = start(companyId);
  const b = p.add(k.businessId);
  const fi = p.add(k.filing);
  const a = p.add(k.authority);
  const pl = p.add(k.periodLabel);
  return {
    text: `SELECT ${FILING_COLUMNS} FROM ${filingFrom(ns)} WHERE f.company_id = ${c} AND f.business_id = ${b} AND lower(f.filing) = lower(${fi}) AND lower(f.authority) = lower(${a}) AND f.period_label = ${pl}`,
    params: p.values,
  };
}

export interface FilingInsert {
  id: string;
  businessId: string;
  filing: string;
  authority: string;
  periodLabel: string;
  periodStart: string | null;
  periodEnd: string | null;
  dueDate: string;
  preparer: Preparer | null;
  issueId: string | null;
  notes: string | null;
}

/**
 * Insert a filing row, status upcoming. ON CONFLICT DO NOTHING against the
 * (business, filing, authority, period) unique index is what makes rolling the
 * calendar forward idempotent: the second identical insert changes nothing.
 */
export function buildInsertFiling(ns: string, companyId: string, f: FilingInsert): SqlStatement {
  const { p, c } = start(companyId);
  const vals = [
    p.add(f.id),
    c,
    p.add(f.businessId),
    p.add(f.filing),
    p.add(f.authority),
    p.add(f.periodLabel),
    `${p.add(f.periodStart)}::date`,
    `${p.add(f.periodEnd)}::date`,
    `${p.add(f.dueDate)}::date`,
    p.add(f.preparer),
    p.add(f.issueId),
    p.add(f.notes),
  ];
  return {
    text: `INSERT INTO ${ns}.business_filings (id, company_id, business_id, filing, authority, period_label, period_start, period_end, due_date, preparer, issue_id, notes) VALUES (${vals.join(", ")}) ON CONFLICT DO NOTHING`,
    params: p.values,
  };
}

export const FILING_PATCH_COLUMNS = {
  periodStart: { col: "period_start", kind: "date" },
  periodEnd: { col: "period_end", kind: "date" },
  dueDate: { col: "due_date", kind: "date" },
  preparer: { col: "preparer", kind: "text" },
  issueId: { col: "issue_id", kind: "uuid" },
  notes: { col: "notes", kind: "text" },
} as const;

export type FilingPatchKey = keyof typeof FILING_PATCH_COLUMNS;
export type FilingPatch = Partial<Record<FilingPatchKey, string | null>>;

export function buildUpdateFiling(
  ns: string,
  companyId: string,
  filingId: string,
  patch: FilingPatch,
): SqlStatement | null {
  const { p, c } = start(companyId);
  const sets: string[] = [];
  for (const key of Object.keys(patch) as FilingPatchKey[]) {
    const spec = FILING_PATCH_COLUMNS[key];
    if (!spec) continue;
    const ph = p.add(patch[key] ?? null);
    sets.push(spec.kind === "date" ? `${spec.col} = ${ph}::date` : spec.kind === "uuid" ? `${spec.col} = ${ph}::uuid` : `${spec.col} = ${ph}`);
  }
  if (sets.length === 0) return null;
  sets.push("updated_at = now()");
  const id = p.add(filingId);
  return {
    text: `UPDATE ${ns}.business_filings SET ${sets.join(", ")} WHERE company_id = ${c} AND id = ${id}`,
    params: p.values,
  };
}

/**
 * Move a filing to a new status. Like buildSetStatus, the expected current
 * status is part of the WHERE clause so a concurrent change is detected.
 * Moving to anything other than not_required clears the not-required reason.
 */
export function buildSetFilingStatus(
  ns: string,
  companyId: string,
  filingId: string,
  next: {
    status: FilingStatus;
    proofDocumentId: string | null;
    extendedDueDate: string | null;
    reason: string | null;
    source: unknown;
  },
  expectedCurrent: FilingStatus,
): SqlStatement {
  const { p, c } = start(companyId);
  const sets = [`status = ${p.add(next.status)}`];
  if (next.proofDocumentId) sets.push(`proof_document_id = ${p.add(next.proofDocumentId)}::uuid`);
  if (next.extendedDueDate) sets.push(`extended_due_date = ${p.add(next.extendedDueDate)}::date`);
  if (next.status === "not_required") {
    sets.push(`not_required_reason = ${p.add(next.reason)}`);
    sets.push(`not_required_source = ${p.add(jsonText(next.source))}::jsonb`);
  } else {
    sets.push("not_required_reason = NULL", "not_required_source = NULL");
  }
  sets.push("updated_at = now()");
  const id = p.add(filingId);
  const e = p.add(expectedCurrent);
  return {
    text: `UPDATE ${ns}.business_filings SET ${sets.join(", ")} WHERE company_id = ${c} AND id = ${id} AND status = ${e}`,
    params: p.values,
  };
}

export interface FilingFilter {
  businessId?: string;
  statuses?: FilingStatus[];
  /** Open filings whose effective due date falls from `today` to this date inclusive. */
  dueOnOrBefore?: string;
  /** Open filings whose effective due date is before this date (normally today). */
  overdueBefore?: string;
  /** Required when dueOnOrBefore is set: the first day of the "due soon" window. */
  today?: string;
  openOnly?: boolean;
}

const OPEN_FILING_SQL = "f.status NOT IN ('filed', 'accepted', 'not_required')";
const EFFECTIVE_DUE_SQL = "COALESCE(f.extended_due_date, f.due_date)";

/**
 * List filings, next due first. When both the "due soon" and "overdue"
 * filters are given, a filing matching either is returned, because together
 * they answer "what needs attention".
 */
export function buildListFilings(ns: string, companyId: string, f: FilingFilter = {}): SqlStatement {
  const { p, c } = start(companyId);
  const where = [`f.company_id = ${c}`];
  if (f.businessId) where.push(`f.business_id = ${p.add(f.businessId)}`);
  if (f.statuses && f.statuses.length > 0) {
    where.push(`f.status IN (${f.statuses.map((s) => p.add(s)).join(", ")})`);
  }
  if (f.openOnly) where.push(OPEN_FILING_SQL);
  const windows: string[] = [];
  if (f.dueOnOrBefore) {
    const from = p.add(f.today ?? "1970-01-01");
    const to = p.add(f.dueOnOrBefore);
    windows.push(`(${EFFECTIVE_DUE_SQL} >= ${from}::date AND ${EFFECTIVE_DUE_SQL} <= ${to}::date)`);
  }
  if (f.overdueBefore) {
    windows.push(`${EFFECTIVE_DUE_SQL} < ${p.add(f.overdueBefore)}::date`);
  }
  if (windows.length > 0) {
    where.push(OPEN_FILING_SQL);
    where.push(`(${windows.join(" OR ")})`);
  }
  return {
    text: `SELECT ${FILING_COLUMNS} FROM ${filingFrom(ns)} WHERE ${where.join(" AND ")} ORDER BY ${EFFECTIVE_DUE_SQL} ASC, lower(b.name), lower(f.filing) LIMIT 500`,
    params: p.values,
  };
}

// ---- Issue links ----

export function buildGetLink(ns: string, companyId: string, businessId: string, issueId: string): SqlStatement {
  const { p, c } = start(companyId);
  const b = p.add(businessId);
  const i = p.add(issueId);
  return {
    text: `SELECT l.company_id, l.business_id, l.issue_id, l.role, l.created_at FROM ${ns}.business_issue_links l WHERE l.company_id = ${c} AND l.business_id = ${b} AND l.issue_id = ${i}`,
    params: p.values,
  };
}

export function buildInsertLink(
  ns: string,
  companyId: string,
  businessId: string,
  issueId: string,
  role: string,
): SqlStatement {
  const { p, c } = start(companyId);
  const b = p.add(businessId);
  const i = p.add(issueId);
  const r = p.add(role);
  return {
    text: `INSERT INTO ${ns}.business_issue_links (company_id, business_id, issue_id, role) VALUES (${c}, ${b}, ${i}, ${r}) ON CONFLICT DO NOTHING`,
    params: p.values,
  };
}

export function buildUpdateLinkRole(
  ns: string,
  companyId: string,
  businessId: string,
  issueId: string,
  role: string,
): SqlStatement {
  const { p, c } = start(companyId);
  const r = p.add(role);
  const b = p.add(businessId);
  const i = p.add(issueId);
  return {
    text: `UPDATE ${ns}.business_issue_links SET role = ${r} WHERE company_id = ${c} AND business_id = ${b} AND issue_id = ${i}`,
    params: p.values,
  };
}

export function buildListLinks(ns: string, companyId: string, businessId: string): SqlStatement {
  const { p, c } = start(companyId);
  const b = p.add(businessId);
  return {
    text: `SELECT l.company_id, l.business_id, l.issue_id, l.role, l.created_at FROM ${ns}.business_issue_links l WHERE l.company_id = ${c} AND l.business_id = ${b} ORDER BY l.created_at DESC LIMIT 200`,
    params: p.values,
  };
}

// ---- History ----

export interface HistoryInsert {
  id: string;
  businessId: string;
  kind: string;
  subjectId: string | null;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  asOf: string | null;
  source: unknown;
  actor: unknown;
}

export function buildInsertHistory(ns: string, companyId: string, h: HistoryInsert): SqlStatement {
  const { p, c } = start(companyId);
  const vals = [
    p.add(h.id),
    c,
    p.add(h.businessId),
    p.add(h.kind),
    `${p.add(h.subjectId)}::uuid`,
    p.add(h.field),
    p.add(h.oldValue),
    p.add(h.newValue),
    `${p.add(h.asOf)}::date`,
    `${p.add(jsonText(h.source))}::jsonb`,
    `${p.add(jsonText(h.actor))}::jsonb`,
  ];
  return {
    text: `INSERT INTO ${ns}.business_history (id, company_id, business_id, kind, subject_id, field, old_value, new_value, as_of, source, actor) VALUES (${vals.join(", ")})`,
    params: p.values,
  };
}

export function buildListHistory(
  ns: string,
  companyId: string,
  f: { businessId?: string; since?: string; limit?: number } = {},
): SqlStatement {
  const { p, c } = start(companyId);
  const where = [`h.company_id = ${c}`];
  if (f.businessId) where.push(`h.business_id = ${p.add(f.businessId)}`);
  if (f.since) where.push(`h.created_at > ${p.add(f.since)}::timestamptz`);
  const limit = p.add(Math.max(1, Math.min(f.limit ?? 100, 500)));
  return {
    text: `SELECT h.id, h.company_id, h.business_id, h.kind, h.subject_id, h.field, h.old_value, h.new_value, h.as_of::text AS as_of, h.source, h.actor, h.created_at, b.name AS business_name FROM ${ns}.business_history h JOIN ${ns}.businesses b ON b.id = h.business_id AND b.company_id = h.company_id WHERE ${where.join(" AND ")} ORDER BY h.created_at DESC, h.id DESC LIMIT ${limit}::int`,
    params: p.values,
  };
}
