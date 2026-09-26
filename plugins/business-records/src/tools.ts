/**
 * Agent tool handlers and board API route handlers.
 *
 * Kept out of worker.ts so they can be tested with a fake context. Every
 * handler runs the company allow-list check FIRST and returns before any
 * database or issue call when the company is not allowed.
 */

import type { PluginApiRequestInput, PluginApiResponse, ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import { assertCompanyAccess } from "./companyAccess.js";
import type { Actor } from "./domain.js";
import type { CallContext, OpResult, RecordsService } from "./service.js";
import type { InstanceConfig } from "./sidebar-visibility.js";
import { RecordsError, looksLikeFullTaxId } from "./validate.js";

export interface HandlerDeps {
  getConfig: () => Promise<InstanceConfig>;
  logger: {
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
  };
  /** Built per call, because the database namespace is only known once the host has initialised the worker. */
  getService: () => RecordsService;
}

type ToolOp = (service: RecordsService, call: CallContext, params: unknown) => Promise<OpResult>;

/** Every agent tool and the service operation behind it. */
export const TOOL_OPS: Record<string, ToolOp> = {
  business_list: (s, c, p) => s.listBusinesses(c, p),
  business_get: (s, c, p) => s.getBusiness(c, p),
  business_upsert: (s, c, p) => s.upsertBusiness(c, p),
  business_set_status: (s, c, p) => s.setStatus(c, p),
  business_link_issue: (s, c, p) => s.linkIssue(c, p),
  business_history: (s, c, p) => s.history(c, p),
  business_add_document: (s, c, p) => s.addDocument(c, p),
  business_list_documents: (s, c, p) => s.listDocuments(c, p),
  business_filing_upsert: (s, c, p) => s.upsertFiling(c, p),
  business_filing_set_status: (s, c, p) => s.setFilingStatus(c, p),
  business_list_filings: (s, c, p) => s.listFilings(c, p),
};

/**
 * Turn any thrown error into the [ECODE] message shape. Unexpected errors are
 * reported without quoted values, so a database error that echoes input can
 * never carry a tax id back out.
 */
export function errorMessage(err: unknown, op: string): { message: string; code: string } {
  if (err instanceof RecordsError) return { message: err.message, code: err.code };
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
        // the text that was refused for looking like a tax id.
        if (code === "EINTERNAL") deps.logger.error("business-records tool failed", { tool: name, code });
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

/** Board API routes for the page. Read-only in v1. */
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
      case "businesses.list": {
        const result = await service.listBusinesses(call, {
          query: firstQuery(input, "q") || undefined,
          relationship: firstQuery(input, "relationship") || undefined,
        });
        return { status: 200, body: result.data };
      }
      case "businesses.get": {
        const businessId = input.params?.businessId;
        if (!businessId) return { status: 400, body: { error: "[EINVALID_INPUT] Missing businessId" } };
        return { status: 200, body: await service.businessDetail(call, businessId) };
      }
      case "overview":
        return { status: 200, body: await service.overview(call) };
      default:
        return { status: 404, body: { error: `Unknown plugin route: ${input.routeKey}` } };
    }
  } catch (err) {
    const { message, code } = errorMessage(err, input.routeKey);
    const status =
      code === "EBUSINESS_NOT_FOUND" ? 404 : code === "EINVALID_INPUT" ? 400 : code === "EINTERNAL" ? 500 : 400;
    if (code === "EINTERNAL") deps.logger.error("business-records route failed", { route: input.routeKey, code });
    return { status, body: { error: message } };
  }
}
