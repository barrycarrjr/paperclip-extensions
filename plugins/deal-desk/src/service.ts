/**
 * The operations behind every tool and API route.
 *
 * Takes its database as an injected dependency, so the same code runs inside
 * the worker (against ctx.db) and inside the Postgres test (against a
 * throwaway schema). Company access has already been checked by the caller;
 * every query here is still scoped to call.companyId.
 *
 * Each operation parses its own raw input, so the tests exercise exactly what
 * an agent would send. Every operation that accepts free text refuses
 * credentials and full tax ids before any read or write.
 */

import { randomUUID } from "node:crypto";
import { normalizeEarnings, type Normalization } from "./calculator.js";
import type {
  Actor,
  AdjustmentApi,
  AdjustmentRow,
  AdjustmentStatus,
  DealApi,
  DealRow,
  DealStage,
  HistoryApi,
  HistoryRow,
  HistoryKind,
  PeriodApi,
  PeriodRow,
  ScenarioListItem,
  ScenarioRow,
} from "./domain.js";
import {
  ADJUSTMENT_KINDS,
  ADJUSTMENT_STATUSES,
  CLAIMED_BY,
  DEAL_STAGES,
  DEAL_STRUCTURES,
  PERIOD_SOURCE_KINDS,
  adjustmentToApi,
  dealToApi,
  historyToApi,
  periodToApi,
  scenarioToListItem,
} from "./domain.js";
import { formatCents, formatMultiple, formatPercent, formatRatio, table, yesNo } from "./format.js";
import { ASSUMED_MULTIPLE_LABEL, assertNoSensitiveContent, checkAdjustmentStatusChange } from "./guards.js";
import { parseScenarioRequest, prepareScenario, scenarioContent, type StoredScenarioInputs } from "./scenario.js";
import type { DealOutputs } from "./calculator.js";
import {
  buildCountScenariosByBasis,
  buildFindAdjustmentByDescription,
  buildFindDealByBusiness,
  buildFindPeriod,
  buildFindScenarioByIdempotencyKey,
  buildGetAdjustment,
  buildGetDeal,
  buildGetScenarios,
  buildInsertAdjustment,
  buildInsertDeal,
  buildInsertHistory,
  buildInsertPeriod,
  buildInsertScenario,
  buildListAdjustments,
  buildListDeals,
  buildListHistory,
  buildListPeriods,
  buildListScenarios,
  buildSetAdjustmentStatus,
  buildTouchDeal,
  buildUpdateAdjustment,
  buildUpdateDeal,
  buildUpdatePeriod,
  type AdjustmentPatch,
  type DealPatch,
  type PeriodPatch,
  type SqlStatement,
} from "./sql.js";
import {
  DealDeskError,
  invalid,
  parseCents,
  parseCurrency,
  parseDate,
  parseEnum,
  parseOptionalCents,
  parseOptionalEnum,
  parseOptionalText,
  parseOptionalUuid,
  parseText,
  parseUuid,
  readParams,
} from "./validate.js";

// ---- Dependencies ----

export interface DealDb {
  namespace: string;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
}

