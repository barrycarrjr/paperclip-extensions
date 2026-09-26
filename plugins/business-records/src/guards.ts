/**
 * The rules this plugin enforces in code rather than trusting to a prompt.
 *
 * Pure decisions. The service looks up whatever document an input points at
 * (scoped to the calling company) and hands the result in here, so every rule
 * can be tested without a database.
 *
 * 1. A business cannot be marked legally active or dissolved, or its tax
 *    account open, final-return-filed or closed, unless a document on file for
 *    that same business proves it. A person saying so, or an agent concluding
 *    so, is never enough.
 * 2. A filing cannot be marked filed, accepted or extension_filed without a
 *    proof document on file, and cannot be marked not_required without a
 *    written reason and a professional or official source.
 */

import type { FilingStatus, StatusField, StatusSource } from "./domain.js";
import {
  CLOSED_FILING_STATUSES,
  FILING_STATUSES,
  NOT_REQUIRED_SOURCE_KINDS,
  PROOF_REQUIRED_FILING_STATUSES,
  PROOF_REQUIRED_STATUS,
  PROOF_SOURCE_KINDS,
  STATUS_VALUES,
} from "./domain.js";
import { RecordsError, invalid } from "./validate.js";

/** What the service found when it looked up a document id, scoped to the calling company. */
export interface DocLookup {
  id: string;
  business_id: string;
  replaced_by: string | null;
}

/** Why a document cannot be used as proof, or null when it can. */
export function documentProblem(doc: DocLookup | null, businessId: string): string | null {
  if (!doc) return "no document with that id is on file for this company";
  if (doc.business_id !== businessId) return "that document belongs to a different business";
  if (doc.replaced_by) return "that document has been replaced by a newer version; cite the current one";
  return null;
}

export function statusNeedsProof(field: StatusField, value: string): boolean {
  return PROOF_REQUIRED_STATUS[field].includes(value);
}

/**
 * Decide whether a status change may go ahead. Throws when it may not.
 *
 * `doc` is the lookup result for `source.documentId` (null when no id was
 * given or nothing was found).
 */
export function checkStatusChange(args: {
  field: StatusField;
  value: string;
  source: StatusSource;
  businessId: string;
  doc: DocLookup | null;
}): void {
  const { field, value, source, businessId, doc } = args;
  const allowed = STATUS_VALUES[field];
  if (!allowed.includes(value)) {
    throw invalid(`value for ${field} status must be one of: ${allowed.join(", ")}.`);
  }

  const isProofKind = (PROOF_SOURCE_KINDS as readonly string[]).includes(source.kind);

  if (statusNeedsProof(field, value)) {
    if (!isProofKind) {
      throw new RecordsError(
        "EPROOF_REQUIRED",
        `${field} status ${value} can only be set from a document on file. A ${source.kind} source cannot set it. Upload the proof (for example the state approval, the dissolution certificate, the tax id letter or the account closure letter) to the business records issue, add it with business_add_document, then call again with source {kind: "document", documentId}.`,
      );
    }
    if (!source.documentId) {
      throw new RecordsError(
        "EPROOF_REQUIRED",
        `${field} status ${value} needs source.documentId pointing at the proof document in business_documents.`,
      );
    }
    const problem = documentProblem(doc, businessId);
    if (problem) {
      throw new RecordsError("EPROOF_REQUIRED", `${field} status ${value} needs a current proof document: ${problem}.`);
    }
    return;
  }

  // Values that do not need proof may still cite a document. If they do, the
  // citation has to be real, or history would record a source that is not there.
  if (isProofKind) {
    if (!source.documentId) {
      throw invalid(`a ${source.kind} source needs source.documentId pointing at a document in business_documents.`);
    }
    const problem = documentProblem(doc, businessId);
    if (problem) throw new RecordsError("EDOCUMENT_NOT_FOUND", `source.documentId: ${problem}.`);
  }
}

/**
 * A reason that only says the business had no revenue. Zero revenue is never
 * on its own a reason a filing is not required, so the guard refuses it and
 * asks for the actual rule or advice.
 */
