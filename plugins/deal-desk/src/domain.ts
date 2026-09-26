/**
 * Shared vocabulary for the deal-desk plugin: the allowed values of every
 * enum-like column, the row shapes the database returns, and the API shapes
 * tools and routes return.
 *
 * Pure, no I/O.
 */

export const PLUGIN_ID = "deal-desk";

// ---- Enums ----

export const DEAL_STAGES = ["screen", "diligence", "offer", "closing", "closed", "passed"] as const;
export type DealStage = (typeof DEAL_STAGES)[number];

export const DEAL_STRUCTURES = ["asset", "stock", "undecided"] as const;
export type DealStructure = (typeof DEAL_STRUCTURES)[number];

export const PERIOD_SOURCE_KINDS = ["tax_return", "pnl", "bank", "seller_stated", "other"] as const;
export type PeriodSourceKind = (typeof PERIOD_SOURCE_KINDS)[number];

export const ADJUSTMENT_KINDS = [
  "owner_comp",
  "owner_perk",
  "one_time",
  "non_cash",
  "rent_to_owner",
  "replacement_cost",
  "other",
] as const;
export type AdjustmentKind = (typeof ADJUSTMENT_KINDS)[number];

export const CLAIMED_BY = ["seller", "agent", "barry", "cpa", "other"] as const;
export type ClaimedBy = (typeof CLAIMED_BY)[number];

export const ADJUSTMENT_STATUSES = ["unverified", "accepted", "rejected"] as const;
export type AdjustmentStatus = (typeof ADJUSTMENT_STATUSES)[number];

export const EARNINGS_BASES = ["reported", "conservative", "seller_claimed", "custom"] as const;
export type EarningsBasis = (typeof EARNINGS_BASES)[number];

export const HISTORY_KINDS = [
  "deal_created",
  "deal_updated",
  "stage_change",
  "period_added",
  "period_updated",
  "adjustment_added",
  "adjustment_updated",
  "adjustment_status_change",
  "scenario_saved",
] as const;
export type HistoryKind = (typeof HISTORY_KINDS)[number];

export interface Actor {
  agentId?: string | null;
  runId?: string | null;
  userId?: string | null;
}

// ---- Value helpers ----

/** bigint columns arrive as strings from Postgres. Converts to a number of cents. */
export function toCents(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  throw new Error("a money column did not hold a whole number");
}

export function toCentsOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : toCents(value);
}