export interface ServiceDeps {
  db: DealDb;
  newId?: () => string;
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

const NOT_FOUND_DEAL = () =>
  new DealDeskError("EDEAL_NOT_FOUND", "no deal with that id in this company. Use deal_list to find it.");
const NOT_FOUND_ADJUSTMENT = () =>
  new DealDeskError("EADJUSTMENT_NOT_FOUND", "no add-back with that id in this company. Use deal_get to list them.");

function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function setIf<T extends Record<string, unknown>>(patch: T, key: keyof T, value: unknown): void {
  if (value !== undefined) (patch as Record<string, unknown>)[key as string] = value;
}

export function createDealService(deps: ServiceDeps) {
  const { db } = deps;
  const ns = db.namespace;
  const newId = deps.newId ?? randomUUID;

  const q = <T>(s: SqlStatement) => db.query<T>(s.text, s.params);
  const x = (s: SqlStatement) => db.execute(s.text, s.params);

  async function loadDeal(companyId: string, dealId: string): Promise<DealApi> {
    const rows = await q<DealRow>(buildGetDeal(ns, companyId, dealId));
    if (rows.length === 0) throw NOT_FOUND_DEAL();
    return dealToApi(rows[0]!);
  }

  async function loadAdjustment(companyId: string, adjustmentId: string): Promise<AdjustmentApi> {
    const rows = await q<AdjustmentRow>(buildGetAdjustment(ns, companyId, adjustmentId));
    if (rows.length === 0) throw NOT_FOUND_ADJUSTMENT();
    return adjustmentToApi(rows[0]!);
  }

  async function listPeriods(companyId: string, dealId: string, filter: { periodLabel?: string; sourceKind?: string } = {}) {
    return (await q<PeriodRow>(buildListPeriods(ns, companyId, dealId, filter))).map(periodToApi);
  }

  async function listAdjustments(companyId: string, dealId: string, periodLabel?: string) {
    return (await q<AdjustmentRow>(buildListAdjustments(ns, companyId, dealId, { periodLabel }))).map(adjustmentToApi);
  }

  async function writeHistory(
    call: CallContext,
    h: { dealId: string; kind: HistoryKind; subjectId?: string | null; field?: string | null; oldValue?: string | null; newValue?: string | null },
  ): Promise<void> {
    await x(
      buildInsertHistory(ns, call.companyId, {
        id: newId(),
        dealId: h.dealId,
        kind: h.kind,
        subjectId: h.subjectId ?? null,
        field: h.field ?? null,
        oldValue: h.oldValue ?? null,
        newValue: h.newValue ?? null,
        actor: call.actor,
      }),
    );
  }

  const touch = (call: CallContext, dealId: string) => x(buildTouchDeal(ns, call.companyId, dealId));
  const money = (cents: number | null | undefined, currency = "USD") => formatCents(cents, currency);

  // ---- Deals ----

  async function listDeals(call: CallContext, raw: unknown): Promise<OpResult<{ deals: DealApi[] }>> {
    const p = readParams(raw);
    let stages: DealStage[] | undefined;
    if (p.stage !== undefined && p.stage !== null) {
      const list = Array.isArray(p.stage) ? p.stage : [p.stage];
      stages = list.map((s) => parseEnum(s, DEAL_STAGES, "stage"));
    }
    const deals = (await q<DealRow>(buildListDeals(ns, call.companyId, { stages }))).map(dealToApi);
    const summary =
      deals.length === 0
        ? "No deals match."
        : deals
            .map(
              (d) =>
                `${d.name}: ${d.stage}, ${d.structure}, asking ${d.askingPriceCents === null ? "not recorded" : money(d.askingPriceCents, d.currency)} [id ${d.id}, business ${d.businessId}]`,
            )
            .join("\n");
    return { summary, data: { deals } };
  }

  async function dealBundle(call: CallContext, dealId: string, historyLimit = 50) {
    const deal = await loadDeal(call.companyId, dealId);
    const periods = await listPeriods(call.companyId, dealId);
    const adjustments = await listAdjustments(call.companyId, dealId);
    const scenarios = (await q<ScenarioRow>(buildListScenarios(ns, call.companyId, dealId))).map(scenarioToListItem);
    const history = (await q<HistoryRow>(buildListHistory(ns, call.companyId, dealId, historyLimit))).map(historyToApi);
    return { deal, periods, adjustments, scenarios, history };
  }

  async function getDeal(
    call: CallContext,
    raw: unknown,
  ): Promise<
    OpResult<{ deal: DealApi; periods: PeriodApi[]; adjustments: AdjustmentApi[]; scenarios: ScenarioListItem[]; history: HistoryApi[] }>
  > {
    const p = readParams(raw);
    const dealId = parseUuid(p.dealId, "dealId");
    const bundle = await dealBundle(call, dealId);
    const { deal, periods, adjustments, scenarios } = bundle;
    const c = deal.currency;
    const count = (s: AdjustmentStatus) => adjustments.filter((a) => a.status === s).length;
    const lines = [
      `${deal.name}: stage ${deal.stage}, structure ${deal.structure}, asking ${deal.askingPriceCents === null ? "not recorded" : money(deal.askingPriceCents, c)} [id ${deal.id}, business ${deal.businessId}]`,
      periods.length === 0
        ? "No earnings periods yet."
        : `Earnings periods: ${periods.map((e) => `${e.periodLabel} (${e.sourceKind}): revenue ${money(e.revenueCents, c)}, net income ${money(e.netIncomeCents, c)}, owner comp ${money(e.ownerCompCents, c)}`).join("; ")}.`,
      `Add-backs: ${adjustments.length} (${count("accepted")} accepted, ${count("unverified")} unverified, ${count("rejected")} rejected).`,
      scenarios.length === 0
        ? "No scenarios yet."
        : `Scenarios: ${scenarios
            .map(
              (s) =>
                `"${s.name}" (${s.earningsBasis}${s.summary ? `, cash flow ${money(s.summary.cashFlowCents, c)}, DSCR ${formatRatio(s.summary.dscr)}` : ""}) [id ${s.id}]`,
            )
            .join("; ")}.`,
    ];
    return { summary: lines.join("\n"), data: bundle };
  }

  async function upsertDeal(
    call: CallContext,
    raw: unknown,
  ): Promise<OpResult<{ deal: DealApi; created: boolean; changed: string[] }>> {
    const p = readParams(raw);
    assertNoSensitiveContent(p);
    const dealId = parseOptionalUuid(p.dealId, "dealId") ?? undefined;
    const businessId = parseOptionalUuid(p.businessId, "businessId") ?? undefined;
    const patch: DealPatch = {};
    setIf(patch, "name", p.name === undefined ? undefined : parseText(p.name, "name", 200));
    setIf(patch, "stage", parseOptionalEnum(p.stage, DEAL_STAGES, "stage"));
    setIf(patch, "structure", parseOptionalEnum(p.structure, DEAL_STRUCTURES, "structure"));
    setIf(patch, "acquiringEntity", parseOptionalText(p.acquiringEntity, "acquiringEntity", 500));
    setIf(patch, "askingPriceCents", parseOptionalCents(p.askingPriceCents, "askingPriceCents", { min: 0 }));
    setIf(patch, "currency", p.currency === undefined || p.currency === null ? undefined : parseCurrency(p.currency));
    setIf(patch, "notes", parseOptionalText(p.notes, "notes", 10000));

    let existing: DealApi | null = null;
    if (dealId) {
      existing = await loadDeal(call.companyId, dealId);
      if (businessId && businessId !== existing.businessId) {
        throw invalid("businessId of an existing deal cannot change. Create a new deal for the other business.");
      }
    } else if (businessId) {
      const rows = await q<DealRow>(buildFindDealByBusiness(ns, call.companyId, businessId));
      existing = rows[0] ? dealToApi(rows[0]) : null;
    } else {
      throw invalid("give dealId (to update a deal) or businessId (the business-records id of the target, to find or create its deal).");
    }

    if (!existing) {
      if (patch.name === undefined) throw invalid("name is required to create a deal: the target's name, for display.");
      const id = newId();
      const result = await x(
        buildInsertDeal(ns, call.companyId, {
          id,
          businessId: businessId!,
          name: patch.name as string,
          stage: (patch.stage as string | undefined) ?? "screen",
          structure: (patch.structure as string | undefined) ?? "undecided",
          acquiringEntity: (patch.acquiringEntity as string | null | undefined) ?? null,
          askingPriceCents: (patch.askingPriceCents as number | null | undefined) ?? null,
          currency: (patch.currency as string | undefined) ?? "USD",
          notes: (patch.notes as string | null | undefined) ?? null,
        }),
      );
      if (result.rowCount > 0) {
        await writeHistory(call, { dealId: id, kind: "deal_created", newValue: patch.name as string });
        const deal = await loadDeal(call.companyId, id);
        return { summary: `Created deal ${deal.name} at stage ${deal.stage} [id ${deal.id}].`, data: { deal, created: true, changed: [] } };
      }
      // Lost a race with another call creating the deal for this business: carry on as an update.
      const rows = await q<DealRow>(buildFindDealByBusiness(ns, call.companyId, businessId!));
      if (!rows[0]) throw new DealDeskError("ECONFLICT", "the deal could not be created or found; try again.");
      existing = dealToApi(rows[0]);
    }

    const current: Record<string, unknown> = {
      name: existing.name,
      stage: existing.stage,
      structure: existing.structure,
      acquiringEntity: existing.acquiringEntity,
      askingPriceCents: existing.askingPriceCents,
      currency: existing.currency,
      notes: existing.notes,
    };
    const changedPatch: DealPatch = {};
    for (const key of Object.keys(patch) as (keyof DealPatch)[]) {
      if (!sameValue(patch[key], current[key])) changedPatch[key] = patch[key];
    }
    const changed = Object.keys(changedPatch);
    if (changed.length === 0) {
      return { summary: `No change: ${existing.name} already matches [id ${existing.id}].`, data: { deal: existing, created: false, changed: [] } };
    }
    await x(buildUpdateDeal(ns, call.companyId, existing.id, changedPatch)!);
    for (const key of changed) {
      await writeHistory(call, {
        dealId: existing.id,
        kind: key === "stage" ? "stage_change" : "deal_updated",
        field: key,
        oldValue: asText(current[key]),
        newValue: asText(changedPatch[key as keyof DealPatch]),
      });
    }
    const deal = await loadDeal(call.companyId, existing.id);
    return { summary: `Updated ${deal.name}: ${changed.join(", ")} [id ${deal.id}].`, data: { deal, created: false, changed } };
  }

  // ---- Earnings periods ----

  async function upsertPeriod(
    call: CallContext,
    raw: unknown,
  ): Promise<OpResult<{ period: PeriodApi; created: boolean; changed: string[] }>> {
    const p = readParams(raw);
    assertNoSensitiveContent(p);
    const dealId = parseUuid(p.dealId, "dealId");
    const periodLabel = parseText(p.periodLabel, "periodLabel", 100);
    const sourceKind = parseEnum(p.sourceKind, PERIOD_SOURCE_KINDS, "sourceKind");
    const patch: PeriodPatch = {};
    setIf(patch, "periodStart", p.periodStart === undefined ? undefined : parseDate(p.periodStart, "periodStart"));
    setIf(patch, "periodEnd", p.periodEnd === undefined ? undefined : parseDate(p.periodEnd, "periodEnd"));
    setIf(patch, "revenueCents", p.revenueCents === undefined ? undefined : parseCents(p.revenueCents, "revenueCents", { min: 0 }));
    setIf(patch, "netIncomeCents", p.netIncomeCents === undefined ? undefined : parseCents(p.netIncomeCents, "netIncomeCents"));
    setIf(patch, "ownerCompCents", p.ownerCompCents === undefined ? undefined : parseCents(p.ownerCompCents, "ownerCompCents", { min: 0 }));
    setIf(patch, "depreciationCents", parseOptionalCents(p.depreciationCents, "depreciationCents", { min: 0 }));
    setIf(patch, "interestCents", parseOptionalCents(p.interestCents, "interestCents", { min: 0 }));
    setIf(patch, "documentId", parseOptionalUuid(p.documentId, "documentId"));
    setIf(patch, "notes", parseOptionalText(p.notes, "notes", 10000));

    const deal = await loadDeal(call.companyId, dealId);
    const find = async () =>
      (await q<PeriodRow>(buildFindPeriod(ns, call.companyId, { dealId, periodLabel, sourceKind })))[0] ?? null;
    let existingRow = await find();

    if (!existingRow) {
      for (const key of ["periodStart", "periodEnd", "revenueCents", "netIncomeCents", "ownerCompCents"] as const) {
        if (patch[key] === undefined) {
          throw invalid(
            `${key} is required to add a period${key.endsWith("Cents") ? ": a whole number of cents, never left out to mean zero" : " (YYYY-MM-DD)"}.`,
          );
        }
      }
      if ((patch.periodEnd as string) < (patch.periodStart as string)) throw invalid("periodEnd must not be before periodStart.");
      const id = newId();
      const result = await x(
        buildInsertPeriod(ns, call.companyId, {
          id,
          dealId,
          periodLabel,
          sourceKind,
          periodStart: patch.periodStart as string,
          periodEnd: patch.periodEnd as string,
          revenueCents: patch.revenueCents as number,
          netIncomeCents: patch.netIncomeCents as number,
          ownerCompCents: patch.ownerCompCents as number,
          depreciationCents: (patch.depreciationCents as number | null | undefined) ?? null,
          interestCents: (patch.interestCents as number | null | undefined) ?? null,
          documentId: (patch.documentId as string | null | undefined) ?? null,
          notes: (patch.notes as string | null | undefined) ?? null,
        }),
      );
      if (result.rowCount > 0) {
        await writeHistory(call, { dealId, kind: "period_added", subjectId: id, newValue: `${periodLabel} (${sourceKind})` });
        await touch(call, dealId);
        const period = periodToApi((await find())!);
        return {
          summary: `Added period ${periodLabel} (${sourceKind}) to ${deal.name}: revenue ${money(period.revenueCents, deal.currency)}, net income ${money(period.netIncomeCents, deal.currency)}, owner comp ${money(period.ownerCompCents, deal.currency)} [id ${period.id}].`,
          data: { period, created: true, changed: [] },
        };
      }
      existingRow = await find();
      if (!existingRow) throw new DealDeskError("ECONFLICT", "the period could not be added or found; try again.");
    }

    const existing = periodToApi(existingRow);
    const current: Record<string, unknown> = {
      periodStart: existing.periodStart,
      periodEnd: existing.periodEnd,
      revenueCents: existing.revenueCents,
      netIncomeCents: existing.netIncomeCents,
      ownerCompCents: existing.ownerCompCents,
      depreciationCents: existing.depreciationCents,
      interestCents: existing.interestCents,
      documentId: existing.documentId,
      notes: existing.notes,
    };
    const changedPatch: PeriodPatch = {};
    for (const key of Object.keys(patch) as (keyof PeriodPatch)[]) {
      if (!sameValue(patch[key], current[key])) changedPatch[key] = patch[key];
    }
    const changed = Object.keys(changedPatch);
    if (changed.length === 0) {
      return { summary: `No change: period ${periodLabel} (${sourceKind}) already matches [id ${existing.id}].`, data: { period: existing, created: false, changed: [] } };
    }
    const start = (changedPatch.periodStart ?? existing.periodStart) as string;
    const end = (changedPatch.periodEnd ?? existing.periodEnd) as string;
    if (end < start) throw invalid("periodEnd must not be before periodStart.");
    await x(buildUpdatePeriod(ns, call.companyId, existing.id, changedPatch)!);
    for (const key of changed) {
      await writeHistory(call, {
        dealId,
        kind: "period_updated",
        subjectId: existing.id,
        field: key,
        oldValue: asText(current[key]),
        newValue: asText(changedPatch[key as keyof PeriodPatch]),
      });
    }
    await touch(call, dealId);
    const period = periodToApi((await find())!);
    return {
      summary: `Updated period ${periodLabel} (${sourceKind}) of ${deal.name}: ${changed.join(", ")} [id ${period.id}].`,
      data: { period, created: false, changed },
    };
  }

  // ---- Add-backs ----

  async function upsertAdjustment(
    call: CallContext,
    raw: unknown,
  ): Promise<OpResult<{ adjustment: AdjustmentApi; created: boolean; changed: string[]; statusReset: boolean }>> {
    const p = readParams(raw);
    assertNoSensitiveContent(p);
    const adjustmentId = parseOptionalUuid(p.adjustmentId, "adjustmentId") ?? undefined;
    const patch: AdjustmentPatch = {};
    setIf(patch, "description", p.description === undefined ? undefined : parseText(p.description, "description", 500));
    setIf(patch, "amountCents", p.amountCents === undefined ? undefined : parseCents(p.amountCents, "amountCents"));
    setIf(patch, "kind", parseOptionalEnum(p.kind, ADJUSTMENT_KINDS, "kind"));
    setIf(patch, "claimedBy", parseOptionalEnum(p.claimedBy, CLAIMED_BY, "claimedBy"));
    setIf(patch, "evidenceDocumentId", parseOptionalUuid(p.evidenceDocumentId, "evidenceDocumentId"));
    setIf(patch, "note", parseOptionalText(p.note, "note", 4000));
    if (p.status !== undefined) {
      throw invalid("status is not set here. New add-backs start unverified; use deal_adjustment_set_status to accept or reject one.");
    }

    const checkReplacement = (kind: unknown, amount: unknown) => {
      if (kind === "replacement_cost" && typeof amount === "number" && amount <= 0) {
        throw invalid("a replacement_cost add-back is the yearly cost of replacing the owner: amountCents must be a positive number. It is deducted, never added.");
      }
    };

    if (!adjustmentId) {
      const dealId = parseUuid(p.dealId, "dealId");
      const periodLabel = parseText(p.periodLabel, "periodLabel", 100);
      for (const key of ["description", "amountCents", "kind", "claimedBy"] as const) {
        if (patch[key] === undefined) {
          throw invalid(`${key} is required to add an add-back${key === "amountCents" ? ": a whole number of cents (negative for a deduction)" : ""}.`);
        }
      }
      checkReplacement(patch.kind, patch.amountCents);
      const deal = await loadDeal(call.companyId, dealId);
      const periods = await listPeriods(call.companyId, dealId, { periodLabel });
      if (periods.length === 0) {
        throw new DealDeskError(
          "EPERIOD_NOT_FOUND",
          `this deal has no earnings period ${periodLabel}. Add the period's figures with deal_period_upsert first, so the add-back has something to adjust.`,
        );
      }
      const duplicate = (
        await q<AdjustmentRow>(
          buildFindAdjustmentByDescription(ns, call.companyId, { dealId, periodLabel, description: patch.description as string }),
        )
      )[0];
      if (duplicate) {
        throw new DealDeskError(
          "EDUPLICATE_ADJUSTMENT",
          `an add-back with that description already exists for ${periodLabel} [id ${duplicate.id}], so it cannot be counted twice. To change it, call again with adjustmentId.`,
        );
      }
      const id = newId();
      const result = await x(
        buildInsertAdjustment(ns, call.companyId, {
          id,
          dealId,
          periodLabel,
          description: patch.description as string,
          amountCents: patch.amountCents as number,
          kind: patch.kind as AdjustmentApi["kind"],
          claimedBy: patch.claimedBy as AdjustmentApi["claimedBy"],
          evidenceDocumentId: (patch.evidenceDocumentId as string | null | undefined) ?? null,
          note: (patch.note as string | null | undefined) ?? null,
        }),
      );
      if (result.rowCount === 0) {
        throw new DealDeskError("EDUPLICATE_ADJUSTMENT", `an add-back with that description already exists for ${periodLabel}, so it cannot be counted twice.`);
      }
      await writeHistory(call, { dealId, kind: "adjustment_added", subjectId: id, newValue: `${periodLabel}: ${patch.description as string}` });
      await touch(call, dealId);
      const adjustment = await loadAdjustment(call.companyId, id);
      return {
        summary: `Added add-back "${adjustment.description}" ${money(adjustment.amountCents, deal.currency)} for ${periodLabel} (${adjustment.kind}, claimed by ${adjustment.claimedBy}), status unverified [id ${adjustment.id}]. It counts in seller-claimed SDE only until it is accepted with evidence.`,
        data: { adjustment, created: true, changed: [], statusReset: false },
      };
    }

    // ---- Update an existing add-back ----
    const existing = await loadAdjustment(call.companyId, adjustmentId);
    if (p.dealId !== undefined && parseUuid(p.dealId, "dealId") !== existing.dealId) {
      throw invalid("dealId does not match the add-back's deal.");
    }
    if (p.periodLabel !== undefined && parseText(p.periodLabel, "periodLabel", 100) !== existing.periodLabel) {
      throw invalid("periodLabel of an existing add-back cannot change. Add a new one for the other period.");
    }
    const current: Record<string, unknown> = {
      description: existing.description,
      amountCents: existing.amountCents,
      kind: existing.kind,
      claimedBy: existing.claimedBy,
      evidenceDocumentId: existing.evidenceDocumentId,
      note: existing.note,
    };
    const changedPatch: AdjustmentPatch = {};
    for (const key of Object.keys(patch) as (keyof AdjustmentPatch)[]) {
      if (!sameValue(patch[key], current[key])) changedPatch[key] = patch[key];
    }
    const changed = Object.keys(changedPatch);
    if (changed.length === 0) {
      return {
        summary: `No change: add-back "${existing.description}" already matches [id ${existing.id}].`,
        data: { adjustment: existing, created: false, changed: [], statusReset: false },
      };
    }
    checkReplacement(changedPatch.kind ?? existing.kind, changedPatch.amountCents ?? existing.amountCents);
    if (changedPatch.description !== undefined) {
      const clash = (
        await q<AdjustmentRow>(
          buildFindAdjustmentByDescription(ns, call.companyId, {
            dealId: existing.dealId,
            periodLabel: existing.periodLabel,
            description: changedPatch.description as string,
          }),
        )
      )[0];
      if (clash && clash.id !== existing.id) {
        throw new DealDeskError("EDUPLICATE_ADJUSTMENT", `another add-back for ${existing.periodLabel} already has that description [id ${clash.id}].`);
      }
    }
    const statusReset =
      existing.status !== "unverified" &&
      (["description", "amountCents", "kind", "evidenceDocumentId"] as const).some((k) => changedPatch[k] !== undefined);
    let result: { rowCount: number };
    try {
      result = await x(
        buildUpdateAdjustment(ns, call.companyId, existing.id, changedPatch, { resetStatus: statusReset, expectedStatus: existing.status })!,
      );
    } catch (err) {
      if (/duplicate key|unique/i.test((err as Error).message ?? "")) {
        throw new DealDeskError("EDUPLICATE_ADJUSTMENT", `another add-back for ${existing.periodLabel} already has that description.`);
      }
      throw err;
    }
    if (result.rowCount === 0) {
      throw new DealDeskError("ECONFLICT", "the add-back changed while this call was running. Read it again with deal_get and retry.");
    }
    for (const key of changed) {
      await writeHistory(call, {
        dealId: existing.dealId,
        kind: "adjustment_updated",
        subjectId: existing.id,
        field: key,
        oldValue: asText(current[key]),
        newValue: asText(changedPatch[key as keyof AdjustmentPatch]),
      });
    }
    if (statusReset) {
      await writeHistory(call, {
        dealId: existing.dealId,
        kind: "adjustment_status_change",
        subjectId: existing.id,
        field: "status",
        oldValue: existing.status,
        newValue: "unverified",
      });
    }
    await touch(call, existing.dealId);
    const adjustment = await loadAdjustment(call.companyId, existing.id);
    return {
      summary: `Updated add-back "${adjustment.description}": ${changed.join(", ")}${statusReset ? `. It was ${existing.status} and is now unverified again, because what was checked has changed` : ""} [id ${adjustment.id}].`,
      data: { adjustment, created: false, changed, statusReset },
    };
  }

  async function setAdjustmentStatus(
    call: CallContext,
    raw: unknown,
  ): Promise<OpResult<{ adjustment: AdjustmentApi; changed: boolean }>> {
    const p = readParams(raw);
    assertNoSensitiveContent(p);
    const adjustmentId = parseUuid(p.adjustmentId, "adjustmentId");
    const status = parseEnum(p.status, ADJUSTMENT_STATUSES, "status");
    const evidenceGiven = parseOptionalUuid(p.evidenceDocumentId, "evidenceDocumentId") ?? null;
    const note = parseOptionalText(p.note, "note", 4000) ?? null;

    const existing = await loadAdjustment(call.companyId, adjustmentId);
    const evidence = evidenceGiven ?? existing.evidenceDocumentId;
    checkAdjustmentStatusChange({ status, evidenceDocumentId: evidence, note });

    const statusNote = note ?? (status === existing.status ? existing.statusNote : null);
    if (status === existing.status && evidence === existing.evidenceDocumentId && statusNote === existing.statusNote) {
      return { summary: `No change: add-back "${existing.description}" is already ${status} [id ${existing.id}].`, data: { adjustment: existing, changed: false } };
    }
    const result = await x(
      buildSetAdjustmentStatus(ns, call.companyId, existing.id, { status, evidenceDocumentId: evidence, statusNote }, existing.status),
    );
    if (result.rowCount === 0) {
      throw new DealDeskError("ECONFLICT", "the add-back changed while this call was running. Read it again with deal_get and retry.");
    }
    if (status !== existing.status) {
      await writeHistory(call, {
        dealId: existing.dealId,
        kind: "adjustment_status_change",
        subjectId: existing.id,
        field: "status",
        oldValue: existing.status,
        newValue: statusNote ? `${status}: ${statusNote}` : status,
      });
    }
    if (evidence !== existing.evidenceDocumentId) {
      await writeHistory(call, {
        dealId: existing.dealId,
        kind: "adjustment_updated",
        subjectId: existing.id,
        field: "evidenceDocumentId",
        oldValue: existing.evidenceDocumentId,
        newValue: evidence,
      });
    }
    await touch(call, existing.dealId);
    const adjustment = await loadAdjustment(call.companyId, existing.id);
    const effect =
      status === "accepted"
        ? "It now counts in conservative SDE."
        : status === "rejected"
          ? "It no longer counts in either SDE figure."
          : "It counts in seller-claimed SDE only.";
    return {
      summary: `Add-back "${adjustment.description}" ${existing.status} changed to ${status}${status === "accepted" ? ` (evidence ${evidence})` : ""}. ${effect} [id ${adjustment.id}]`,
      data: { adjustment, changed: true },
    };
  }

  // ---- Normalization ----

  async function normalize(
    call: CallContext,
    raw: unknown,
  ): Promise<OpResult<{ deal: DealApi; normalizations: Array<{ period: PeriodApi; normalization: Normalization }> }>> {
    const p = readParams(raw);
    const dealId = parseUuid(p.dealId, "dealId");
    const periodLabel = parseOptionalText(p.periodLabel, "periodLabel", 100) ?? undefined;
    const sourceKind = parseOptionalEnum(p.sourceKind, PERIOD_SOURCE_KINDS, "sourceKind");
    const deal = await loadDeal(call.companyId, dealId);
    const periods = await listPeriods(call.companyId, dealId, { periodLabel, sourceKind });
    if (periods.length === 0) {
      if (periodLabel || sourceKind) {
        throw new DealDeskError("EPERIOD_NOT_FOUND", "no earnings period on this deal matches. Add it with deal_period_upsert first.");
      }
      return { summary: `${deal.name} has no earnings periods yet. Add them with deal_period_upsert.`, data: { deal, normalizations: [] } };
    }
    const adjustments = await listAdjustments(call.companyId, dealId, periodLabel);
    const c = deal.currency;
    const normalizations = periods.map((period) => ({
      period,
      normalization: normalizeEarnings({
        reportedNetIncomeCents: period.netIncomeCents,
        ownerCompCents: period.ownerCompCents,
        interestCents: period.interestCents,
        depreciationCents: period.depreciationCents,
        adjustments: adjustments
          .filter((a) => a.periodLabel === period.periodLabel)
          .map((a) => ({
            id: a.id,
            description: a.description,
            amountCents: a.amountCents,
            kind: a.kind,
            status: a.status,
            claimedBy: a.claimedBy,
            evidenceDocumentId: a.evidenceDocumentId,
          })),
      }),
    }));
    const blocks = normalizations.map(({ period, normalization: n }) => {
      const mark = (l: Normalization["lines"][number]) =>
        l.source !== "adjustment" ? "" : l.status === "accepted" ? " [accepted]" : l.status === "rejected" ? " [rejected, not counted]" : " [UNVERIFIED]";
      const out = [
        `${period.periodLabel} (${period.sourceKind}): conservative SDE ${money(n.conservativeSdeCents, c)}, seller-claimed SDE ${money(n.sellerClaimedSdeCents, c)} (difference ${money(n.unverifiedGapCents, c)} rests on unverified add-backs).`,
        ...n.lines.map((l) => `  ${l.label}: ${money(l.amountCents, c)}${mark(l)}`),
      ];
      if (n.ownerReplacement.lines.length > 0) {
        out.push(
          `  Owner replacement cost (deducted, not part of SDE): ${money(n.ownerReplacement.totalCents, c)}; conservative SDE after owner replacement ${money(n.ownerReplacement.conservativeSdeAfterReplacementCents, c)}, seller-claimed ${money(n.ownerReplacement.sellerClaimedSdeAfterReplacementCents, c)}.`,
        );
      }
      out.push(
        n.ebitda.ebitdaCents === null
          ? `  EBITDA (separate from SDE): not computed, missing ${n.ebitda.missing.join(" and ")}.`
          : `  EBITDA (separate from SDE, no owner comp): ${money(n.ebitda.ebitdaCents, c)}.`,
      );
      if (n.unverified.count > 0) out.push(`  ${n.unverified.count} unverified add-back(s) totalling ${money(n.unverified.totalCents, c)}.`);
      return out.join("\n");
    });
    return { summary: blocks.join("\n"), data: { deal, normalizations } };
  }

  // ---- Scenarios ----

  function scenarioFromRow(row: ScenarioRow & { currency?: string; deal_name?: string }) {
    return {
      ...scenarioToListItem(row),
      dealName: row.deal_name ?? null,
      currency: row.currency ? String(row.currency).trim() : "USD",
      inputs: row.inputs as StoredScenarioInputs,
      outputs: row.outputs as DealOutputs,
    };
  }

  async function runScenario(
    call: CallContext,
    raw: unknown,
  ): Promise<OpResult<{ scenario: ScenarioListItem; inputs: StoredScenarioInputs; outputs: DealOutputs; reused: boolean }>> {
    const req = parseScenarioRequest(raw);
    const deal = await loadDeal(call.companyId, req.dealId);

    const reuse = async () => {
      if (!req.idempotencyKey) return null;
      const row = (await q<ScenarioRow>(buildFindScenarioByIdempotencyKey(ns, call.companyId, deal.id, req.idempotencyKey)))[0];
      if (!row) return null;
      const s = scenarioFromRow(row);
      return {
        summary: scenarioContent({ scenarioId: s.id, name: s.name, currency: deal.currency, stored: s.inputs, outputs: s.outputs, reused: true }),
        data: { scenario: scenarioToListItem(row), inputs: s.inputs, outputs: s.outputs, reused: true },
      };
    };
    const earlier = await reuse();
    if (earlier) return earlier;

    const conservativeCount = (
      await q<{ n: number }>(buildCountScenariosByBasis(ns, call.companyId, deal.id, "conservative"))
    )[0]?.n ?? 0;
    const periods = req.periodLabel ? await listPeriods(call.companyId, deal.id, { periodLabel: req.periodLabel }) : [];
    const adjustments = req.periodLabel ? await listAdjustments(call.companyId, deal.id, req.periodLabel) : [];
    const prepared = prepareScenario(req, { deal, hasConservativeScenario: Number(conservativeCount) > 0, periods, adjustments });

    const id = newId();
    const result = await x(
      buildInsertScenario(ns, call.companyId, {
        id,
        dealId: deal.id,
        name: req.name,
        earningsBasis: req.earningsBasis,
        basisNote: req.basisNote,
        comparablesNote: req.comparablesNote,
        inputs: prepared.storedInputs,
        outputs: prepared.outputs,
        idempotencyKey: req.idempotencyKey,
      }),
    );
    if (result.rowCount === 0) {
      const raced = await reuse();
      if (raced) return raced;
      throw new DealDeskError("ECONFLICT", "the scenario could not be saved; try again.");
    }
    await writeHistory(call, { dealId: deal.id, kind: "scenario_saved", subjectId: id, newValue: `${req.name} (${req.earningsBasis})` });
    await touch(call, deal.id);
    const row = (await q<ScenarioRow>(buildGetScenarios(ns, call.companyId, [id])))[0]!;
    return {
      summary: scenarioContent({ scenarioId: id, name: req.name, currency: deal.currency, stored: prepared.storedInputs, outputs: prepared.outputs }),
      data: { scenario: scenarioToListItem(row), inputs: prepared.storedInputs, outputs: prepared.outputs, reused: false },
    };
  }

  async function compareScenarios(
    call: CallContext,
    raw: unknown,
  ): Promise<OpResult<{ scenarios: Array<ScenarioListItem & { dealName: string | null; currency: string }> }>> {
    const p = readParams(raw);
    if (!Array.isArray(p.scenarioIds) || p.scenarioIds.length < 2 || p.scenarioIds.length > 10) {
      throw invalid("scenarioIds must be a list of 2 to 10 scenario ids.");
    }
    const ids: string[] = [];
    for (const raw of p.scenarioIds) {
      const id = parseUuid(raw, "scenarioIds");
      if (!ids.includes(id)) ids.push(id);
    }
    if (ids.length < 2) throw invalid("scenarioIds must name at least two different scenarios.");
    const rows = await q<ScenarioRow & { currency?: string; deal_name?: string }>(buildGetScenarios(ns, call.companyId, ids));
    const byId = new Map(rows.map((r) => [r.id, scenarioFromRow(r)]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new DealDeskError("ESCENARIO_NOT_FOUND", `${missing.length} of the scenario ids are not scenarios in this company: ${missing.join(", ")}.`);
    }
    const scenarios = ids.map((id) => byId.get(id)!);
    const figure = (label: string, f: (s: (typeof scenarios)[number]) => string) => [label, ...scenarios.map(f)];
    const m = (s: (typeof scenarios)[number], cents: number | null | undefined) => formatCents(cents, s.currency);
    const sum = (s: (typeof scenarios)[number]) => s.outputs.summary;
    const rowsOut = [
      figure("Deal", (s) => s.dealName ?? s.dealId),
      figure("Earnings basis", (s) => s.earningsBasis),
      figure("Cash flow used", (s) => m(s, sum(s).cashFlowCents)),
      figure("Asking price", (s) => m(s, sum(s).askingPriceCents)),
      figure("Price / cash flow", (s) => formatMultiple(sum(s).priceToCashFlowMultiple)),
      figure("Price / revenue", (s) => formatMultiple(sum(s).priceToRevenueMultiple)),
      figure(`${ASSUMED_MULTIPLE_LABEL[0]!.toUpperCase()}${ASSUMED_MULTIPLE_LABEL.slice(1)}`, (s) => formatMultiple(sum(s).assumedExitMultiple)),
      figure("Buyer equity", (s) => m(s, sum(s).buyerEquityCents)),
      figure("Yearly debt service", (s) => m(s, sum(s).yearlyDebtServiceCents)),
      figure("Net cash flow", (s) => m(s, sum(s).netCashFlowCents)),
      figure("DSCR", (s) => formatRatio(sum(s).dscr)),
      figure("Exit year", (s) => String(sum(s).exitYear)),
      figure("Equity IRR at exit", (s) => formatPercent(sum(s).equityIrrAtExit)),
      figure("Net worth at exit", (s) => m(s, sum(s).netWorthAtExitCents)),
      figure("Sources equal uses", (s) => yesNo(sum(s).checks.sourcesEqualUses)),
      figure("DSCR at least 1.25", (s) => yesNo(sum(s).checks.dscrAtLeast125)),
    ];
    const summary = [
      `Comparing ${scenarios.length} scenarios. Exit multiples are assumptions, not market figures.`,
      table(["", ...scenarios.map((s) => `${s.name} [${s.id}]`)], rowsOut),
    ].join("\n");
    return {
      summary,
      data: {
        scenarios: scenarios.map((s) => ({
          id: s.id,
          dealId: s.dealId,
          dealName: s.dealName,
          currency: s.currency,
          name: s.name,
          earningsBasis: s.earningsBasis,
          basisNote: s.basisNote,
          comparablesNote: s.comparablesNote,
          summary: s.outputs.summary,
          createdAt: s.createdAt,
        })),
      },
    };
  }

  // ---- Board API ----

  async function dealDetail(call: CallContext, dealId: string) {
    return dealBundle(call, parseUuid(dealId, "dealId"), 200);
  }

  return {
    listDeals,
    getDeal,
    upsertDeal,
    upsertPeriod,
    upsertAdjustment,
    setAdjustmentStatus,
    normalize,
    runScenario,
    compareScenarios,
    dealDetail,
  };
}

export type DealService = ReturnType<typeof createDealService>;
