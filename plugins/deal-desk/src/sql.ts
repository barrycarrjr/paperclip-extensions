/**
 * SQL builders. Pure: each returns {text, params} for ctx.db.query or
 * ctx.db.execute.
 *
 * READ THIS BEFORE CHANGING A BUILDER.
 *
 * Every builder takes companyId as its first data argument, binds it as $1 and
 * filters on company_id. That is the company isolation model: an id on its own
 * never reaches a row in another company, so a deal id from company A looks
 * exactly like "not found" to company B. sql.test.ts fails if a builder stops
 * doing this.
 *
 * Scenarios are insert-only. There is deliberately no builder that updates or
 * deletes a scenario, and sql.test.ts fails if one appears.
 *
 * Host constraints these builders respect (see the host's plugin-database.ts):
 * - ctx.db.query takes one SELECT (or WITH) and no mutation keywords.
 * - ctx.db.execute takes exactly one INSERT, UPDATE or DELETE against the
 *   plugin namespace, with no references to any other schema. No RETURNING is
 *   relied on and there are no transactions, so ids are generated in the
 *   worker and rows are read back after writing.
 * - Every parameter must be referenced by a $n placeholder.
 * - Parameters cross a JSON boundary, so objects are sent as JSON text and
 *   converted in SQL, money travels as whole numbers and is read back as
 *   bigint text, and dates are read back as text (YYYY-MM-DD).
 */

import type { AdjustmentKind, AdjustmentStatus, ClaimedBy, DealStage, EarningsBasis, PeriodSourceKind } from "./domain.js";

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

// ---- Deals ----

const DEAL_COLUMNS = `d.id, d.company_id, d.business_id, d.name, d.stage, d.structure, d.acquiring_entity,
  d.asking_price_cents::text AS asking_price_cents, d.currency, d.notes, d.created_at, d.updated_at`;

export function buildGetDeal(ns: string, companyId: string, dealId: string): SqlStatement {
  const { p, c } = start(companyId);
  const id = p.add(dealId);
  return { text: `SELECT ${DEAL_COLUMNS} FROM ${ns}.deals d WHERE d.company_id = ${c} AND d.id = ${id}`, params: p.values };
}

export function buildFindDealByBusiness(ns: string, companyId: string, businessId: string): SqlStatement {
  const { p, c } = start(companyId);
  const b = p.add(businessId);
  return {
    text: `SELECT ${DEAL_COLUMNS} FROM ${ns}.deals d WHERE d.company_id = ${c} AND d.business_id = ${b}`,
    params: p.values,
  };
}

export function buildListDeals(ns: string, companyId: string, filter: { stages?: DealStage[] } = {}): SqlStatement {
  const { p, c } = start(companyId);
  const where = [`d.company_id = ${c}`];
  if (filter.stages && filter.stages.length > 0) {
    where.push(`d.stage IN (${filter.stages.map((s) => p.add(s)).join(", ")})`);
  }
  return {
    text: `SELECT ${DEAL_COLUMNS} FROM ${ns}.deals d WHERE ${where.join(" AND ")} ORDER BY d.updated_at DESC, lower(d.name) LIMIT 500`,
    params: p.values,
  };
}

export interface DealInsert {
  id: string;
  businessId: string;
  name: string;
  stage: string;
  structure: string;
  acquiringEntity: string | null;
  askingPriceCents: number | null;
  currency: string;
  notes: string | null;
}

/** ON CONFLICT DO NOTHING: when two calls race to create the deal for one business, the second reads the winner back. */
export function buildInsertDeal(ns: string, companyId: string, d: DealInsert): SqlStatement {
  const { p, c } = start(companyId);
  const vals = [
    p.add(d.id),
    c,
    p.add(d.businessId),
    p.add(d.name),
    p.add(d.stage),
    p.add(d.structure),
    p.add(d.acquiringEntity),
    `${p.add(d.askingPriceCents)}::bigint`,
    p.add(d.currency),
    p.add(d.notes),
  ];
  return {
    text: `INSERT INTO ${ns}.deals (id, company_id, business_id, name, stage, structure, acquiring_entity, asking_price_cents, currency, notes) VALUES (${vals.join(", ")}) ON CONFLICT DO NOTHING`,
    params: p.values,
  };
}

/** Columns deal_upsert may change, and how each is written. */
export const DEAL_PATCH_COLUMNS = {
  name: { col: "name", kind: "text" },
  stage: { col: "stage", kind: "text" },
  structure: { col: "structure", kind: "text" },
  acquiringEntity: { col: "acquiring_entity", kind: "text" },
  askingPriceCents: { col: "asking_price_cents", kind: "bigint" },
  currency: { col: "currency", kind: "text" },
  notes: { col: "notes", kind: "text" },
} as const;

