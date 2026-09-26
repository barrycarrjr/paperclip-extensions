/**
 * Agent tool handlers and board API route handlers.
 *
 * Kept out of worker.ts so they can be tested with a fake context. Every
 * handler runs the company allow-list check FIRST and returns before any
 * database call when the company is not allowed.
 */

import type { PluginApiRequestInput, PluginApiResponse, ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import { assertCompanyAccess } from "./companyAccess.js";
import type { Actor } from "./domain.js";
import type { CallContext, DealService, OpResult } from "./service.js";
import { DealDeskError, looksLikeFullTaxId } from "./validate.js";

export interface InstanceConfig {
  allowedCompanies?: string[];
}

export interface HandlerDeps {
  getConfig: () => Promise<InstanceConfig>;
  logger: {
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
  };
  /** Built per call, because the database namespace is only known once the host has initialised the worker. */
  getService: () => DealService;
}

type ToolOp = (service: DealService, call: CallContext, params: unknown) => Promise<OpResult>;

/** Every agent tool and the service operation behind it. */
export const TOOL_OPS: Record<string, ToolOp> = {
  deal_upsert: (s, c, p) => s.upsertDeal(c, p),
  deal_list: (s, c, p) => s.listDeals(c, p),
  deal_get: (s, c, p) => s.getDeal(c, p),
  deal_period_upsert: (s, c, p) => s.upsertPeriod(c, p),
  deal_adjustment_upsert: (s, c, p) => s.upsertAdjustment(c, p),
  deal_adjustment_set_status: (s, c, p) => s.setAdjustmentStatus(c, p),
  deal_normalize: (s, c, p) => s.normalize(c, p),
  deal_scenario_run: (s, c, p) => s.runScenario(c, p),
  deal_scenario_compare: (s, c, p) => s.compareScenarios(c, p),
};

/**
 * Turn any thrown error into the [ECODE] message shape. Unexpected errors are
 * reported without quoted values, so a database error that echoes input can
 * never carry a tax id or a password back out.
 */
export function errorMessage(err: unknown, op: string): { message: string; code: string } {
  if (err instanceof DealDeskError) return { message: err.message, code: err.code };
  const raw = err instanceof Error ? err.message : String(err);
  const match = /^\[(E[A-Z_]+)\]/.exec(raw);
  if (match) return { message: raw, code: match[1]! };
  // Postgres puts row values after "=(" in key detail, and inside double
  // quotes in syntax errors. Drop both.
  let cleaned = raw.replace(/"[^"]*"/g, "\"...\"").replace(/=\(.*$/s, "=(...)");
  if (looksLikeFullTaxId(cleaned)) cleaned = "details withheld";
  return { message: `[EINTERNAL] ${op} failed: ${cleaned}`, code: "EINTERNAL" };
}

function actorFromRun(runCtx: ToolRunContext): Actor {
  // The published SDK's ToolRunContext type predates userId; the host fills it
  // for chat sessions. Read it through a cast and never trust it from params.
  const userId = (runCtx as ToolRunContext & { userId?: string | null }).userId ?? null;
  return { agentId: runCtx.agentId ?? null, runId: runCtx.runId ?? null, userId };
}

export function createToolHandlers(
  deps: HandlerDeps,
): Record<string, (params: unknown, runCtx: ToolRunContext) => Promise<ToolResult>> {
  const handlers: Record<string, (params: unknown, runCtx: ToolRunContext) => Promise<ToolResult>> = {};
  for (const [name, op] of Object.entries(TOOL_OPS)) {
    handlers[name] = async (params, runCtx) => {
      const config = await deps.getConfig();
      try {
        assertCompanyAccess(deps, {
          route: name,
          allowedCompanies: config.allowedCompanies,
          companyId: runCtx.companyId,
        });
      } catch (err) {
        return { error: (err as Error).message };
      }
      try {
        const result = await op(deps.getService(), { companyId: runCtx.companyId, actor: actorFromRun(runCtx) }, params);
        return { content: result.summary, data: result.data };
      } catch (err) {
        const { message, code } = errorMessage(err, name);
        // Log the tool and the code only. Never the params: they may hold
        // the text that was refused.
        if (code === "EINTERNAL") deps.logger.error("deal-desk tool failed", { tool: name, code });
        return { error: message };
      }
    };
  }
  return handlers;
}

function firstQuery(input: PluginApiRequestInput, key: string): string | undefined {
  const v = input.query?.[key];
  return Array.isArray(v) ? v[0] : v;
}

/** Board API routes, so a page can be added later. Read-only in v1. */
export async function handleApiRequest(deps: HandlerDeps, input: PluginApiRequestInput): Promise<PluginApiResponse> {
  const config = await deps.getConfig();
  try {
    assertCompanyAccess(deps, {
      route: input.routeKey,
      allowedCompanies: config.allowedCompanies,
      companyId: input.companyId,
    });
  } catch (err) {
    return { status: 403, body: { error: (err as Error).message } };
  }

  const call: CallContext = {
    companyId: input.companyId,
    actor: { userId: input.actor?.actorType === "user" ? (input.actor.userId ?? null) : null },
  };

  try {
    const service = deps.getService();
    switch (input.routeKey) {
      case "deals.list": {
        const stage = firstQuery(input, "stage");
        const result = await service.listDeals(call, { stage: stage || undefined });
        return { status: 200, body: result.data };
      }
      case "deals.get": {
        const dealId = input.params?.dealId;
        if (!dealId) return { status: 400, body: { error: "[EINVALID_INPUT] Missing dealId" } };
        return { status: 200, body: await service.dealDetail(call, dealId) };
      }
      default:
        return { status: 404, body: { error: `Unknown plugin route: ${input.routeKey}` } };
    }
  } catch (err) {
    const { message, code } = errorMessage(err, input.routeKey);
    const status = code === "EDEAL_NOT_FOUND" ? 404 : code === "EINTERNAL" ? 500 : 400;
    if (code === "EINTERNAL") deps.logger.error("deal-desk route failed", { route: input.routeKey, code });
    return { status, body: { error: message } };
  }
}
