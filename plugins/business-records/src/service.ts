/**
 * The operations behind every tool and API route.
 *
 * Takes its database and issue lookup as injected dependencies, so the same
 * code runs inside the worker (against ctx.db and ctx.issues) and inside the
 * Postgres test (against a throwaway schema). Company access has already been
 * checked by the caller; every query here is still scoped to call.companyId.
 *
 * Each operation parses its own raw input, so the tests exercise exactly what
 * an agent would send.
 */

import { randomUUID } from "node:crypto";
import type {
  Actor,
  BusinessApi,
  BusinessRow,
  DocumentApi,
  DocumentRow,
  FilingApi,
  FilingRow,
  FilingStatus,
  HistoryApi,
  HistoryRow,
  LinkApi,
  LinkRow,
  StatusField,
  StatusSource,
} from "./domain.js";
import {
  DOC_TYPES,
  FILING_STATUSES,
  PREPARERS,
  RELATIONSHIPS,
  STATUS_COLUMN,
  STATUS_FIELDS,
  businessToApi,
  documentToApi,
  filingToApi,
  historyToApi,
  linkToApi,
} from "./domain.js";
import { checkFilingStatusChange, checkStatusChange, type DocLookup } from "./guards.js";
import {
  addDays,
  buildFindBusinessByName,
  buildFindDuplicateDocument,
  buildFindFilingByKey,
  buildGetBusiness,
  buildGetDocument,
  buildGetFiling,
  buildGetLink,
  buildInsertBusiness,
  buildInsertDocument,
  buildInsertFiling,
  buildInsertHistory,
  buildInsertLink,
  buildListBusinesses,
  buildListDocuments,
  buildListFilings,
  buildListHistory,
  buildListLinks,
  buildMarkReplaced,
  buildSetFilingStatus,
  buildSetStatus,
  buildUpdateBusiness,
  buildUpdateFiling,
  buildUpdateLinkRole,
  type BusinessPatch,
  type FilingPatch,
  type SqlStatement,
} from "./sql.js";
import {
  RecordsError,
  assertNoSensitiveIds,
  canonicalContacts,
  invalid,
  parseContacts,
  parseDate,
  parseEnum,
  parseNotRequiredSource,
  parseOptionalDate,
  parseOptionalEnum,
  parseOptionalText,
  parseOptionalUuid,
  parsePositiveInt,
  parseRole,
  parseStatusSource,
  parseStringArray,
  parseTaxIdLast4,
  parseText,
  parseTimestamp,
  parseUuid,
  parseUuidArray,
  readParams,
  todayLocal,
} from "./validate.js";

// ---- Dependencies ----

export interface RecordsDb {
  namespace: string;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
}

export interface IssueInfo {
  id: string;
  title: string;
  status: string;
  identifier: string | null;
  dueDate: string | null;
}

/** Returns the issue when it exists in that company, otherwise null. */
export type IssueLookup = (issueId: string, companyId: string) => Promise<IssueInfo | null>;

export interface ServiceDeps {
  db: RecordsDb;
  getIssue: IssueLookup;
  newId?: () => string;
  /** Today's date YYYY-MM-DD. Injected so tests can pin it. */
  today?: () => string;
}

export interface CallContext {
  companyId: string;
  actor: Actor;
}

export interface OpResult<T = unknown> {
  /** Short plain-text summary for the agent. */
  summary: string;
  data: T;
}

// ---- Helpers ----

const NOT_FOUND_BUSINESS = () =>
  new RecordsError("EBUSINESS_NOT_FOUND", "no business with that id in this company. Use business_list to find it.");
const NOT_FOUND_FILING = () =>
  new RecordsError("EFILING_NOT_FOUND", "no filing with that id in this company. Use business_list_filings to find it.");

function stableSource(source: unknown): string {
  if (!source || typeof source !== "object") return "null";
  const s = source as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(s).sort()) {
    if (s[key] !== undefined && s[key] !== null) ordered[key] = s[key];
  }
  return JSON.stringify(ordered);
}