export type DealPatchKey = keyof typeof DEAL_PATCH_COLUMNS;
export type DealPatch = Partial<Record<DealPatchKey, string | number | null>>;

type PatchSpec = { col: string; kind: "text" | "bigint" | "date" | "uuid" };

function patchSets(p: Params, specs: Record<string, PatchSpec>, patch: Record<string, unknown>): string[] {
  const sets: string[] = [];
  for (const key of Object.keys(patch)) {
    const spec = specs[key];
    if (!spec) continue;
    const ph = p.add(patch[key] ?? null);
    sets.push(spec.kind === "text" ? `${spec.col} = ${ph}` : `${spec.col} = ${ph}::${spec.kind}`);
  }
  return sets;
}

export function buildUpdateDeal(ns: string, companyId: string, dealId: string, patch: DealPatch): SqlStatement | null {
  const { p, c } = start(companyId);
  const sets = patchSets(p, DEAL_PATCH_COLUMNS, patch);
  if (sets.length === 0) return null;
  sets.push("updated_at = now()");
  const id = p.add(dealId);
  return { text: `UPDATE ${ns}.deals SET ${sets.join(", ")} WHERE company_id = ${c} AND id = ${id}`, params: p.values };
}

/** Bump updated_at so the deal list shows recent work first. */
export function buildTouchDeal(ns: string, companyId: string, dealId: string): SqlStatement {
  const { p, c } = start(companyId);
  const id = p.add(dealId);
  return { text: `UPDATE ${ns}.deals SET updated_at = now() WHERE company_id = ${c} AND id = ${id}`, params: p.values };
}

// ---- Earnings periods ----

const PERIOD_COLUMNS = `e.id, e.company_id, e.deal_id, e.period_label, e.period_start::text AS period_start,
  e.period_end::text AS period_end, e.source_kind, e.revenue_cents::text AS revenue_cents,
  e.net_income_cents::text AS net_income_cents, e.owner_comp_cents::text AS owner_comp_cents,
  e.depreciation_cents::text AS depreciation_cents, e.interest_cents::text AS interest_cents,
  e.document_id, e.notes, e.created_at, e.updated_at`;

export function buildListPeriods(
  ns: string,
  companyId: string,
  dealId: string,
  filter: { periodLabel?: string; sourceKind?: string } = {},
): SqlStatement {
  const { p, c } = start(companyId);
  const where = [`e.company_id = ${c}`, `e.deal_id = ${p.add(dealId)}`];
  if (filter.periodLabel) where.push(`e.period_label = ${p.add(filter.periodLabel)}`);
  if (filter.sourceKind) where.push(`e.source_kind = ${p.add(filter.sourceKind)}`);
  return {
    text: `SELECT ${PERIOD_COLUMNS} FROM ${ns}.earnings_periods e WHERE ${where.join(" AND ")} ORDER BY e.period_start DESC, e.period_label DESC, e.source_kind LIMIT 500`,
    params: p.values,
  };
}

export function buildFindPeriod(
  ns: string,
  companyId: string,
  k: { dealId: string; periodLabel: string; sourceKind: string },
): SqlStatement {
  const { p, c } = start(companyId);
  const d = p.add(k.dealId);
  const l = p.add(k.periodLabel);
  const s = p.add(k.sourceKind);
  return {
    text: `SELECT ${PERIOD_COLUMNS} FROM ${ns}.earnings_periods e WHERE e.company_id = ${c} AND e.deal_id = ${d} AND e.period_label = ${l} AND e.source_kind = ${s}`,
    params: p.values,
  };
}

export interface PeriodInsert {
  id: string;
  dealId: string;
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  sourceKind: PeriodSourceKind;
  revenueCents: number;
  netIncomeCents: number;
  ownerCompCents: number;
  depreciationCents: number | null;
  interestCents: number | null;
  documentId: string | null;
  notes: string | null;
}