export function isZeroRevenueOnlyReason(reason: string): boolean {
  const normalised = reason.toLowerCase().replace(/[.!\s]+$/g, "").replace(/\s+/g, " ").trim();
  return /^(there (was|were) )?(zero|no|\$0|0) (revenue|income|sales|receipts|activity)( (this|that|for the) (year|period|quarter))?$/.test(
    normalised,
  );
}

export interface FilingStatusInput {
  status: FilingStatus;
  businessId: string;
  dueDate: string;
  proofDocumentId?: string | null;
  proofDoc: DocLookup | null;
  extendedDueDate?: string | null;
  reason?: string | null;
  source?: StatusSource | null;
  sourceDoc: DocLookup | null;
  hasNextPeriod: boolean;
}

/** Decide whether a filing status change may go ahead. Throws when it may not. */
export function checkFilingStatusChange(input: FilingStatusInput): void {
  const { status } = input;
  if (!(FILING_STATUSES as readonly string[]).includes(status)) {
    throw invalid(`status must be one of: ${FILING_STATUSES.join(", ")}.`);
  }

  const needsProof = PROOF_REQUIRED_FILING_STATUSES.includes(status);

  if (!needsProof && input.proofDocumentId) {
    throw invalid(`proofDocumentId is only used with ${PROOF_REQUIRED_FILING_STATUSES.join(", ")}.`);
  }
  if (status !== "extension_filed" && input.extendedDueDate) {
    throw invalid("extendedDueDate is only used with status extension_filed.");
  }
  if (status !== "not_required" && (input.reason || input.source)) {
    throw invalid("reason and source are only used with status not_required.");
  }
  if (input.hasNextPeriod && status !== "filed" && status !== "accepted") {
    throw invalid("nextPeriod is only used when marking a filing filed or accepted.");
  }

  if (needsProof) {
    if (!input.proofDocumentId) {
      throw new RecordsError(
        "EPROOF_REQUIRED",
        `status ${status} needs proofDocumentId: the filed return confirmation, the acceptance, or the extension confirmation, added first with business_add_document.`,
      );
    }
    const problem = documentProblem(input.proofDoc, input.businessId);
    if (problem) throw new RecordsError("EPROOF_REQUIRED", `proofDocumentId: ${problem}.`);
  }

  if (status === "extension_filed") {
    if (!input.extendedDueDate) {
      throw invalid("status extension_filed needs extendedDueDate, the new due date the extension gives.");
    }
    if (input.extendedDueDate <= input.dueDate) {
      throw invalid("extendedDueDate must be later than the original due date.");
    }
  }

  if (status === "not_required") {
    const reason = (input.reason ?? "").trim();
    if (!reason) {
      throw new RecordsError(
        "EREASON_SOURCE_REQUIRED",
        "status not_required needs a written reason explaining why this filing does not apply.",
      );
    }
    if (isZeroRevenueOnlyReason(reason)) {
      throw new RecordsError(
        "EREASON_SOURCE_REQUIRED",
        "zero revenue is not on its own a reason a filing is not required. Give the rule or the professional advice that says so.",
      );
    }
    const source = input.source;
    if (!source) {
      throw new RecordsError(
        "EREASON_SOURCE_REQUIRED",
        `status not_required needs a source with kind ${NOT_REQUIRED_SOURCE_KINDS.join(", ")}.`,
      );
    }
    if (!(NOT_REQUIRED_SOURCE_KINDS as readonly string[]).includes(source.kind)) {
      throw new RecordsError(
        "EREASON_SOURCE_REQUIRED",
        `a ${source.kind} source cannot establish that a filing is not required. Use kind ${NOT_REQUIRED_SOURCE_KINDS.join(", ")} (for example the CPA note as a document, or the official rule by https url).`,
      );
    }
    if (source.documentId) {
      const problem = documentProblem(input.sourceDoc, input.businessId);
      if (problem) throw new RecordsError("EREASON_SOURCE_REQUIRED", `source.documentId: ${problem}.`);
    } else if (!source.url || !/^https:\/\/[^\s/]+\.[^\s]+$/i.test(source.url)) {
      throw new RecordsError(
        "EREASON_SOURCE_REQUIRED",
        "the not_required source needs either documentId (a document on file) or an https:// url of the official guidance.",
      );
    }
  }
}

export function isOpenFiling(status: FilingStatus): boolean {
  return !CLOSED_FILING_STATUSES.includes(status);
}