export function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function toDateOnly(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

// ---- Rows (as the database returns them) and API shapes ----

export interface DealRow {
  id: string;
  company_id: string;
  business_id: string;
  name: string;
  stage: DealStage;
  structure: DealStructure;
  acquiring_entity: string | null;
  asking_price_cents: string | number | null;
  currency: string;
  notes: string | null;
  created_at: unknown;
  updated_at: unknown;
}

export interface DealApi {
  id: string;
  businessId: string;
  name: string;
  stage: DealStage;
  structure: DealStructure;
  acquiringEntity: string | null;
  askingPriceCents: number | null;
  currency: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export function dealToApi(row: DealRow): DealApi {
  return {
    id: row.id,
    businessId: row.business_id,
    name: row.name,
    stage: row.stage,
    structure: row.structure,
    acquiringEntity: row.acquiring_entity,
    askingPriceCents: toCentsOrNull(row.asking_price_cents),
    currency: String(row.currency).trim(),
    notes: row.notes,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export interface PeriodRow {
  id: string;
  company_id: string;
  deal_id: string;
  period_label: string;
  period_start: unknown;
  period_end: unknown;
  source_kind: PeriodSourceKind;
  revenue_cents: string | number;
  net_income_cents: string | number;
  owner_comp_cents: string | number;
  depreciation_cents: string | number | null;
  interest_cents: string | number | null;
  document_id: string | null;
  notes: string | null;
  created_at: unknown;
  updated_at: unknown;
}

export interface PeriodApi {
  id: string;
  dealId: string;
  periodLabel: string;
  periodStart: string | null;
  periodEnd: string | null;
  sourceKind: PeriodSourceKind;
  revenueCents: number;
  netIncomeCents: number;
  ownerCompCents: number;
  depreciationCents: number | null;
  interestCents: number | null;
  documentId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export function periodToApi(row: PeriodRow): PeriodApi {
  return {
    id: row.id,
    dealId: row.deal_id,
    periodLabel: row.period_label,
    periodStart: toDateOnly(row.period_start),
    periodEnd: toDateOnly(row.period_end),
    sourceKind: row.source_kind,
    revenueCents: toCents(row.revenue_cents),
    netIncomeCents: toCents(row.net_income_cents),
    ownerCompCents: toCents(row.owner_comp_cents),
    depreciationCents: toCentsOrNull(row.depreciation_cents),
    interestCents: toCentsOrNull(row.interest_cents),
    documentId: row.document_id,
    notes: row.notes,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export interface AdjustmentRow {
  id: string;
  company_id: string;
  deal_id: string;
  period_label: string;
  description: string;
  amount_cents: string | number;
  kind: AdjustmentKind;
  claimed_by: ClaimedBy;
  status: AdjustmentStatus;
  evidence_document_id: string | null;
  note: string | null;
  status_note: string | null;
  created_at: unknown;
  updated_at: unknown;
}

export interface AdjustmentApi {
  id: string;
  dealId: string;
  periodLabel: string;
  description: string;
  amountCents: number;
  kind: AdjustmentKind;
  claimedBy: ClaimedBy;
  status: AdjustmentStatus;
  evidenceDocumentId: string | null;
  note: string | null;
  statusNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export function adjustmentToApi(row: AdjustmentRow): AdjustmentApi {
  return {
    id: row.id,
    dealId: row.deal_id,
    periodLabel: row.period_label,
    description: row.description,
    amountCents: toCents(row.amount_cents),
    kind: row.kind,
    claimedBy: row.claimed_by,
    status: row.status,
    evidenceDocumentId: row.evidence_document_id,
    note: row.note,
    statusNote: row.status_note,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/** The key figures of a scenario, stored inside outputs so lists and comparisons need not reload everything. */
export interface ScenarioSummary {
  cashFlowCents: number;
  askingPriceCents: number;
  priceToCashFlowMultiple: number | null;
  priceToRevenueMultiple: number | null;
  assumedExitMultiple: number;
  buyerEquityCents: number;
  termLoanCents: number;
  sellerNoteCents: number;
  yearlyDebtServiceCents: number;
  lendableCashFlowCents: number;
  netCashFlowCents: number;
  dscr: number | null;
  exitYear: number;
  equityIrrAtExit: number | null;
  netWorthAtExitCents: number;
  checks: Record<string, boolean | null>;
}

export interface ScenarioRow {
  id: string;
  company_id: string;
  deal_id: string;
  name: string;
  earnings_basis: EarningsBasis;
  basis_note: string | null;
  comparables_note: string | null;
  inputs?: unknown;
  outputs?: unknown;
  summary?: unknown;
  created_at: unknown;
}

export interface ScenarioListItem {
  id: string;
  dealId: string;
  name: string;
  earningsBasis: EarningsBasis;
  basisNote: string | null;
  comparablesNote: string | null;
  summary: ScenarioSummary | null;
  createdAt: string;
}

export function scenarioToListItem(row: ScenarioRow): ScenarioListItem {
  const summary = (row.summary ?? (row.outputs as { summary?: unknown } | undefined)?.summary ?? null) as ScenarioSummary | null;
  return {
    id: row.id,
    dealId: row.deal_id,
    name: row.name,
    earningsBasis: row.earnings_basis,
    basisNote: row.basis_note,
    comparablesNote: row.comparables_note,
    summary,
    createdAt: toIso(row.created_at),
  };
}

export interface HistoryRow {
  id: string;
  company_id: string;
  deal_id: string;
  kind: HistoryKind;
  subject_id: string | null;
  field: string | null;
  old_value: string | null;
  new_value: string | null;
  actor: unknown;
  created_at: unknown;
}

export interface HistoryApi {
  id: string;
  dealId: string;
  kind: HistoryKind;
  subjectId: string | null;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  actor: Actor | null;
  createdAt: string;
}

export function historyToApi(row: HistoryRow): HistoryApi {
  return {
    id: row.id,
    dealId: row.deal_id,
    kind: row.kind,
    subjectId: row.subject_id,
    field: row.field,
    oldValue: row.old_value,
    newValue: row.new_value,
    actor: (row.actor ?? null) as Actor | null,
    createdAt: toIso(row.created_at),
  };
}