/** ON CONFLICT DO NOTHING against the (deal, label, source) unique key. */
export function buildInsertPeriod(ns: string, companyId: string, e: PeriodInsert): SqlStatement {
  const { p, c } = start(companyId);
  const vals = [
    p.add(e.id),
    c,
    p.add(e.dealId),
    p.add(e.periodLabel),
    `${p.add(e.periodStart)}::date`,
    `${p.add(e.periodEnd)}::date`,
    p.add(e.sourceKind),
    `${p.add(e.revenueCents)}::bigint`,
    `${p.add(e.netIncomeCents)}::bigint`,
    `${p.add(e.ownerCompCents)}::bigint`,
    `${p.add(e.depreciationCents)}::bigint`,
    `${p.add(e.interestCents)}::bigint`,
    `${p.add(e.documentId)}::uuid`,
    p.add(e.notes),
  ];
  return {
    text: `INSERT INTO ${ns}.earnings_periods (id, company_id, deal_id, period_label, period_start, period_end, source_kind, revenue_cents, net_income_cents, owner_comp_cents, depreciation_cents, interest_cents, document_id, notes) VALUES (${vals.join(", ")}) ON CONFLICT DO NOTHING`,
    params: p.values,
  };
}

export const PERIOD_PATCH_COLUMNS = {
  periodStart: { col: "period_start", kind: "date" },
  periodEnd: { col: "period_end", kind: "date" },
  revenueCents: { col: "revenue_cents", kind: "bigint" },
  netIncomeCents: { col: "net_income_cents", kind: "bigint" },
  ownerCompCents: { col: "owner_comp_cents", kind: "bigint" },
  depreciationCents: { col: "depreciation_cents", kind: "bigint" },
  interestCents: { col: "interest_cents", kind: "bigint" },
  documentId: { col: "document_id", kind: "uuid" },
  notes: { col: "notes", kind: "text" },
} as const;

export type PeriodPatchKey = keyof typeof PERIOD_PATCH_COLUMNS;
export type PeriodPatch = Partial<Record<PeriodPatchKey, string | number | null>>;

export function buildUpdatePeriod(ns: string, companyId: string, periodId: string, patch: PeriodPatch): SqlStatement | null {
  const { p, c } = start(companyId);
  const sets = patchSets(p, PERIOD_PATCH_COLUMNS, patch);
  if (sets.length === 0) return null;
  sets.push("updated_at = now()");
  const id = p.add(periodId);
  return {
    text: `UPDATE ${ns}.earnings_periods SET ${sets.join(", ")} WHERE company_id = ${c} AND id = ${id}`,
    params: p.values,
  };
}

// ---- Earnings adjustments (the add-back schedule) ----

const ADJUSTMENT_COLUMNS = `a.id, a.company_id, a.deal_id, a.period_label, a.description, a.amount_cents::text AS amount_cents,
  a.kind, a.claimed_by, a.status, a.evidence_document_id, a.note, a.status_note, a.created_at, a.updated_at`;

export function buildGetAdjustment(ns: string, companyId: string, adjustmentId: string): SqlStatement {
  const { p, c } = start(companyId);
  const id = p.add(adjustmentId);
  return {
    text: `SELECT ${ADJUSTMENT_COLUMNS} FROM ${ns}.earnings_adjustments a WHERE a.company_id = ${c} AND a.id = ${id}`,
    params: p.values,
  };
}

/** The pre-check behind the unique (deal, period, lower(description)) key. */
export function buildFindAdjustmentByDescription(
  ns: string,
  companyId: string,
  k: { dealId: string; periodLabel: string; description: string },
): SqlStatement {
  const { p, c } = start(companyId);
  const d = p.add(k.dealId);
  const l = p.add(k.periodLabel);
  const desc = p.add(k.description);
  return {
    text: `SELECT ${ADJUSTMENT_COLUMNS} FROM ${ns}.earnings_adjustments a WHERE a.company_id = ${c} AND a.deal_id = ${d} AND a.period_label = ${l} AND lower(a.description) = lower(${desc})`,
    params: p.values,
  };
}

export function buildListAdjustments(
  ns: string,
  companyId: string,
  dealId: string,
  filter: { periodLabel?: string } = {},
): SqlStatement {
  const { p, c } = start(companyId);
  const where = [`a.company_id = ${c}`, `a.deal_id = ${p.add(dealId)}`];
  if (filter.periodLabel) where.push(`a.period_label = ${p.add(filter.periodLabel)}`);
  return {
    text: `SELECT ${ADJUSTMENT_COLUMNS} FROM ${ns}.earnings_adjustments a WHERE ${where.join(" AND ")} ORDER BY a.period_label DESC, a.created_at, lower(a.description) LIMIT 1000`,
    params: p.values,
  };
}

export interface AdjustmentInsert {
  id: string;
  dealId: string;
  periodLabel: string;
  description: string;
  amountCents: number;
  kind: AdjustmentKind;
  claimedBy: ClaimedBy;
  evidenceDocumentId: string | null;
  note: string | null;
}

