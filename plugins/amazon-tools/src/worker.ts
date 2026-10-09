import {
  definePlugin,
  runWorker,
  type PluginContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { isCompanyAllowed } from "./companyAccess.js";
import {
  type InstanceConfig,
  type ResolvedAccount,
  checkAccountShape,
  downloadDocument,
  openAccount,
  redact,
  resolveAccount,
  spRequest,
} from "./spApi.js";
import {
  dropEmpty,
  trimFbaInventory,
  trimFinancialEvents,
  trimListingInventory,
  trimOrder,
  trimOrderItem,
  trimReport,
  trimSettlement,
} from "./trim.js";
import { REPORT_TYPES, isAllowedReportType, parseReport } from "./reports.js";
import { TOOL_DEFS } from "./toolDefs.js";

type Params = Record<string, unknown>;
type Handler = (p: Params, acct: ResolvedAccount, runCtx: ToolRunContext) => Promise<{
  content: string;
  data: unknown;
  /** Small, non-sensitive facts for the activity log. */
  activity?: Record<string, unknown>;
}>;

const DAY = 24 * 3600 * 1000;

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function strList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((v): v is string => typeof v === "string" && v.trim() !== "");
  return list.length > 0 ? list : undefined;
}

function isoDate(value: unknown, field: string): string | undefined {
  const s = str(value);
  if (!s) return undefined;
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`[EINVALID_INPUT] \`${field}\` is not a valid ISO 8601 date.`);
  return new Date(t).toISOString();
}

function marketplacesFor(acct: ResolvedAccount, requested: string[] | undefined): string[] {
  if (!requested) return acct.marketplaceIds;
  const unknown = requested.filter((m) => !acct.marketplaceIds.includes(m));
  if (unknown.length > 0) {
    throw new Error(
      `[EINVALID_INPUT] Marketplace ${unknown.join(", ")} is not configured on account "${acct.accountKey}".`,
    );
  }
  return requested;
}

// ─── Tool handlers ───────────────────────────────────────────────────────