function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function createRecordsService(deps: ServiceDeps) {
  const { db } = deps;
  const ns = db.namespace;
  const newId = deps.newId ?? randomUUID;
  const today = deps.today ?? (() => todayLocal());

  const q = <T>(s: SqlStatement) => db.query<T>(s.text, s.params);
  const x = (s: SqlStatement) => db.execute(s.text, s.params);

  async function loadBusiness(companyId: string, businessId: string): Promise<BusinessRow> {
    const rows = await q<BusinessRow>(buildGetBusiness(ns, companyId, businessId));
    if (rows.length === 0) throw NOT_FOUND_BUSINESS();
    return rows[0]!;
  }

  async function lookupDoc(companyId: string, documentId: string | undefined | null): Promise<DocLookup | null> {
    if (!documentId) return null;
    const rows = await q<DocumentRow>(buildGetDocument(ns, companyId, documentId));
    return rows[0] ?? null;
  }

  async function requireIssue(companyId: string, issueId: string): Promise<IssueInfo> {
    let issue: IssueInfo | null = null;
    try {
      issue = await deps.getIssue(issueId, companyId);
    } catch {
      issue = null;
    }
    if (!issue) {
      throw new RecordsError(
        "EISSUE_NOT_FOUND",
        "that issue does not exist in this company. Documents, links and filings can only point at issues in the calling company.",
      );
    }
    return issue;
  }

  async function writeHistory(
    call: CallContext,
    h: {
      businessId: string;
      kind: string;
      subjectId?: string | null;
      field?: string | null;
      oldValue?: string | null;
      newValue?: string | null;
      asOf?: string | null;
      source?: unknown;
    },
  ): Promise<void> {
    await x(
      buildInsertHistory(ns, call.companyId, {
        id: newId(),
        businessId: h.businessId,
        kind: h.kind,
        subjectId: h.subjectId ?? null,
        field: h.field ?? null,
        oldValue: h.oldValue ?? null,
        newValue: h.newValue ?? null,
        asOf: h.asOf ?? null,
        source: h.source ?? null,
        actor: call.actor,
      }),
    );
  }

  async function linksWithIssues(companyId: string, businessId: string): Promise<LinkApi[]> {
    const rows = await q<LinkRow>(buildListLinks(ns, companyId, businessId));
    const out: LinkApi[] = [];
    for (const row of rows) {
      const link = linkToApi(row);
      let issue: IssueInfo | null = null;
      try {
        issue = await deps.getIssue(row.issue_id, companyId);
      } catch {
        issue = null;
      }
      link.issue = issue
        ? { title: issue.title, status: issue.status, identifier: issue.identifier, dueDate: issue.dueDate }
        : null;
      out.push(link);
    }
    return out;
  }

  // ---- Businesses ----

  async function listBusinesses(call: CallContext, raw: unknown): Promise<OpResult<{ businesses: BusinessApi[] }>> {
    const p = readParams(raw);
    const relationship = parseOptionalEnum(p.relationship, RELATIONSHIPS, "relationship") ?? undefined;
    const query = parseOptionalText(p.query, "query", 200) ?? undefined;
    const rows = await q<BusinessRow>(buildListBusinesses(ns, call.companyId, { relationship, query }));
    const businesses = rows.map(businessToApi);
    const summary =
      businesses.length === 0
        ? "No businesses match."
        : businesses
            .map(
              (b) =>
                `${b.name} (${b.relationship}): operating ${b.statuses.operating.value}, legal ${b.statuses.legal.value}, tax account ${b.statuses.tax_account.value} [id ${b.id}]`,
            )
            .join("\n");
    return { summary, data: { businesses } };
  }

  async function getBusiness(
    call: CallContext,
    raw: unknown,
  ): Promise<OpResult<{ business: BusinessApi; links: LinkApi[]; documents: DocumentApi[]; openFilings: FilingApi[] }>> {
    const p = readParams(raw);
    const businessId = parseUuid(p.businessId, "businessId");
    const business = businessToApi(await loadBusiness(call.companyId, businessId));
    const links = await linksWithIssues(call.companyId, businessId);
    const documents = (await q<DocumentRow>(buildListDocuments(ns, call.companyId, { businessId }))).map(documentToApi);
    const openFilings = (
      await q<FilingRow>(buildListFilings(ns, call.companyId, { businessId, openOnly: true }))
    ).map(filingToApi);
    const s = business.statuses;
    const summary = [
      `${business.name} (${business.relationship})`,
      `Operating: ${s.operating.value}${s.operating.asOf ? ` as of ${s.operating.asOf}` : ""}`,
      `Legal: ${s.legal.value}${s.legal.asOf ? ` as of ${s.legal.asOf}` : ""}`,
      `Tax account: ${s.tax_account.value}${s.tax_account.asOf ? ` as of ${s.tax_account.asOf}` : ""}`,
      `${documents.length} current document(s), ${openFilings.length} open filing(s), ${links.length} linked issue(s).`,
    ].join("\n");
    return { summary, data: { business, links, documents, openFilings } };
  }

  interface ParsedStatus {
    value: string;
    asOf: string;
    source: StatusSource;
  }

  function parseStatusInput(raw: unknown, field: StatusField, path: string): ParsedStatus {
    const obj = readParams(raw);
    if (typeof obj.value !== "string") throw invalid(`${path}.value is required.`);
    return {
      value: obj.value,
      asOf: parseDate(obj.asOf, `${path}.asOf`),
      source: parseStatusSource(obj.source, `${path}.source`),
    };
  }

  async function upsertBusiness(
    call: CallContext,
    raw: unknown,
  ): Promise<OpResult<{ business: BusinessApi; created: boolean; changed: string[] }>> {
    const p = readParams(raw);
    assertNoSensitiveIds(p);

    const id = parseOptionalUuid(p.id, "id") ?? undefined;
    const name = p.name === undefined ? undefined : parseText(p.name, "name", 200);
    const patch: BusinessPatch = {};
    const setIf = (key: keyof BusinessPatch, value: unknown) => {
      if (value !== undefined) patch[key] = value;
    };
    setIf("name", name);
    setIf("otherNames", parseStringArray(p.otherNames, "otherNames"));
    setIf("relationship", parseOptionalEnum(p.relationship, RELATIONSHIPS, "relationship") ?? undefined);
    setIf("legalForm", parseOptionalText(p.legalForm, "legalForm", 100));
    setIf("formationState", parseOptionalText(p.formationState, "formationState", 100));
    setIf("registrationStates", parseStringArray(p.registrationStates, "registrationStates"));
    setIf("taxClassification", parseOptionalText(p.taxClassification, "taxClassification", 100));
    setIf("taxClassificationEffective", parseOptionalDate(p.taxClassificationEffective, "taxClassificationEffective"));
    setIf("linkedCompanyIds", parseUuidArray(p.linkedCompanyIds, "linkedCompanyIds"));
    setIf("contacts", parseContacts(p.contacts));
    setIf("notes", parseOptionalText(p.notes, "notes", 10000));
    setIf("taxIdLast4", parseTaxIdLast4(p.taxIdLast4));

    const statuses: Partial<Record<StatusField, ParsedStatus>> = {};
    if (p.statuses !== undefined && p.statuses !== null) {
      const s = readParams(p.statuses);
      for (const key of Object.keys(s)) {
        if (!(STATUS_FIELDS as readonly string[]).includes(key)) {
          throw invalid(`statuses.${key} is not a status. Use operating, legal or tax_account.`);
        }
        statuses[key as StatusField] = parseStatusInput(s[key], key as StatusField, `statuses.${key}`);
      }
    }

    let existing: BusinessRow | null = null;
    if (id) {
      existing = await loadBusiness(call.companyId, id);
    } else if (name) {
      existing = (await q<BusinessRow>(buildFindBusinessByName(ns, call.companyId, name)))[0] ?? null;
    } else {
      throw invalid("give either id (to update a business) or name (to find or create one).");
    }

    if (!existing) {
      if (!name) throw invalid("name is required to create a business.");
      if (patch.relationship === undefined) {
        throw invalid(`relationship is required to create a business: one of ${RELATIONSHIPS.join(", ")}.`);
      }
      const newBusinessId = newId();
      // Initial statuses go through the same guard as business_set_status.
      // A proof-only value cannot pass, since no document can exist yet for
      // a business that does not exist yet.
      for (const field of Object.keys(statuses) as StatusField[]) {
        const s = statuses[field]!;
        checkStatusChange({
          field,
          value: s.value,
          source: s.source,
          businessId: newBusinessId,
          doc: await lookupDoc(call.companyId, s.source.documentId),
        });
      }
      const result = await x(
        buildInsertBusiness(ns, call.companyId, {
          id: newBusinessId,
          name,
          otherNames: (patch.otherNames as string[]) ?? [],
          relationship: patch.relationship as string,
          legalForm: (patch.legalForm as string | null) ?? null,
          formationState: (patch.formationState as string | null) ?? null,
          registrationStates: (patch.registrationStates as string[]) ?? [],
          taxClassification: (patch.taxClassification as string | null) ?? null,
          taxClassificationEffective: (patch.taxClassificationEffective as string | null) ?? null,
          linkedCompanyIds: (patch.linkedCompanyIds as string[]) ?? [],
          contacts: (patch.contacts as unknown[]) ?? [],
          notes: (patch.notes as string | null) ?? null,
          taxIdLast4: (patch.taxIdLast4 as string | null) ?? null,
          statuses,
        }),
      );
      if (result.rowCount > 0) {
        await writeHistory(call, { businessId: newBusinessId, kind: "business_created", newValue: name });
        for (const field of Object.keys(statuses) as StatusField[]) {
          const s = statuses[field]!;
          if (s.value === "unknown") continue;
          await writeHistory(call, {
            businessId: newBusinessId,
            kind: "status_change",
            field: STATUS_COLUMN[field],
            oldValue: "unknown",
            newValue: s.value,
            asOf: s.asOf,
            source: s.source,
          });
        }
        const business = businessToApi(await loadBusiness(call.companyId, newBusinessId));
        return {
          summary: `Created business ${business.name} [id ${business.id}].`,
          data: { business, created: true, changed: [] },
        };
      }
      // Lost a race with another call creating the same name: carry on as an update.
      existing = (await q<BusinessRow>(buildFindBusinessByName(ns, call.companyId, name)))[0] ?? null;
      if (!existing) throw new RecordsError("ECONFLICT", "the business could not be created or found; try again.");
    }

    // ---- Update an existing business ----
    // Matched by name (case-insensitive): the name is the lookup key, not a
    // change. Renaming, including a change of letter case, needs the id.
    if (!id) delete patch.name;
    for (const field of Object.keys(statuses) as StatusField[]) {
      const current = existing[STATUS_COLUMN[field]];
      if (statuses[field]!.value !== current) {
        throw invalid(
          `business_upsert does not change statuses on an existing business (${field} is ${current}). Use business_set_status, which checks the proof rules and records history.`,
        );
      }
    }

    const currentValues: Record<keyof BusinessPatch, unknown> = {
      name: existing.name,
      otherNames: existing.other_names ?? [],
      relationship: existing.relationship,
      legalForm: existing.legal_form,
      formationState: existing.formation_state,
      registrationStates: existing.registration_states ?? [],
      taxClassification: existing.tax_classification,
      taxClassificationEffective: existing.tax_classification_effective,
      linkedCompanyIds: existing.linked_company_ids ?? [],
      contacts: canonicalContacts(existing.contacts),
      notes: existing.notes,
      taxIdLast4: existing.tax_id_last4,
    };

    const changedPatch: BusinessPatch = {};
    for (const key of Object.keys(patch) as (keyof BusinessPatch)[]) {
      if (!sameValue(patch[key], currentValues[key])) changedPatch[key] = patch[key];
    }
    const changed = Object.keys(changedPatch) as (keyof BusinessPatch)[];
    if (changed.length === 0) {
      return {
        summary: `No change: ${existing.name} already matches [id ${existing.id}].`,
        data: { business: businessToApi(existing), created: false, changed: [] },
      };
    }

    if (changedPatch.name !== undefined) {
      const clash = (await q<BusinessRow>(buildFindBusinessByName(ns, call.companyId, changedPatch.name as string)))[0];
      if (clash && clash.id !== existing.id) {
        throw new RecordsError("EBUSINESS_NAME_TAKEN", "another business in this company already has that name.");
      }
    }

    try {
      await x(buildUpdateBusiness(ns, call.companyId, existing.id, changedPatch)!);
    } catch (err) {
      if (/duplicate key|unique/i.test((err as Error).message ?? "")) {
        throw new RecordsError("EBUSINESS_NAME_TAKEN", "another business in this company already has that name.");
      }
      throw err;
    }
    for (const key of changed) {
      await writeHistory(call, {
        businessId: existing.id,
        kind: "business_updated",
        field: key,
        oldValue: asText(currentValues[key]),
        newValue: asText(changedPatch[key]),
      });
    }
    const business = businessToApi(await loadBusiness(call.companyId, existing.id));
    return {
      summary: `Updated ${business.name}: ${changed.join(", ")} [id ${business.id}].`,
      data: { business, created: false, changed },
    };
  }

  async function setStatus(
    call: CallContext,
    raw: unknown,
  ): Promise<OpResult<{ business: BusinessApi; changed: boolean }>> {
    const p = readParams(raw);
    assertNoSensitiveIds(p);
    const businessId = parseUuid(p.businessId, "businessId");
    const field = parseEnum(p.field, STATUS_FIELDS, "field");
    if (typeof p.value !== "string") throw invalid("value is required.");
    const value = p.value;
    const asOf = parseDate(p.asOf, "asOf");
    const source = parseStatusSource(p.source, "source");

    const existing = await loadBusiness(call.companyId, businessId);
    checkStatusChange({
      field,
      value,
      source,
      businessId,
      doc: await lookupDoc(call.companyId, source.documentId),
    });

    const col = STATUS_COLUMN[field];
    const current = existing[col];
    const currentAsOf = existing[`${col}_as_of` as `${typeof col}_as_of`];
    const currentSource = existing[`${col}_source` as `${typeof col}_source`];
    if (current === value && currentAsOf === asOf && stableSource(currentSource) === stableSource(source)) {
      return {
        summary: `No change: ${existing.name} ${field} status is already ${value} as of ${asOf}.`,
        data: { business: businessToApi(existing), changed: false },
      };
    }

    const result = await x(buildSetStatus(ns, call.companyId, businessId, field, { value, asOf, source }, current));
    if (result.rowCount === 0) {
      throw new RecordsError("ECONFLICT", "the status changed while this call was running. Read it again with business_get and retry.");
    }
    await writeHistory(call, {
      businessId,
      kind: "status_change",
      field: col,
      oldValue: current,
      newValue: value,
      asOf,
      source,
    });
    const business = businessToApi(await loadBusiness(call.companyId, businessId));
    return {
      summary: `${business.name}: ${field} status ${current} changed to ${value} as of ${asOf} (source: ${source.kind}).`,
      data: { business, changed: true },
    };
  }

  async function linkIssue(
    call: CallContext,
    raw: unknown,
  ): Promise<OpResult<{ link: LinkApi; created: boolean; changed: boolean }>> {
    const p = readParams(raw);
    assertNoSensitiveIds(p);
    const businessId = parseUuid(p.businessId, "businessId");
    const issueId = parseUuid(p.issueId, "issueId");
    const role = parseRole(p.role);
    const business = await loadBusiness(call.companyId, businessId);
    const issue = await requireIssue(call.companyId, issueId);

    const existing = (await q<LinkRow>(buildGetLink(ns, call.companyId, businessId, issueId)))[0];
    let created = false;
    let changed = false;
    if (!existing) {
      const r = await x(buildInsertLink(ns, call.companyId, businessId, issueId, role));
      created = r.rowCount > 0;
    } else if (existing.role !== role) {
      await x(buildUpdateLinkRole(ns, call.companyId, businessId, issueId, role));
      changed = true;
    }
    const row = (await q<LinkRow>(buildGetLink(ns, call.companyId, businessId, issueId)))[0]!;
    const link = linkToApi(row);
    link.issue = { title: issue.title, status: issue.status, identifier: issue.identifier, dueDate: issue.dueDate };
    const label = issue.identifier ?? issue.id;
    return {
      summary: created
        ? `Linked ${label} to ${business.name} as ${role}.`
        : changed
          ? `Changed the link between ${label} and ${business.name} to ${role}.`
          : `No change: ${label} is already linked to ${business.name} as ${role}.`,
      data: { link, created, changed },
    };
  }

  async function history(call: CallContext, raw: unknown): Promise<OpResult<{ history: HistoryApi[] }>> {
    const p = readParams(raw);
    const businessId = parseOptionalUuid(p.businessId, "businessId") ?? undefined;
    if (businessId) await loadBusiness(call.companyId, businessId);
    const since = p.since === undefined || p.since === null ? undefined : parseTimestamp(p.since, "since");
    const limit = parsePositiveInt(p.limit, "limit", 500);
    const rows = await q<HistoryRow>(buildListHistory(ns, call.companyId, { businessId, since, limit }));
    const items = rows.map(historyToApi);
    const summary =
      items.length === 0
        ? since
          ? `Nothing changed since ${since}.`
          : "No history yet."
        : items
            .map((h) => {
              const what =
                h.kind === "status_change" || h.kind === "filing_status_change" || h.kind === "business_updated"
                  ? `${h.field}: ${h.oldValue ?? "(none)"} to ${h.newValue ?? "(none)"}`
                  : `${h.field ?? ""} ${h.newValue ?? ""}`.trim();
              return `${h.createdAt} ${h.businessName ?? h.businessId} ${h.kind} ${what}`;
            })
            .join("\n");
    return { summary, data: { history: items } };
  }

  // ---- Documents ----

  async function addDocument(
    call: CallContext,
    raw: unknown,
  ): Promise<OpResult<{ document: DocumentApi; created: boolean; replaced: string | null }>> {
    const p = readParams(raw);
    assertNoSensitiveIds(p);
    const businessId = parseUuid(p.businessId, "businessId");
    const docType = parseEnum(p.docType, DOC_TYPES, "docType");
    const title = parseText(p.title, "title", 300);
    const issuingBody = parseOptionalText(p.issuingBody, "issuingBody", 200) ?? null;
    const documentDate = parseOptionalDate(p.documentDate, "documentDate") ?? null;
    const renewalDate = parseOptionalDate(p.renewalDate, "renewalDate") ?? null;
    const issueId = parseUuid(p.issueId, "issueId");
    const attachmentRef = parseOptionalText(p.attachmentRef, "attachmentRef", 500) ?? null;
    const replacesDocumentId = parseOptionalUuid(p.replacesDocumentId, "replacesDocumentId") ?? null;
    const notes = parseOptionalText(p.notes, "notes", 5000) ?? null;
    const idempotencyKey = parseOptionalText(p.idempotencyKey, "idempotencyKey", 200) ?? null;

    const business = await loadBusiness(call.companyId, businessId);
    await requireIssue(call.companyId, issueId);

    let old: DocumentRow | null = null;
    if (replacesDocumentId) {
      old = (await q<DocumentRow>(buildGetDocument(ns, call.companyId, replacesDocumentId)))[0] ?? null;
      if (!old || old.business_id !== businessId) {
        throw new RecordsError("EDOCUMENT_NOT_FOUND", "replacesDocumentId is not a document of this business.");
      }
    }

    const dupStmt = buildFindDuplicateDocument(ns, call.companyId, {
      businessId,
      issueId,
      docType,
      attachmentRef,
      title,
      documentDate,
      idempotencyKey,
    });

    let doc = (await q<DocumentRow>(dupStmt))[0] ?? null;
    let created = false;
    if (!doc) {
      if (old?.replaced_by) {
        throw new RecordsError("EDOCUMENT_ALREADY_REPLACED", "that document has already been replaced by a newer one.");
      }
      const id = newId();
      const result = await x(
        buildInsertDocument(ns, call.companyId, {
          id,
          businessId,
          docType,
          title,
          issuingBody,
          documentDate,
          renewalDate,
          issueId,
          attachmentRef,
          idempotencyKey,
          notes,
        }),
      );
      if (result.rowCount > 0) {
        created = true;
        doc = (await q<DocumentRow>(buildGetDocument(ns, call.companyId, id)))[0]!;
        await writeHistory(call, {
          businessId,
          kind: "document_added",
          subjectId: id,
          field: docType,
          newValue: title,
          asOf: documentDate,
        });
      } else {
        doc = (await q<DocumentRow>(dupStmt))[0] ?? null;
        if (!doc) throw new RecordsError("ECONFLICT", "the document could not be added or found; try again.");
      }
    }

    let replaced: string | null = null;
    if (old && old.id !== doc.id) {
      if (old.replaced_by && old.replaced_by !== doc.id) {
        throw new RecordsError("EDOCUMENT_ALREADY_REPLACED", "that document has already been replaced by a different one.");
      }
      if (!old.replaced_by) {
        const r = await x(buildMarkReplaced(ns, call.companyId, businessId, old.id, doc.id));
        if (r.rowCount > 0) {
          await writeHistory(call, {
            businessId,
            kind: "document_replaced",
            subjectId: old.id,
            field: old.doc_type,
            oldValue: old.title,
            newValue: doc.title,
          });
        }
      }
      replaced = old.id;
    }

    const api = documentToApi(doc);
    return {
      summary: created
        ? `Added ${docType} "${title}" to ${business.name} [id ${api.id}]${replaced ? `, replacing ${replaced}` : ""}.`
        : `No change: that document is already on file for ${business.name} [id ${api.id}].`,
      data: { document: api, created, replaced },
    };
  }

  async function listDocuments(call: CallContext, raw: unknown): Promise<OpResult<{ documents: DocumentApi[] }>> {
    const p = readParams(raw);
    const businessId = parseOptionalUuid(p.businessId, "businessId") ?? undefined;
    if (businessId) await loadBusiness(call.companyId, businessId);
    const docType = parseOptionalEnum(p.docType, DOC_TYPES, "docType") ?? undefined;
    const days = parsePositiveInt(p.renewalWithinDays, "renewalWithinDays", 3650);
    const includeReplaced = p.includeReplaced === true;
    const rows = await q<DocumentRow>(
      buildListDocuments(ns, call.companyId, {
        businessId,
        docType,
        includeReplaced,
        renewalOnOrBefore: days === undefined ? undefined : addDays(today(), days),
      }),
    );
    const documents = rows.map(documentToApi);
    const summary =
      documents.length === 0
        ? "No documents match."
        : documents
            .map(
              (d) =>
                `${d.businessName ?? d.businessId}: ${d.docType} "${d.title}"${d.documentDate ? ` dated ${d.documentDate}` : ""}${d.renewalDate ? `, renews ${d.renewalDate}` : ""}${d.replacedBy ? " (replaced)" : ""} [id ${d.id}]`,
            )
            .join("\n");
    return { summary, data: { documents } };
  }

  // ---- Filings ----

  async function upsertFiling(
    call: CallContext,
    raw: unknown,
  ): Promise<OpResult<{ filing: FilingApi; created: boolean; changed: string[] }>> {
    const p = readParams(raw);
    assertNoSensitiveIds(p);
    const filingId = parseOptionalUuid(p.filingId, "filingId") ?? undefined;
    const businessIdIn = parseOptionalUuid(p.businessId, "businessId") ?? undefined;
    const filingName = p.filing === undefined ? undefined : parseText(p.filing, "filing", 300);
    const authority = p.authority === undefined ? undefined : parseText(p.authority, "authority", 200);
    const periodLabel = p.periodLabel === undefined ? undefined : parseText(p.periodLabel, "periodLabel", 100);

    const patch: FilingPatch = {};
    const setIf = (key: keyof FilingPatch, value: string | null | undefined) => {
      if (value !== undefined) patch[key] = value;
    };
    setIf("periodStart", parseOptionalDate(p.periodStart, "periodStart"));
    setIf("periodEnd", parseOptionalDate(p.periodEnd, "periodEnd"));
    if (p.dueDate !== undefined) setIf("dueDate", parseDate(p.dueDate, "dueDate"));
    setIf("preparer", parseOptionalEnum(p.preparer, PREPARERS, "preparer"));
    setIf("issueId", parseOptionalUuid(p.issueId, "issueId"));
    setIf("notes", parseOptionalText(p.notes, "notes", 5000));

    let existing: FilingRow | null = null;
    let businessId: string;
    if (filingId) {
      existing = (await q<FilingRow>(buildGetFiling(ns, call.companyId, filingId)))[0] ?? null;
      if (!existing) throw NOT_FOUND_FILING();
      if (businessIdIn && businessIdIn !== existing.business_id) {
        throw invalid("businessId does not match the filing. A filing cannot move to another business.");
      }
      businessId = existing.business_id;
      const keyMismatch =
        (filingName !== undefined && filingName.toLowerCase() !== existing.filing.toLowerCase()) ||
        (authority !== undefined && authority.toLowerCase() !== existing.authority.toLowerCase()) ||
        (periodLabel !== undefined && periodLabel !== existing.period_label);
      if (keyMismatch) {
        throw invalid(
          "filing, authority and periodLabel identify a filing and cannot be changed. Create a new filing row instead.",
        );
      }
    } else {
      if (!businessIdIn) throw invalid("businessId is required (or filingId to update an existing filing).");
      if (!filingName || !authority || !periodLabel) {
        throw invalid("filing, authority and periodLabel are required to find or create a filing.");
      }
      businessId = businessIdIn;
      await loadBusiness(call.companyId, businessId);
      existing =
        (
          await q<FilingRow>(
            buildFindFilingByKey(ns, call.companyId, { businessId, filing: filingName, authority, periodLabel }),
          )
        )[0] ?? null;
    }

    const start = patch.periodStart !== undefined ? patch.periodStart : existing?.period_start ?? null;
    const end = patch.periodEnd !== undefined ? patch.periodEnd : existing?.period_end ?? null;
    if (start && end && start > end) throw invalid("periodStart must be on or before periodEnd.");

    if (!existing) {
      if (!patch.dueDate) throw invalid("dueDate is required to create a filing.");
      if (patch.issueId) await requireIssue(call.companyId, patch.issueId);
      const id = newId();
      const result = await x(
        buildInsertFiling(ns, call.companyId, {
          id,
          businessId,
          filing: filingName!,
          authority: authority!,
          periodLabel: periodLabel!,
          periodStart: patch.periodStart ?? null,
          periodEnd: patch.periodEnd ?? null,
          dueDate: patch.dueDate,
          preparer: (patch.preparer as FilingRow["preparer"]) ?? null,
          issueId: patch.issueId ?? null,
          notes: patch.notes ?? null,
        }),
      );
      if (result.rowCount > 0) {
        const filing = filingToApi((await q<FilingRow>(buildGetFiling(ns, call.companyId, id)))[0]!);
        return {
          summary: `Added filing ${filing.filing} (${filing.authority}, ${filing.periodLabel}) due ${filing.dueDate} for ${filing.businessName} [id ${filing.id}].`,
          data: { filing, created: true, changed: [] },
        };
      }
      existing =
        (
          await q<FilingRow>(
            buildFindFilingByKey(ns, call.companyId, { businessId, filing: filingName!, authority: authority!, periodLabel: periodLabel! }),
          )
        )[0] ?? null;
      if (!existing) throw new RecordsError("ECONFLICT", "the filing could not be added or found; try again.");
    }

    const current: Record<keyof FilingPatch, string | null> = {
      periodStart: existing.period_start,
      periodEnd: existing.period_end,
      dueDate: existing.due_date,
      preparer: existing.preparer,
      issueId: existing.issue_id,
      notes: existing.notes,
    };
    const changedPatch: FilingPatch = {};
    for (const key of Object.keys(patch) as (keyof FilingPatch)[]) {
      if ((patch[key] ?? null) !== (current[key] ?? null)) changedPatch[key] = patch[key];
    }
    const changed = Object.keys(changedPatch) as (keyof FilingPatch)[];
    if (changed.length === 0) {
      const filing = filingToApi(existing);
      return {
        summary: `No change: filing ${filing.filing} (${filing.periodLabel}) already matches [id ${filing.id}].`,
        data: { filing, created: false, changed: [] },
      };
    }
    if (changedPatch.issueId) await requireIssue(call.companyId, changedPatch.issueId);
    await x(buildUpdateFiling(ns, call.companyId, existing.id, changedPatch)!);
    for (const key of changed) {
      await writeHistory(call, {
        businessId: existing.business_id,
        kind: "business_updated",
        subjectId: existing.id,
        field: `filing.${key}`,
        oldValue: current[key],
        newValue: changedPatch[key] ?? null,
      });
    }
    const filing = filingToApi((await q<FilingRow>(buildGetFiling(ns, call.companyId, existing.id)))[0]!);
    return {
      summary: `Updated filing ${filing.filing} (${filing.periodLabel}): ${changed.join(", ")} [id ${filing.id}].`,
      data: { filing, created: false, changed },
    };
  }

  async function setFilingStatus(
    call: CallContext,
    raw: unknown,
  ): Promise<
    OpResult<{ filing: FilingApi; changed: boolean; nextPeriod: { filing: FilingApi; created: boolean } | null }>
  > {
    const p = readParams(raw);
    assertNoSensitiveIds(p);
    const filingId = parseUuid(p.filingId, "filingId");
    const status = parseEnum(p.status, FILING_STATUSES, "status");
    const proofDocumentId = parseOptionalUuid(p.proofDocumentId, "proofDocumentId") ?? null;
    const extendedDueDate = parseOptionalDate(p.extendedDueDate, "extendedDueDate") ?? null;
    const reason = parseOptionalText(p.reason, "reason", 2000) ?? null;
    const source = p.source === undefined || p.source === null ? null : parseNotRequiredSource(p.source, "source");
    const asOf = parseOptionalDate(p.asOf, "asOf") ?? null;

    let next: { periodLabel: string; periodStart: string | null; periodEnd: string | null; dueDate: string } | null =
      null;
    if (p.nextPeriod !== undefined && p.nextPeriod !== null) {
      const n = readParams(p.nextPeriod);
      next = {
        periodLabel: parseText(n.periodLabel, "nextPeriod.periodLabel", 100),
        periodStart: parseOptionalDate(n.periodStart, "nextPeriod.periodStart") ?? null,
        periodEnd: parseOptionalDate(n.periodEnd, "nextPeriod.periodEnd") ?? null,
        dueDate: parseDate(n.dueDate, "nextPeriod.dueDate"),
      };
      if (next.periodStart && next.periodEnd && next.periodStart > next.periodEnd) {
        throw invalid("nextPeriod.periodStart must be on or before nextPeriod.periodEnd.");
      }
    }

    const existing = (await q<FilingRow>(buildGetFiling(ns, call.companyId, filingId)))[0];
    if (!existing) throw NOT_FOUND_FILING();
    if (next && next.periodLabel === existing.period_label) {
      throw invalid("nextPeriod.periodLabel must differ from this filing's period.");
    }

    checkFilingStatusChange({
      status,
      businessId: existing.business_id,
      dueDate: existing.due_date,
      proofDocumentId,
      proofDoc: await lookupDoc(call.companyId, proofDocumentId),
      extendedDueDate,
      reason,
      source,
      sourceDoc: await lookupDoc(call.companyId, source?.documentId),
      hasNextPeriod: next !== null,
    });

    const unchanged =
      existing.status === status &&
      (!proofDocumentId || proofDocumentId === existing.proof_document_id) &&
      (!extendedDueDate || extendedDueDate === existing.extended_due_date) &&
      (status !== "not_required" ||
        (reason === existing.not_required_reason && stableSource(source) === stableSource(existing.not_required_source)));

    if (!unchanged) {
      const result = await x(
        buildSetFilingStatus(
          ns,
          call.companyId,
          filingId,
          { status, proofDocumentId, extendedDueDate, reason, source },
          existing.status as FilingStatus,
        ),
      );
      if (result.rowCount === 0) {
        throw new RecordsError("ECONFLICT", "the filing changed while this call was running. Read it again and retry.");
      }
      const historySource: Record<string, unknown> = {};
      if (proofDocumentId) historySource.proofDocumentId = proofDocumentId;
      if (extendedDueDate) historySource.extendedDueDate = extendedDueDate;
      if (reason) historySource.reason = reason;
      if (source) historySource.source = source;
      await writeHistory(call, {
        businessId: existing.business_id,
        kind: "filing_status_change",
        subjectId: filingId,
        field: "status",
        oldValue: existing.status,
        newValue: status,
        asOf,
        source: Object.keys(historySource).length > 0 ? historySource : null,
      });
    }

    // Rolling forward is idempotent (the unique key absorbs a repeat), so it
    // runs even when the status itself was already set: a retry after a
    // half-finished call still ends with exactly one next-period row.
    let nextPeriod: { filing: FilingApi; created: boolean } | null = null;
    if (next) {
      const nextId = newId();
      const r = await x(
        buildInsertFiling(ns, call.companyId, {
          id: nextId,
          businessId: existing.business_id,
          filing: existing.filing,
          authority: existing.authority,
          periodLabel: next.periodLabel,
          periodStart: next.periodStart,
          periodEnd: next.periodEnd,
          dueDate: next.dueDate,
          preparer: existing.preparer,
          issueId: null,
          notes: null,
        }),
      );
      const row = (
        await q<FilingRow>(
          buildFindFilingByKey(ns, call.companyId, {
            businessId: existing.business_id,
            filing: existing.filing,
            authority: existing.authority,
            periodLabel: next.periodLabel,
          }),
        )
      )[0];
      if (row) nextPeriod = { filing: filingToApi(row), created: r.rowCount > 0 };
    }

    const filing = filingToApi((await q<FilingRow>(buildGetFiling(ns, call.companyId, filingId)))[0]!);
    const parts = [
      unchanged
        ? `No change: ${filing.filing} (${filing.periodLabel}) is already ${status}.`
        : `${filing.filing} (${filing.periodLabel}) for ${filing.businessName}: ${existing.status} changed to ${status}.`,
    ];
    if (nextPeriod) {
      parts.push(
        nextPeriod.created
          ? `Created next period ${nextPeriod.filing.periodLabel} due ${nextPeriod.filing.dueDate} [id ${nextPeriod.filing.id}].`
          : `Next period ${nextPeriod.filing.periodLabel} was already on the calendar [id ${nextPeriod.filing.id}].`,
      );
    }
    return { summary: parts.join(" "), data: { filing, changed: !unchanged, nextPeriod } };
  }

  async function listFilings(call: CallContext, raw: unknown): Promise<OpResult<{ filings: FilingApi[] }>> {
    const p = readParams(raw);
    const businessId = parseOptionalUuid(p.businessId, "businessId") ?? undefined;
    if (businessId) await loadBusiness(call.companyId, businessId);
    let statuses: FilingStatus[] | undefined;
    if (p.status !== undefined && p.status !== null) {
      const list = Array.isArray(p.status) ? p.status : [p.status];
      statuses = list.map((s) => parseEnum(s, FILING_STATUSES, "status"));
    }
    const days = parsePositiveInt(p.dueWithinDays, "dueWithinDays", 3650);
    const overdue = p.overdueWithoutProof === true;
    const t = today();
    const rows = await q<FilingRow>(
      buildListFilings(ns, call.companyId, {
        businessId,
        statuses,
        today: t,
        dueOnOrBefore: days === undefined ? undefined : addDays(t, days),
        overdueBefore: overdue ? t : undefined,
      }),
    );
    const filings = rows.map(filingToApi);
    const summary =
      filings.length === 0
        ? "No filings match."
        : filings
            .map((f) => {
              const late = f.effectiveDueDate < t && !["filed", "accepted", "not_required"].includes(f.status);
              return `${f.businessName}: ${f.filing} (${f.authority}, ${f.periodLabel}) due ${f.effectiveDueDate}${f.extendedDueDate ? " (extended)" : ""}, ${f.status}${late ? ", OVERDUE with no proof of filing" : ""}${f.proofTitle ? `, proof: ${f.proofTitle}` : ""} [id ${f.id}]`;
            })
            .join("\n");
    return { summary, data: { filings } };
  }

  // ---- Page views ----

  async function businessDetail(call: CallContext, businessId: string) {
    const business = businessToApi(await loadBusiness(call.companyId, parseUuid(businessId, "businessId")));
    const [historyRows, documentRows, filingRows] = [
      await q<HistoryRow>(buildListHistory(ns, call.companyId, { businessId: business.id, limit: 200 })),
      await q<DocumentRow>(buildListDocuments(ns, call.companyId, { businessId: business.id })),
      await q<FilingRow>(buildListFilings(ns, call.companyId, { businessId: business.id })),
    ];
    return {
      business,
      history: historyRows.map(historyToApi),
      documents: documentRows.map(documentToApi),
      filings: filingRows.map(filingToApi),
      links: await linksWithIssues(call.companyId, business.id),
      today: today(),
    };
  }

  async function overview(call: CallContext) {
    const t = today();
    const overdue = await q<FilingRow>(buildListFilings(ns, call.companyId, { overdueBefore: t }));
    const dueSoon = await q<FilingRow>(
      buildListFilings(ns, call.companyId, { today: t, dueOnOrBefore: addDays(t, 30) }),
    );
    const renewals = await q<DocumentRow>(
      buildListDocuments(ns, call.companyId, { renewalOnOrBefore: addDays(t, 60) }),
    );
    return {
      today: t,
      overdueFilings: overdue.map(filingToApi),
      filingsDueSoon: dueSoon.map(filingToApi),
      documentsRenewingSoon: renewals.map(documentToApi),
    };
  }

  return {
    listBusinesses,
    getBusiness,
    upsertBusiness,
    setStatus,
    linkIssue,
    history,
    addDocument,
    listDocuments,
    upsertFiling,
    setFilingStatus,
    listFilings,
    businessDetail,
    overview,
  };
}

export type RecordsService = ReturnType<typeof createRecordsService>;
