import {
  definePlugin,
  runWorker,
  type PluginContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import {
  type ConfigProject,
  type InstanceConfig,
  type ResolvedProject,
  getRollbarProject,
  rollbarRequest,
} from "./rollbarClient.js";
import { isCompanyAllowed } from "./companyAccess.js";

type ResolveResult =
  | { ok: true; resolved: ResolvedProject }
  | { ok: false; error: string };

async function resolveOrError(
  ctx: PluginContext,
  runCtx: ToolRunContext,
  toolName: string,
  projectKey: string | undefined,
  needWrite = false,
): Promise<ResolveResult> {
  try {
    const resolved = await getRollbarProject(ctx, runCtx, toolName, projectKey, needWrite);
    return { ok: true, resolved };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function track(
  ctx: PluginContext,
  runCtx: ToolRunContext,
  tool: string,
  projectKey: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  try {
    await ctx.telemetry.track(`rollbar-tools.${tool}`, {
      project: projectKey,
      companyId: runCtx.companyId,
      runId: runCtx.runId,
      ...extra,
    });
  } catch {
    // no-op
  }
}

const METRICS_CACHE_TTL_MS = 5 * 60 * 1000;

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    ctx.logger.info("rollbar-tools plugin setup");

    const rawConfig = (await ctx.config.get()) as InstanceConfig;
    const allowMutations = !!rawConfig.allowMutations;
    const projects: ConfigProject[] = rawConfig.projects ?? [];

    if (projects.length === 0) {
      ctx.logger.warn(
        "rollbar-tools: no projects configured. Add them on /instance/settings/plugins/rollbar-tools.",
      );
    } else {
      const summary = projects
        .map((p) => {
          const k = p.key ?? "(no-key)";
          const allowed = p.allowedCompanies;
          const access =
            !allowed || allowed.length === 0
              ? "no companies — UNUSABLE"
              : allowed.includes("*")
                ? "portfolio-wide"
                : `${allowed.length} company(s)`;
          const w = p.writeTokenRef ? "+write" : "";
          return `${k} [read${w}, ${access}]`;
        })
        .join(", ");
      ctx.logger.info(
        `rollbar-tools: ready (mutations ${allowMutations ? "ENABLED" : "disabled"}). Projects — ${summary}`,
      );

      const orphans = projects.filter(
        (p) => !p.allowedCompanies || p.allowedCompanies.length === 0,
      );
      if (orphans.length > 0) {
        ctx.logger.warn(
          `rollbar-tools: ${orphans.length} project(s) have no allowedCompanies and will reject every call.`,
        );
      }
    }

    function gateMutation(tool: string): { error: string } | null {
      if (allowMutations) return null;
      return {
        error: `[EDISABLED] ${tool} is disabled. Enable 'Allow resolve / mute' on /instance/settings/plugins/rollbar-tools (and add a writeTokenRef on the project).`,
      };
    }

    // ─── Read tools ──────────────────────────────────────────────────────

    ctx.tools.register(
      "rollbar_list_items",
      {
        displayName: "List Rollbar items",
        description: "List error items.",
        parametersSchema: {
          type: "object",
          properties: {
            project: { type: "string" },
            status: { type: "string" },
            level: { type: "string" },
            environment: { type: "string" },
            framework: { type: "string" },
            assignedUserId: { type: "number" },
            query: { type: "string" },
            page: { type: "number" },
            perPage: { type: "number" },
          },
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as {
          project?: string;
          status?: string;
          level?: string;
          environment?: string;
          framework?: string;
          assignedUserId?: number;
          query?: string;
          page?: number;
          perPage?: number;
        };
        const r = await resolveOrError(ctx, runCtx, "rollbar_list_items", p.project);
        if (!r.ok) return { error: r.error };

        try {
          const env = p.environment ?? r.resolved.project.environment;
          const query: Record<string, string | number | undefined> = {
            page: p.page ?? 1,
            limit: clampLimit(p.perPage, 25, 100),
          };
          if (p.status) query.status = p.status;
          if (p.level) query.level = p.level;
          if (env) query.environment = env;
          if (p.framework) query.framework = p.framework;
          if (p.assignedUserId !== undefined) query.assigned_user_id = p.assignedUserId;
          if (p.query) query.query = p.query;

          const result = await rollbarRequest<{
            items?: unknown[];
            total_count?: number;
            page?: number;
          }>(r.resolved, "/items/", { query });

          const items = (result?.items ?? []) as Array<Record<string, unknown>>;
          await track(ctx, runCtx, "rollbar_list_items", r.resolved.projectKey, {
            count: items.length,
            page: query.page,
          });
          return {
            content: `Listed ${items.length} item(s) on ${r.resolved.projectKey}.`,
            data: {
              items: items.map(slimItem),
              totalCount: result?.total_count ?? items.length,
              page: result?.page ?? query.page,
            },
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    ctx.tools.register(
      "rollbar_get_item",
      {
        displayName: "Get Rollbar item",
        description: "Retrieve a single item by ID or counter.",
        parametersSchema: {
          type: "object",
          properties: {
            project: { type: "string" },
            itemId: { type: "number" },
            counter: { type: "number" },
          },
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as { project?: string; itemId?: number; counter?: number };
        if (p.itemId === undefined && p.counter === undefined) {
          return { error: "[EINVALID_INPUT] Provide `itemId` or `counter`." };
        }
        if (p.itemId !== undefined && p.counter !== undefined) {
          return { error: "[EINVALID_INPUT] Provide only one of `itemId` or `counter`." };
        }

        const r = await resolveOrError(ctx, runCtx, "rollbar_get_item", p.project);
        if (!r.ok) return { error: r.error };

        try {
          const path =
            p.counter !== undefined
              ? `/item_by_counter/${p.counter}`
              : `/item/${p.itemId}/`;
          const result = await rollbarRequest<Record<string, unknown>>(r.resolved, path);
          await track(ctx, runCtx, "rollbar_get_item", r.resolved.projectKey, {
            itemId: p.itemId ?? null,
            counter: p.counter ?? null,
          });
          return {
            content: `Retrieved item${p.counter !== undefined ? ` #${p.counter}` : ` ${p.itemId}`} on ${r.resolved.projectKey}.`,
            data: result,
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    ctx.tools.register(
      "rollbar_list_occurrences",
      {
        displayName: "List Rollbar occurrences for an item",
        description: "Occurrences belonging to one item.",
        parametersSchema: {
          type: "object",
          properties: {
            project: { type: "string" },
            itemId: { type: "number" },
            page: { type: "number" },
            perPage: { type: "number" },
          },
          required: ["itemId"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as {
          project?: string;
          itemId?: number;
          page?: number;
          perPage?: number;
        };
        if (p.itemId === undefined) return { error: "[EINVALID_INPUT] `itemId` is required" };

        const r = await resolveOrError(ctx, runCtx, "rollbar_list_occurrences", p.project);
        if (!r.ok) return { error: r.error };

        try {
          const result = await rollbarRequest<{
            instances?: unknown[];
            total_count?: number;
          }>(r.resolved, `/item/${p.itemId}/instances/`, {
            query: { page: p.page ?? 1, limit: clampLimit(p.perPage, 25, 100) },
          });
          const occurrences = (result?.instances ?? []) as Array<Record<string, unknown>>;
          await track(ctx, runCtx, "rollbar_list_occurrences", r.resolved.projectKey, {
            itemId: p.itemId,
            count: occurrences.length,
          });
          return {
            content: `Listed ${occurrences.length} occurrence(s) for item ${p.itemId}.`,
            data: { occurrences, totalCount: result?.total_count ?? occurrences.length },
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    ctx.tools.register(
      "rollbar_get_occurrence",
      {
        displayName: "Get Rollbar occurrence",
        description: "Retrieve one occurrence with stack/request/person.",
        parametersSchema: {
          type: "object",
          properties: {
            project: { type: "string" },
            occurrenceId: { type: "number" },
          },
          required: ["occurrenceId"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as { project?: string; occurrenceId?: number };
        if (p.occurrenceId === undefined)
          return { error: "[EINVALID_INPUT] `occurrenceId` is required" };

        const r = await resolveOrError(ctx, runCtx, "rollbar_get_occurrence", p.project);
        if (!r.ok) return { error: r.error };

        try {
          const result = await rollbarRequest<Record<string, unknown>>(
            r.resolved,
            `/instance/${p.occurrenceId}/`,
          );
          await track(ctx, runCtx, "rollbar_get_occurrence", r.resolved.projectKey, {
            occurrenceId: p.occurrenceId,
          });
          return {
            content: `Retrieved occurrence ${p.occurrenceId}.`,
            data: result,
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    ctx.tools.register(
      "rollbar_get_top_items",
      {
        displayName: "Get top Rollbar items",
        description: "Active items ranked by total occurrences.",
        parametersSchema: {
          type: "object",
          properties: {
            project: { type: "string" },
            since: { type: "string" },
            limit: { type: "number" },
            levels: { type: "array", items: { type: "string" } },
          },
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as {
          project?: string;
          since?: string;
          limit?: number;
          levels?: string[];
        };
        const r = await resolveOrError(ctx, runCtx, "rollbar_get_top_items", p.project);
        if (!r.ok) return { error: r.error };

        try {
          const env = r.resolved.project.environment;
          const limit = clampLimit(p.limit, 10, 100);
          const sinceTs = p.since ? Math.floor(new Date(p.since).getTime() / 1000) : null;

          // Pull a generous sample, filter, sort
          const list = await rollbarRequest<{ items?: unknown[] }>(r.resolved, "/items/", {
            query: {
              status: "active",
              limit: 100,
              environment: env,
              page: 1,
            },
          });
          let items = (list?.items ?? []) as Array<{
            id?: number;
            counter?: number;
            title?: string;
            level?: string;
            total_occurrences?: number;
            last_occurrence_timestamp?: number;
            environment?: string;
          }>;

          if (p.levels && p.levels.length > 0) {
            const set = new Set(p.levels);
            items = items.filter((i) => set.has(i.level ?? ""));
          }
          if (sinceTs !== null) {
            items = items.filter((i) => (i.last_occurrence_timestamp ?? 0) >= sinceTs);
          }
          items.sort(
            (a, b) => (b.total_occurrences ?? 0) - (a.total_occurrences ?? 0),
          );
          const top = items.slice(0, limit);

          await track(ctx, runCtx, "rollbar_get_top_items", r.resolved.projectKey, {
            count: top.length,
          });
          return {
            content: `Top ${top.length} active item(s) on ${r.resolved.projectKey}.`,
            data: { items: top.map(slimItem) },
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    // ─── Mutations ───────────────────────────────────────────────────────

    ctx.tools.register(
      "rollbar_resolve_item",
      {
        displayName: "Resolve Rollbar item",
        description: "Mark an item as resolved.",
        parametersSchema: {
          type: "object",
          properties: {
            project: { type: "string" },
            itemId: { type: "number" },
            comment: { type: "string" },
          },
          required: ["itemId"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const gate = gateMutation("rollbar_resolve_item");
        if (gate) return gate;

        const p = params as { project?: string; itemId?: number; comment?: string };
        if (p.itemId === undefined) return { error: "[EINVALID_INPUT] `itemId` is required" };

        const r = await resolveOrError(ctx, runCtx, "rollbar_resolve_item", p.project, true);
        if (!r.ok) return { error: r.error };

        try {
          await rollbarRequest(r.resolved, `/item/${p.itemId}/`, {
            method: "PATCH",
            useWriteToken: true,
            body: { status: "resolved", resolved_in_version: p.comment ?? undefined },
          });
          await track(ctx, runCtx, "rollbar_resolve_item", r.resolved.projectKey, {
            itemId: p.itemId,
          });
          return {
            content: `Resolved item ${p.itemId} on ${r.resolved.projectKey}.`,
            data: { id: p.itemId, status: "resolved" },
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    ctx.tools.register(
      "rollbar_mute_item",
      {
        displayName: "Mute Rollbar item",
        description: "Mute an item until a date or indefinitely.",
        parametersSchema: {
          type: "object",
          properties: {
            project: { type: "string" },
            itemId: { type: "number" },
            until: { type: "string" },
          },
          required: ["itemId"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const gate = gateMutation("rollbar_mute_item");
        if (gate) return gate;

        const p = params as { project?: string; itemId?: number; until?: string };
        if (p.itemId === undefined) return { error: "[EINVALID_INPUT] `itemId` is required" };

        const r = await resolveOrError(ctx, runCtx, "rollbar_mute_item", p.project, true);
        if (!r.ok) return { error: r.error };

        try {
          const body: Record<string, unknown> = { status: "muted" };
          if (p.until) {
            const ts = Math.floor(new Date(p.until).getTime() / 1000);
            if (Number.isNaN(ts)) {
              return { error: "[EINVALID_INPUT] `until` is not a valid ISO 8601 date" };
            }
            body.snooze = ts;
          }
          await rollbarRequest(r.resolved, `/item/${p.itemId}/`, {
            method: "PATCH",
            useWriteToken: true,
            body,
          });
          await track(ctx, runCtx, "rollbar_mute_item", r.resolved.projectKey, {
            itemId: p.itemId,
            until: p.until ?? null,
          });
          return {
            content: `Muted item ${p.itemId}${p.until ? ` until ${p.until}` : " indefinitely"}.`,
            data: { id: p.itemId, status: "muted", until: p.until ?? null },
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    // ─── Metrics snapshot (cached) ───────────────────────────────────────

    ctx.tools.register(
      "rollbar_get_metrics_snapshot",
      {
        displayName: "Get Rollbar metrics snapshot",
        description:
          "Aggregate counts over a window: active items, new items, occurrences, critical items.",
        parametersSchema: {
          type: "object",
          properties: {
            project: { type: "string" },
            environment: { type: "string" },
            windowHours: { type: "number" },
          },
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as {
          project?: string;
          environment?: string;
          windowHours?: number;
        };
        const r = await resolveOrError(ctx, runCtx, "rollbar_get_metrics_snapshot", p.project);
        if (!r.ok) return { error: r.error };

        try {
          const windowHours = Math.max(1, Math.min(168, Math.floor(p.windowHours ?? 24)));
          const env = p.environment ?? r.resolved.project.environment ?? "all";
          const cacheKeyStr = `${env}::${windowHours}`;
          const now = Date.now();
          const cached = r.resolved.metricsCache.get(cacheKeyStr);
          if (cached && cached.expiresAt > now) {
            return {
              content: `Metrics snapshot (${windowHours}h, ${env}, cached).`,
              data: cached.data,
            };
          }

          const sinceTs = Math.floor((now - windowHours * 3600 * 1000) / 1000);
          // Pull active items (paginate up to 5 pages = 500 items max for cost ceiling)
          let allItems: Array<{
            level?: string;
            total_occurrences?: number;
            last_occurrence_timestamp?: number;
            first_occurrence_timestamp?: number;
            environment?: string;
          }> = [];
          for (let page = 1; page <= 5; page++) {
            const list = await rollbarRequest<{ items?: unknown[] }>(r.resolved, "/items/", {
              query: {
                status: "active",
                limit: 100,
                environment: p.environment ?? r.resolved.project.environment,
                page,
              },
            });
            const items = (list?.items ?? []) as typeof allItems;
            allItems = allItems.concat(items);
            if (items.length < 100) break;
          }

          const activeItemCount = allItems.length;
          const newItemsInWindow = allItems.filter(
            (i) => (i.first_occurrence_timestamp ?? 0) >= sinceTs,
          ).length;
          const occurrencesInWindow = allItems
            .filter((i) => (i.last_occurrence_timestamp ?? 0) >= sinceTs)
            .reduce((sum, i) => sum + (i.total_occurrences ?? 0), 0);
          const criticalItemCount = allItems.filter((i) => i.level === "critical").length;

          const snapshot = {
            project: r.resolved.projectKey,
            environment: env,
            windowHours,
            activeItemCount,
            newItemsInWindow,
            occurrencesInWindow,
            criticalItemCount,
            generatedAt: new Date(now).toISOString(),
          };
          r.resolved.metricsCache.set(cacheKeyStr, {
            data: snapshot,
            expiresAt: now + METRICS_CACHE_TTL_MS,
          });

          await track(ctx, runCtx, "rollbar_get_metrics_snapshot", r.resolved.projectKey, {
            windowHours,
            env,
          });
          return {
            content: `Metrics snapshot (${windowHours}h, ${env}): ${activeItemCount} active, ${criticalItemCount} critical, ${newItemsInWindow} new in window.`,
            data: snapshot,
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );
  },

  async onHealth() {
    return { status: "ok", message: "rollbar-tools ready" };
  },
});

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

interface SlimItem {
  id: number | null;
  counter: number | null;
  title: string | null;
  level: string | null;
  status: string | null;
  totalOccurrences: number | null;
  lastOccurrenceAt: string | null;
  firstOccurrenceAt: string | null;
  environment: string | null;
  framework: string | null;
}

function slimItem(i: Record<string, unknown>): SlimItem {
  const lastTs = (i.last_occurrence_timestamp as number | undefined) ?? null;
  const firstTs = (i.first_occurrence_timestamp as number | undefined) ?? null;
  return {
    id: typeof i.id === "number" ? i.id : null,
    counter: typeof i.counter === "number" ? i.counter : null,
    title: (i.title as string) ?? null,
    level: (i.level as string) ?? null,
    status: (i.status as string) ?? null,
    totalOccurrences: typeof i.total_occurrences === "number" ? i.total_occurrences : null,
    lastOccurrenceAt: lastTs ? new Date(lastTs * 1000).toISOString() : null,
    firstOccurrenceAt: firstTs ? new Date(firstTs * 1000).toISOString() : null,
    environment: (i.environment as string) ?? null,
    framework: (i.framework as string) ?? null,
  };
}

export default plugin;
runWorker(plugin, import.meta.url);

void isCompanyAllowed;