/** New add-backs always start unverified. ON CONFLICT DO NOTHING: a duplicate description inserts nothing (rowCount 0). */
export function buildInsertAdjustment(ns: string, companyId: string, a: AdjustmentInsert): SqlStatement {
  const { p, c } = start(companyId);
  const vals = [
    p.add(a.id),
    c,
    p.add(a.dealId),
    p.add(a.periodLabel),
    p.add(a.description),
    `${p.add(a.amountCents)}::bigint`,
    p.add(a.kind),
    p.add(a.claimedBy),
    "'unverified'",
    `${p.add(a.evidenceDocumentId)}::uuid`,
    p.add(a.note),
  ];
  return {
    text: `INSERT INTO ${ns}.earnings_adjustments (id, company_id, deal_id, period_label, description, amount_cents, kind, claimed_by, status, evidence_document_id, note) VALUES (${vals.join(", ")}) ON CONFLICT DO NOTHING`,
    params: p.values,
  };
}

export const ADJUSTMENT_PATCH_COLUMNS = {
  description: { col: "description", kind: "text" },
  amountCents: { col: "amount_cents", kind: "bigint" },
  kind: { col: "kind", kind: "text" },
  claimedBy: { col: "claimed_by", kind: "text" },
  evidenceDocumentId: { col: "evidence_document_id", kind: "uuid" },
  note: { col: "note", kind: "text" },
} as const;

export type AdjustmentPatchKey = keyof typeof ADJUSTMENT_PATCH_COLUMNS;
export type AdjustmentPatch = Partial<Record<AdjustmentPatchKey, string | number | null>>;

/**
 * Update an add-back's content. When resetStatus is true (its amount, kind,
 * description or evidence changed) the status goes back to unverified, so an
 * acceptance never carries over to figures nobody checked. The expected
 * current status is in the WHERE clause, so a concurrent status change is
 * detected (rowCount 0).
 */
export function buildUpdateAdjustment(
  ns: string,
  companyId: string,
  adjustmentId: string,
  patch: AdjustmentPatch,
  opts: { resetStatus: boolean; expectedStatus: AdjustmentStatus },
): SqlStatement | null {
  const { p, c } = start(companyId);
  const sets = patchSets(p, ADJUSTMENT_PATCH_COLUMNS, patch);
  if (sets.length === 0) return null;
  if (opts.resetStatus) sets.push("status = 'unverified'", "status_note = NULL");
  sets.push("updated_at = now()");
  const id = p.add(adjustmentId);
  const e = p.add(opts.expectedStatus);
  return {
    text: `UPDATE ${ns}.earnings_adjustments SET ${sets.join(", ")} WHERE company_id = ${c} AND id = ${id} AND status = ${e}`,
    params: p.values,
  };
}

export function buildSetAdjustmentStatus(
  ns: string,
  companyId: string,
  adjustmentId: string,
  next: { status: AdjustmentStatus; evidenceDocumentId: string | null; statusNote: string | null },
  expectedStatus: AdjustmentStatus,
): SqlStatement {
  const { p, c } = start(companyId);
  const s = p.add(next.status);
  const ev = p.add(next.evidenceDocumentId);
  const n = p.add(next.statusNote);
  const id = p.add(adjustmentId);
  const e = p.add(expectedStatus);
  return {
    text: `UPDATE ${ns}.earnings_adjustments SET status = ${s}, evidence_document_id = ${ev}::uuid, status_note = ${n}, updated_at = now() WHERE company_id = ${c} AND id = ${id} AND status = ${e}`,
    params: p.values,
  };
}

// ---- Scenarios (insert-only) ----

const SCENARIO_LIST_COLUMNS = `s.id, s.company_id, s.deal_id, s.name, s.earnings_basis, s.basis_note, s.comparables_note,
  s.outputs->'summary' AS summary, s.created_at`;

const SCENARIO_FULL_COLUMNS = `s.id, s.company_id, s.deal_id, s.name, s.earnings_basis, s.basis_note, s.comparables_note,
  s.inputs, s.outputs, s.created_at, d.name AS deal_name, d.currency AS currency`;

export interface ScenarioInsert {
  id: string;
  dealId: string;
  name: string;
  earningsBasis: EarningsBasis;
  basisNote: string | null;
  comparablesNote: string | null;
  inputs: unknown;
  outputs: unknown;
  idempotencyKey: string | null;
}

