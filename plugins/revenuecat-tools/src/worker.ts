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
  getRcProject,
  rcRequest,
} from "./rcClient.js";
import { isCompanyAllowed } from "./companyAccess.js";

type ResolveResult =
  | { ok: true; resolved: ResolvedProject }
  | { ok: false; error: string };

async function resolveOrError(
  ctx: PluginContext,
  runCtx: ToolRunContext,
  toolName: string,
  projectKey: string | undefined,
): Promise<ResolveResult> {
  try {
    const resolved = await getRcProject(ctx, runCtx, toolName, projectKey);
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
    await ctx.telemetry.track(`revenuecat-tools.${tool}`, {
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
    ctx.logger.info("revenuecat-tools plugin setup");

    const rawConfig = (await ctx.config.get()) as InstanceConfig;
    const allowMutations = !!rawConfig.allowMutations;
    const projects: ConfigProject[] = rawConfig.projects ?? [];

    if (projects.length === 0) {
      ctx.logger.warn(
        "revenuecat-tools: no projects configured. Add them on /instance/settings/plugins/revenuecat-tools.",
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
          return `${k} [${access}]`;
        })
        .join(", ");
      ctx.logger.info(
        `revenuecat-tools: ready (mutations ${allowMutations ? "ENABLED" : "disabled"}). Projects — ${summary}`,
      );
    }

    function gateMutation(tool: string): { error: string } | null {
      if (allowMutations) return null;
      return {
        error: `[EDISABLED] ${tool} is disabled. Enable 'Allow set-attribute / delete-subscriber' on /instance/settings/plugins/revenuecat-tools.`,
      };
    }

    // ─── Reads ───────────────────────────────────────────────────────────

    ctx.tools.register(
      "revenuecat_get_subscriber",
      {
        displayName: "Get RevenueCat subscriber",
        description: "Retrieve a subscriber by app_user_id.",
        parametersSchema: {
          type: "object",
          properties: {
            project: { type: "string" },
            appUserId: { type: "string" },
          },
          required: ["appUserId"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as { project?: string; appUserId?: string };
        if (!p.appUserId) return { error: "[EINVALID_INPUT] `appUserId` is required" };

        const r = await resolveOrError(ctx, runCtx, "revenuecat_get_subscriber", p.project);
        if (!r.ok) return { error: r.error };
        try {
          const result = await rcRequest<Record<string, unknown>>(
            r.resolved,
            `/subscribers/${encodeURIComponent(p.appUserId)}`,
            { apiVersion: "v1" },
          );
          await track(ctx, runCtx, "revenuecat_get_subscriber", r.resolved.projectKey, {
            appUserId: p.appUserId,
          });
          return {
            content: `Retrieved subscriber ${p.appUserId} on ${r.resolved.projectKey}.`,
            data: result,
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    ctx.tools.register(
      "revenuecat_list_subscribers",
      {
        displayName: "List RevenueCat subscribers",
        description: "Paginated list of subscribers (v2 API).",
        parametersSchema: {
          type: "object",
          properties: {
            project: { type: "string" },
            limit: { type: "number" },
            startingAfter: { type: "string" },
            lastSeenAfter: { type: "string" },
          },
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as {
          project?: string;
          limit?: number;
          startingAfter?: string;
          lastSeenAfter?: string;
        };
        const r = await resolveOrError(ctx, runCtx, "revenuecat_list_subscribers", p.project);
        if (!r.ok) return { error: r.error };
        if (!r.resolved.project.projectId) {
          return {
            error:
              "[ECONFIG] revenuecat_list_subscribers requires `projectId` on the project config (v2 API).",
          };
        }

        try {
          const query: Record<string, string | number | undefined> = {
            limit: clampLimit(p.limit, 100, 1000),
          };
          if (p.startingAfter) query.starting_after = p.startingAfter;
          if (p.lastSeenAfter) query.last_seen_after = p.lastSeenAfter;

          const result = await rcRequest<{
            items?: unknown[];
            next_page?: string;
          }>(
            r.resolved,
            `/projects/${encodeURIComponent(r.resolved.project.projectId)}/customers`,
            { query, apiVersion: "v2" },
          );
          const subscribers = (result?.items ?? []) as Array<Record<string, unknown>>;
          await track(ctx, runCtx, "revenuecat_list_subscribers", r.resolved.projectKey, {
            count: subscribers.length,
          });
          return {
            content: `Listed ${subscribers.length} subscriber(s).`,
            data: {
              subscribers,
              hasMore: !!result?.next_page,
              nextCursor: result?.next_page ?? null,
            },
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    ctx.tools.register(
      "revenuecat_get_subscriber_attributes",
      {
        displayName: "Get RevenueCat subscriber attributes",
        description: "Return custom attributes + last-updated timestamps.",
        parametersSchema: {
          type: "object",
          properties: {
            project: { type: "string" },
            appUserId: { type: "string" },
          },
          required: ["appUserId"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as { project?: string; appUserId?: string };
        if (!p.appUserId) return { error: "[EINVALID_INPUT] `appUserId` is required" };

        const r = await resolveOrError(
          ctx,
          runCtx,
          "revenuecat_get_subscriber_attributes",
          p.project,
        );
        if (!r.ok) return { error: r.error };
        try {
          const sub = await rcRequest<{ subscriber?: { subscriber_attributes?: unknown } }>(
            r.resolved,
            `/subscribers/${encodeURIComponent(p.appUserId)}`,
            { apiVersion: "v1" },
          );
          const attrs = sub?.subscriber?.subscriber_attributes ?? {};
          await track(
            ctx,
            runCtx,
            "revenuecat_get_subscriber_attributes",
            r.resolved.projectKey,
            { appUserId: p.appUserId },
          );
          return {
            content: `Retrieved attributes for ${p.appUserId}.`,
            data: { attributes: attrs },
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    // ─── Mutations ───────────────────────────────────────────────────────

    ctx.tools.register(
      "revenuecat_set_subscriber_attribute",
      {
        displayName: "Set RevenueCat subscriber attributes",
        description: "Set custom attributes on a subscriber.",
        parametersSchema: {
          type: "object",
          properties: {
            project: { type: "string" },
            appUserId: { type: "string" },
            attributes: {
              type: "object",
              additionalProperties: { type: "string" },
            },
          },
          required: ["appUserId", "attributes"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const gate = gateMutation("revenuecat_set_subscriber_attribute");
        if (gate) return gate;

        const p = params as {
          project?: string;
          appUserId?: string;
          attributes?: Record<string, string>;
        };
        if (!p.appUserId) return { error: "[EINVALID_INPUT] `appUserId` is required" };
        if (!p.attributes || Object.keys(p.attributes).length === 0)
          return { error: "[EINVALID_INPUT] `attributes` must be non-empty" };

        const r = await resolveOrError(
          ctx,
          runCtx,
          "revenuecat_set_subscriber_attribute",
          p.project,
        );
        if (!r.ok) return { error: r.error };
        try {
          // RevenueCat v1 attributes endpoint expects { attributes: { key: { value } } }
          const formatted: Record<string, { value: string }> = {};
          for (const [k, v] of Object.entries(p.attributes)) {
            formatted[k] = { value: v };
          }
          await rcRequest(
            r.resolved,
            `/subscribers/${encodeURIComponent(p.appUserId)}/attributes`,
            {
              method: "POST",
              body: { attributes: formatted },
              apiVersion: "v1",
            },
          );
          await track(
            ctx,
            runCtx,
            "revenuecat_set_subscriber_attribute",
            r.resolved.projectKey,
            { appUserId: p.appUserId, count: Object.keys(p.attributes).length },
          );
          return {
            content: `Set ${Object.keys(p.attributes).length} attribute(s) on ${p.appUserId}.`,
            data: { ok: true, appUserId: p.appUserId, keys: Object.keys(p.attributes) },
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    ctx.tools.register(
      "revenuecat_delete_subscriber",
      {
        displayName: "Delete RevenueCat subscriber",
        description: "Permanently delete a subscriber. RARE — usually for tests.",
        parametersSchema: {
          type: "object",
          properties: {
            project: { type: "string" },
            appUserId: { type: "string" },
          },
          required: ["appUserId"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const gate = gateMutation("revenuecat_delete_subscriber");
        if (gate) return gate;

        const p = params as { project?: string; appUserId?: string };
        if (!p.appUserId) return { error: "[EINVALID_INPUT] `appUserId` is required" };

        const r = await resolveOrError(ctx, runCtx, "revenuecat_delete_subscriber", p.project);
        if (!r.ok) return { error: r.error };
        try {
          await rcRequest(
            r.resolved,
            `/subscribers/${encodeURIComponent(p.appUserId)}`,
            { method: "DELETE", apiVersion: "v1" },
          );
          await track(ctx, runCtx, "revenuecat_delete_subscriber", r.resolved.projectKey, {
            appUserId: p.appUserId,
          });
          return {
            content: `Deleted subscriber ${p.appUserId}.`,
            data: { ok: true, appUserId: p.appUserId },
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    // ─── Metrics snapshot (cached) ───────────────────────────────────────

    ctx.tools.register(
      "revenuecat_get_metrics_snapshot",
      {
        displayName: "Get RevenueCat metrics snapshot",
        description:
          "Approximate active / new / churn counts over a window. Cached 5 min. Derived from paginated v2 listings.",
        parametersSchema: {
          type: "object",
          properties: {
            project: { type: "string" },
            windowDays: { type: "number" },
          },
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as { project?: string; windowDays?: number };
        const r = await resolveOrError(
          ctx,
          runCtx,
          "revenuecat_get_metrics_snapshot",
          p.project,
        );
        if (!r.ok) return { error: r.error };
        if (!r.resolved.project.projectId) {
          return {
            error:
              "[ECONFIG] revenuecat_get_metrics_snapshot requires `projectId` on the project config (v2 API).",
          };
        }

        try {
          const windowDays = Math.max(1, Math.min(365, Math.floor(p.windowDays ?? 30)));
          const cacheKeyStr = `${windowDays}`;
          const now = Date.now();
          const cached = r.resolved.metricsCache.get(cacheKeyStr);
          if (cached && cached.expiresAt > now) {
            return {
              content: `Metrics snapshot (${windowDays}d, cached).`,
              data: cached.data,
            };
          }

          const sinceMs = now - windowDays * 24 * 3600 * 1000;
          let cursor: string | undefined;
          let activeSubsCount = 0;
          let newSubsInWindow = 0;
          let churnInWindow = 0;
          // Estimate MRR by summing $/month across active subs (approximate;
          // skips currency conversion).
          let mrrEstimate = 0;
          let pageBudget = 5; // pagination cap

          do {
            const list = await rcRequest<{
              items?: Array<{
                last_seen_at?: string;
                first_seen_at?: string;
                entitlements?: Record<string, { expires_at?: string | null; active?: boolean }>;
                subscriptions?: Record<
                  string,
                  {
                    expires_date?: string;
                    unsubscribe_detected_at?: string | null;
                    period_type?: string;
                    price_in_purchased_currency?: number;
                    purchased_at?: string;
                  }
                >;
              }>;
              next_page?: string;
            }>(
              r.resolved,
              `/projects/${encodeURIComponent(r.resolved.project.projectId)}/customers`,
              { query: { limit: 1000, starting_after: cursor }, apiVersion: "v2" },
            );

            for (const sub of list.items ?? []) {
              const subs = Object.values(sub.subscriptions ?? {});
              const hasActive = subs.some((s) => {
                if (!s.expires_date) return false;
                return new Date(s.expires_date).getTime() > now;
              });
              if (hasActive) {
                activeSubsCount += 1;
                for (const s of subs) {
                  if (
                    s.expires_date &&
                    new Date(s.expires_date).getTime() > now &&
                    typeof s.price_in_purchased_currency === "number"
                  ) {
                    // Approximate monthly value: assume monthly period for simplicity.
                    // A real implementation would normalize annual → /12 etc.
                    mrrEstimate += s.price_in_purchased_currency;
                  }
                }
              }
              if (sub.first_seen_at && new Date(sub.first_seen_at).getTime() >= sinceMs) {
                newSubsInWindow += 1;
              }
              for (const s of subs) {
                if (s.unsubscribe_detected_at) {
                  const t = new Date(s.unsubscribe_detected_at).getTime();
                  if (t >= sinceMs) churnInWindow += 1;
                }
              }
            }

            cursor = list.next_page || undefined;
            pageBudget -= 1;
          } while (cursor && pageBudget > 0);

          const churnRate =
            activeSubsCount + churnInWindow > 0
              ? churnInWindow / (activeSubsCount + churnInWindow)
              : 0;

          const snapshot = {
            project: r.resolved.projectKey,
            windowDays,
            activeSubsCount,
            mrrEstimate: Math.round(mrrEstimate * 100) / 100,
            newSubsInWindow,
            churnInWindow,
            churnRate: Math.round(churnRate * 10000) / 10000,
            paginationTruncated: !!cursor,
            generatedAt: new Date(now).toISOString(),
          };
          r.resolved.metricsCache.set(cacheKeyStr, {
            data: snapshot,
            expiresAt: now + METRICS_CACHE_TTL_MS,
          });

          await track(ctx, runCtx, "revenuecat_get_metrics_snapshot", r.resolved.projectKey, {
            windowDays,
          });
          return {
            content: `Metrics snapshot (${windowDays}d): ${activeSubsCount} active, ~$${snapshot.mrrEstimate} MRR estimate, ${newSubsInWindow} new in window, ${churnInWindow} churned.`,
            data: snapshot,
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );
  },

  async onHealth() {
    return { status: "ok", message: "revenuecat-tools ready" };
  },
});

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

export default plugin;
runWorker(plugin, import.meta.url);

void isCompanyAllowed;