const handlers: Record<string, Handler> = {
  async amazon_list_orders(p, acct) {
    const lastUpdatedAfter = isoDate(p.lastUpdatedAfter, "lastUpdatedAfter");
    const nextToken = str(p.nextToken);
    const query: Record<string, string | number | string[] | undefined> = {
      MarketplaceIds: marketplacesFor(acct, strList(p.marketplaceIds)),
      MaxResultsPerPage: clamp(p.maxResults, 50, 1, 100),
    };
    if (nextToken) {
      query.NextToken = nextToken;
    } else {
      if (lastUpdatedAfter) query.LastUpdatedAfter = lastUpdatedAfter;
      else query.CreatedAfter = isoDate(p.createdAfter, "createdAfter") ?? new Date(Date.now() - 7 * DAY).toISOString();
      query.CreatedBefore = isoDate(p.createdBefore, "createdBefore");
      query.OrderStatuses = strList(p.orderStatuses);
      query.FulfillmentChannels = strList(p.fulfillmentChannels);
    }
    const res = await spRequest<{ payload?: { Orders?: unknown[]; NextToken?: string } }>(
      acct,
      "/orders/v0/orders",
      { query },
    );
    const orders = (res.payload?.Orders ?? []).map(trimOrder);
    return {
      content: `Found ${orders.length} order(s) on ${acct.accountKey}.`,
      data: { orders, nextToken: res.payload?.NextToken ?? null },
      activity: { count: orders.length },
    };
  },

  async amazon_get_order(p, acct) {
    const orderId = str(p.orderId);
    if (!orderId) throw new Error("[EINVALID_INPUT] `orderId` is required.");
    const id = encodeURIComponent(orderId);
    const order = await spRequest<{ payload?: unknown }>(acct, `/orders/v0/orders/${id}`);
    const data: Record<string, unknown> = { order: trimOrder(order.payload) };
    if (p.includeItems !== false) {
      const items: unknown[] = [];
      let token: string | undefined;
      let pages = 0;
      do {
        const res = await spRequest<{ payload?: { OrderItems?: unknown[]; NextToken?: string } }>(
          acct,
          `/orders/v0/orders/${id}/orderItems`,
          { query: { NextToken: token } },
        );
        items.push(...(res.payload?.OrderItems ?? []).map(trimOrderItem));
        token = res.payload?.NextToken;
        pages++;
      } while (token && pages < 5);
      data.items = items;
    }
    return {
      content: `Retrieved order ${orderId}.`,
      data,
      activity: { orderId },
    };
  },

  async amazon_list_settlements(p, acct) {
    const nextToken = str(p.nextToken);
    const query: Record<string, string | number | undefined> = {
      MaxResultsPerPage: clamp(p.maxResults, 50, 1, 100),
    };
    if (nextToken) query.NextToken = nextToken;
    else {
      query.FinancialEventGroupStartedAfter =
        isoDate(p.startedAfter, "startedAfter") ?? new Date(Date.now() - 90 * DAY).toISOString();
      query.FinancialEventGroupStartedBefore = isoDate(p.startedBefore, "startedBefore");
    }
    const res = await spRequest<{
      payload?: { FinancialEventGroupList?: unknown[]; NextToken?: string };
    }>(acct, "/finances/v0/financialEventGroups", { query });
    const settlements = (res.payload?.FinancialEventGroupList ?? []).map(trimSettlement);
    return {
      content: `Found ${settlements.length} settlement(s) on ${acct.accountKey}.`,
      data: { settlements, nextToken: res.payload?.NextToken ?? null },
      activity: { count: settlements.length },
    };
  },

  async amazon_get_settlement(p, acct) {
    const id = str(p.settlementId);
    if (!id) throw new Error("[EINVALID_INPUT] `settlementId` is required.");
    const res = await spRequest<{
      payload?: { FinancialEvents?: unknown; NextToken?: string };
    }>(acct, `/finances/v0/financialEventGroups/${encodeURIComponent(id)}/financialEvents`, {
      query: { MaxResultsPerPage: 100, NextToken: str(p.nextToken) },
    });
    const trimmed = trimFinancialEvents(res.payload?.FinancialEvents, clamp(p.maxPerType, 25, 1, 100));
    return {
      content: `Settlement ${id}: ${describeCounts(trimmed.counts)}.`,
      data: { settlementId: id, ...trimmed, nextToken: res.payload?.NextToken ?? null },
      activity: { settlementId: id },
    };
  },

  async amazon_list_financial_events(p, acct) {
    const nextToken = str(p.nextToken);
    const query: Record<string, string | number | undefined> = { MaxResultsPerPage: 100 };
    if (nextToken) query.NextToken = nextToken;
    else {
      const after = isoDate(p.postedAfter, "postedAfter");
      if (!after) throw new Error("[EINVALID_INPUT] `postedAfter` is required unless `nextToken` is given.");
      const latest = Date.now() - 3 * 60 * 1000;
      const before = isoDate(p.postedBefore, "postedBefore");
      query.PostedAfter = after;
      query.PostedBefore = new Date(Math.min(before ? Date.parse(before) : latest, latest)).toISOString();
    }
    const res = await spRequest<{
      payload?: { FinancialEvents?: unknown; NextToken?: string };
    }>(acct, "/finances/v0/financialEvents", { query });
    const trimmed = trimFinancialEvents(res.payload?.FinancialEvents, clamp(p.maxPerType, 25, 1, 100));
    return {
      content: `Financial events: ${describeCounts(trimmed.counts)}.`,
      data: { ...trimmed, nextToken: res.payload?.NextToken ?? null },
      activity: { types: Object.keys(trimmed.counts).length },
    };
  },

  async amazon_get_inventory_summary(p, acct) {
    const channel = p.channel === "merchant" ? "merchant" : "fba";
    const marketplaceId = marketplacesFor(acct, strList([p.marketplaceId]))[0]!;
    const skus = strList(p.skus);

    if (channel === "merchant") {
      if (!skus) throw new Error("[EINVALID_INPUT] `skus` is required for channel 'merchant'.");
      if (skus.length > 20) throw new Error("[EINVALID_INPUT] At most 20 SKUs per call for channel 'merchant'.");
      if (!acct.account.sellerId) {
        throw new Error(`[ECONFIG] Account "${acct.accountKey}" has no seller ID; it is needed for merchant inventory.`);
      }
      const items = [];
      for (const sku of skus) {
        const res = await spRequest(
          acct,
          `/listings/2021-08-01/items/${encodeURIComponent(acct.account.sellerId)}/${encodeURIComponent(sku)}`,
          { query: { marketplaceIds: marketplaceId, includedData: "summaries,fulfillmentAvailability" } },
        );
        items.push(trimListingInventory(sku, res, marketplaceId));
      }
      return {
        content: `Merchant inventory for ${items.length} SKU(s).`,
        data: { channel, marketplaceId, items },
        activity: { channel, count: items.length },
      };
    }

    if (skus && skus.length > 50) throw new Error("[EINVALID_INPUT] At most 50 SKUs per call for channel 'fba'.");
    const res = await spRequest<{
      payload?: { inventorySummaries?: unknown[] };
      pagination?: { nextToken?: string };
    }>(acct, "/fba/inventory/v1/summaries", {
      query: {
        details: true,
        granularityType: "Marketplace",
        granularityId: marketplaceId,
        marketplaceIds: marketplaceId,
        sellerSkus: skus,
        nextToken: str(p.nextToken),
      },
    });
    const items = (res.payload?.inventorySummaries ?? []).map(trimFbaInventory);
    return {
      content: `FBA inventory: ${items.length} SKU(s).`,
      data: { channel, marketplaceId, items, nextToken: res.pagination?.nextToken ?? null },
      activity: { channel, count: items.length },
    };
  },

  async amazon_request_report(p, acct) {
    const reportType = str(p.reportType);
    if (!isAllowedReportType(reportType)) {
      throw new Error(`[EREPORT_TYPE_BLOCKED] Report type "${reportType ?? ""}" is not on the allowed list.`);
    }
    const info = REPORT_TYPES[reportType]!;
    if (info.systemOnly) {
      throw new Error(
        `[EINVALID_INPUT] ${reportType} is created by Amazon on its own schedule and cannot be requested. Use amazon_list_reports to find existing ones.`,
      );
    }
    const body: Record<string, unknown> = {
      reportType,
      marketplaceIds: marketplacesFor(acct, strList(p.marketplaceIds)),
    };
    const start = isoDate(p.dataStartTime, "dataStartTime");
    const end = isoDate(p.dataEndTime, "dataEndTime");
    if (start) body.dataStartTime = start;
    if (end) body.dataEndTime = end;
    if (p.reportOptions && typeof p.reportOptions === "object") {
      const allowed = info.options ?? [];
      const opts: Record<string, string> = {};
      for (const [k, v] of Object.entries(p.reportOptions as Params)) {
        if (!allowed.includes(k)) throw new Error(`[EINVALID_INPUT] reportOptions.${k} is not allowed for ${reportType}.`);
        if (typeof v === "string") opts[k] = v;
      }
      if (Object.keys(opts).length > 0) body.reportOptions = opts;
    }
    const res = await spRequest<{ reportId?: string }>(acct, "/reports/2021-06-30/reports", {
      method: "POST",
      body,
    });
    return {
      content: `Requested ${reportType}. reportId ${res.reportId}. Poll amazon_get_report until processingStatus is DONE.`,
      data: { reportId: res.reportId ?? null, reportType },
      activity: { reportType, reportId: res.reportId },
    };
  },

  async amazon_list_reports(p, acct) {
    const nextToken = str(p.nextToken);
    const requested = strList(p.reportTypes);
    const blocked = (requested ?? []).filter((t) => !isAllowedReportType(t));
    if (blocked.length > 0) {
      throw new Error(`[EREPORT_TYPE_BLOCKED] Not on the allowed list: ${blocked.join(", ")}.`);
    }
    const query: Record<string, string | number | string[] | undefined> = nextToken
      ? { nextToken }
      : {
          reportTypes: requested ?? Object.keys(REPORT_TYPES),
          processingStatuses: strList(p.processingStatuses),
          createdSince: isoDate(p.createdSince, "createdSince"),
          marketplaceIds: acct.marketplaceIds,
          pageSize: clamp(p.pageSize, 20, 1, 100),
        };
    const res = await spRequest<{ reports?: unknown[]; nextToken?: string }>(
      acct,
      "/reports/2021-06-30/reports",
      { query },
    );
    const reports = (res.reports ?? [])
      .filter((r) => isAllowedReportType((r as Params)?.reportType))
      .map(trimReport);
    return {
      content: `Found ${reports.length} report(s).`,
      data: { reports, nextToken: res.nextToken ?? null },
      activity: { count: reports.length },
    };
  },

  async amazon_get_report(p, acct) {
    const reportId = str(p.reportId);
    if (!reportId) throw new Error("[EINVALID_INPUT] `reportId` is required.");
    const report = await spRequest<Params>(acct, `/reports/2021-06-30/reports/${encodeURIComponent(reportId)}`);
    if (!isAllowedReportType(report.reportType)) {
      throw new Error(
        `[EREPORT_TYPE_BLOCKED] Report ${reportId} is a ${String(report.reportType)} report, which this plugin does not read.`,
      );
    }
    const summary = trimReport(report);
    const docId = str(report.reportDocumentId);
    if (report.processingStatus !== "DONE" || !docId) {
      return {
        content: `Report ${reportId} is ${String(report.processingStatus)}.`,
        data: { report: summary },
        activity: { reportType: report.reportType, status: report.processingStatus },
      };
    }
    const doc = await spRequest<{ url?: string; compressionAlgorithm?: string }>(
      acct,
      `/reports/2021-06-30/documents/${encodeURIComponent(docId)}`,
    );
    if (!doc.url) throw new Error("[EAMAZON_DOCUMENT] Amazon returned no download URL for the report.");
    const { text } = await downloadDocument(doc.url, doc.compressionAlgorithm);
    const offset = clamp(p.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = clamp(p.limit, 100, 1, 500);
    const parsed = parseReport(text, offset, limit);
    return {
      content: `Report ${reportId} (${String(report.reportType)}): ${parsed.totalRows} row(s); returned ${parsed.rows.length} from offset ${offset}.`,
      data: { report: summary, offset, ...parsed },
      activity: { reportType: report.reportType, status: "DONE", rows: parsed.rows.length },
    };
  },
};

function describeCounts(counts: Record<string, number>): string {
  const parts = Object.entries(counts).map(([k, n]) => `${n} ${k.replace(/EventList$/, "")}`);
  return parts.length > 0 ? parts.join(", ") : "no events";
}

// ─── Plugin ──────────────────────────────────────────────────────────────

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    pluginCtx = ctx;
    const config = (await ctx.config.get()) as InstanceConfig;
    const accounts = config.accounts ?? [];
    const orphans = accounts.filter((a) => !a.allowedCompanies || a.allowedCompanies.length === 0);
    if (orphans.length > 0) {
      ctx.logger.warn(
        `amazon-tools: ${orphans.length} account(s) have no allowedCompanies and will reject every call. ` +
          `Backfill on the plugin settings page: ${orphans.map((a) => a.key ?? "(no-key)").join(", ")}`,
      );
    }
    if (accounts.length === 0) {
      ctx.logger.warn("amazon-tools: no seller accounts configured yet.");
    } else {
      ctx.logger.info(
        `amazon-tools: ready. Accounts: ${accounts
          .map((a) => {
            const n = a.allowedCompanies?.length ?? 0;
            const scope = n === 0 ? "no companies, unusable" : a.allowedCompanies!.includes("*") ? "all companies" : `${n} company(s)`;
            return `${a.key ?? "(no key)"} [${scope}]`;
          })
          .join(", ")}`,
      );
    }

    for (const def of TOOL_DEFS) {
      if (def.name === "amazon_list_accounts") {
        ctx.tools.register(def.name, def, async (_params, runCtx): Promise<ToolResult> => {
          const cfg = (await ctx.config.get()) as InstanceConfig;
          const visible = (cfg.accounts ?? [])
            .filter((a) => isCompanyAllowed(a.allowedCompanies, runCtx.companyId))
            .map((a) => ({
              account: a.key,
              name: a.name ?? null,
              region: a.region,
              marketplaceIds: a.marketplaceIds ?? [],
              isDefault: !!cfg.defaultAccount && cfg.defaultAccount === a.key,
            }));
          await logActivity(ctx, runCtx, def.name, null, true, { count: visible.length });
          return {
            content: `${visible.length} Amazon account(s) available to this company.`,
            data: { accounts: visible },
          };
        });
        continue;
      }
      const handler = handlers[def.name];
      if (!handler) throw new Error(`amazon-tools: no handler for ${def.name}`);
      ctx.tools.register(def.name, def, (params, runCtx) =>
        runTool(ctx, def.name, (params ?? {}) as Params, runCtx, handler),
      );
    }
  },

  async onValidateConfig(config) {
    return validateConfig(pluginCtx, config as InstanceConfig);
  },

  async onHealth() {
    return { status: "ok", message: "amazon-tools ready" };
  },
});