export function buildInsertScenario(ns: string, companyId: string, s: ScenarioInsert): SqlStatement {
  const { p, c } = start(companyId);
  const vals = [
    p.add(s.id),
    c,
    p.add(s.dealId),
    p.add(s.name),
    p.add(s.earningsBasis),
    p.add(s.basisNote),
    p.add(s.comparablesNote),
    `${p.add(jsonText(s.inputs))}::jsonb`,
    `${p.add(jsonText(s.outputs))}::jsonb`,
    p.add(s.idempotencyKey),
  ];
  return {
    text: `INSERT INTO ${ns}.scenarios (id, company_id, deal_id, name, earnings_basis, basis_note, comparables_note, inputs, outputs, idempotency_key) VALUES (${vals.join(", ")}) ON CONFLICT DO NOTHING`,
    params: p.values,
  };
}

export function buildListScenarios(ns: string, companyId: string, dealId: string): SqlStatement {
  const { p, c } = start(companyId);
  const d = p.add(dealId);
  return {
    text: `SELECT ${SCENARIO_LIST_COLUMNS} FROM ${ns}.scenarios s WHERE s.company_id = ${c} AND s.deal_id = ${d} ORDER BY s.created_at DESC LIMIT 200`,
    params: p.values,
  };
}

/** Whether the deal already has a scenario on this basis (rule 2 needs "a conservative one exists"). */
export function buildCountScenariosByBasis(
  ns: string,
  companyId: string,
  dealId: string,
  basis: EarningsBasis,
): SqlStatement {
  const { p, c } = start(companyId);
  const d = p.add(dealId);
  const b = p.add(basis);
  return {
    text: `SELECT count(*)::int AS n FROM ${ns}.scenarios s WHERE s.company_id = ${c} AND s.deal_id = ${d} AND s.earnings_basis = ${b}`,
    params: p.values,
  };
}

export function buildGetScenarios(ns: string, companyId: string, scenarioIds: string[]): SqlStatement {
  const { p, c } = start(companyId);
  const ids = p.add(JSON.stringify(scenarioIds));
  return {
    text: `SELECT ${SCENARIO_FULL_COLUMNS} FROM ${ns}.scenarios s JOIN ${ns}.deals d ON d.id = s.deal_id AND d.company_id = s.company_id WHERE s.company_id = ${c} AND s.id = ANY(ARRAY(SELECT jsonb_array_elements_text(${ids}::jsonb))::uuid[])`,
    params: p.values,
  };
}

export function buildFindScenarioByIdempotencyKey(
  ns: string,
  companyId: string,
  dealId: string,
  key: string,
): SqlStatement {
  const { p, c } = start(companyId);
  const d = p.add(dealId);
  const k = p.add(key);
  return {
    text: `SELECT ${SCENARIO_FULL_COLUMNS} FROM ${ns}.scenarios s JOIN ${ns}.deals d ON d.id = s.deal_id AND d.company_id = s.company_id WHERE s.company_id = ${c} AND s.deal_id = ${d} AND s.idempotency_key = ${k}`,
    params: p.values,
  };
}

// ---- History ----

export interface HistoryInsert {
  id: string;
  dealId: string;
  kind: string;
  subjectId: string | null;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  actor: unknown;
}

export function buildInsertHistory(ns: string, companyId: string, h: HistoryInsert): SqlStatement {
  const { p, c } = start(companyId);
  const vals = [
    p.add(h.id),
    c,
    p.add(h.dealId),
    p.add(h.kind),
    `${p.add(h.subjectId)}::uuid`,
    p.add(h.field),
    p.add(h.oldValue),
    p.add(h.newValue),
    `${p.add(jsonText(h.actor))}::jsonb`,
  ];
  return {
    text: `INSERT INTO ${ns}.deal_history (id, company_id, deal_id, kind, subject_id, field, old_value, new_value, actor) VALUES (${vals.join(", ")})`,
    params: p.values,
  };
}

export function buildListHistory(ns: string, companyId: string, dealId: string, limit = 100): SqlStatement {
  const { p, c } = start(companyId);
  const d = p.add(dealId);
  const l = p.add(Math.max(1, Math.min(limit, 500)));
  return {
    text: `SELECT h.id, h.company_id, h.deal_id, h.kind, h.subject_id, h.field, h.old_value, h.new_value, h.actor, h.created_at FROM ${ns}.deal_history h WHERE h.company_id = ${c} AND h.deal_id = ${d} ORDER BY h.created_at DESC, h.id DESC LIMIT ${l}::int`,
    params: p.values,
  };
}