let pluginCtx: PluginContext | undefined;

async function runTool(
  ctx: PluginContext,
  tool: string,
  params: Params,
  runCtx: ToolRunContext,
  handler: Handler,
): Promise<ToolResult> {
  let acct: ResolvedAccount | undefined;
  const requested = str(params.account);
  try {
    acct = await resolveAccount(ctx, runCtx.companyId, tool, requested);
    const out = await handler(params, acct, runCtx);
    await logActivity(ctx, runCtx, tool, acct.accountKey, true, out.activity);
    return { content: out.content, data: dropEmpty(out.data) ?? {} };
  } catch (err) {
    const message = redact((err as Error).message, acct?.secretValues() ?? []);
    await logActivity(ctx, runCtx, tool, acct?.accountKey ?? requested ?? null, false, {
      error: /^\[([A-Z_0-9]+)\]/.exec(message)?.[1] ?? "ERROR",
    });
    return { error: message };
  }
}

async function logActivity(
  ctx: PluginContext,
  runCtx: ToolRunContext,
  tool: string,
  accountKey: string | null,
  ok: boolean,
  extra: Record<string, unknown> = {},
): Promise<void> {
  try {
    await ctx.activity.log({
      companyId: runCtx.companyId,
      message: `Amazon ${tool.replace(/^amazon_/, "").replace(/_/g, " ")}${accountKey ? ` (${accountKey})` : ""}${ok ? "" : " failed"}`,
      entityType: "amazon_account",
      entityId: accountKey ?? undefined,
      metadata: { tool, ok, agentId: runCtx.agentId, runId: runCtx.runId, ...extra },
    });
  } catch (err) {
    ctx.logger.warn("amazon-tools: could not write activity entry", { tool, error: (err as Error).message });
  }
}

export async function validateConfig(
  ctx: PluginContext | undefined,
  config: InstanceConfig,
): Promise<{ ok: boolean; errors?: string[]; warnings?: string[] }> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const accounts = config.accounts ?? [];
  if (accounts.length === 0) return { ok: false, errors: ["Add at least one seller account."] };

  const keys = accounts.map((a) => (a.key ?? "").toLowerCase());
  if (new Set(keys).size !== keys.length) errors.push("Account identifiers must be unique.");
  if (config.defaultAccount && !accounts.some((a) => a.key === config.defaultAccount)) {
    errors.push(`Default account "${config.defaultAccount}" is not in the list.`);
  }

  for (const account of accounts) {
    const shape = checkAccountShape(account);
    if (shape.length > 0) {
      errors.push(...shape);
      continue;
    }
    if (!account.allowedCompanies || account.allowedCompanies.length === 0) {
      warnings.push(`Account "${account.key}" has no allowed companies, so no agent can use it.`);
    }
    if (!ctx) continue;
    let acct: ResolvedAccount | undefined;
    try {
      acct = openAccount(ctx, account, "connection-test");
      const res = await spRequest<{
        payload?: Array<{ marketplace?: { id?: string }; participation?: { isParticipating?: boolean } }>;
      }>(acct, "/sellers/v1/marketplaceParticipations");
      const active = new Set(
        (res.payload ?? []).filter((x) => x.participation?.isParticipating !== false).map((x) => x.marketplace?.id),
      );
      const missing = account.marketplaceIds!.filter((m) => !active.has(m));
      if (missing.length > 0) {
        errors.push(`Account "${account.key}": not selling in marketplace ${missing.join(", ")}.`);
      }
    } catch (err) {
      let msg = redact((err as Error).message, acct?.secretValues() ?? []);
      if (/not found/i.test(msg) && /secret/i.test(msg)) {
        msg += " Save the configuration first, wait 30 seconds, then test again.";
      }
      errors.push(`Account "${account.key}": ${msg}`);
    }
  }
  return errors.length > 0 ? { ok: false, errors, warnings } : { ok: true, warnings };
}

export default plugin;
runWorker(plugin, import.meta.url);
