import {
  definePlugin,
  runWorker,
  type PluginContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { GoogleAuth, type AuthClient } from "google-auth-library";
import { google } from "googleapis";
import { assertCompanyAccess, isCompanyAllowed } from "./companyAccess.js";

interface SiteConfig {
  name?: string;
  key?: string;
  description?: string;
  ga4PropertyId?: string;
  gscSiteUrl?: string;
  serviceAccountJson?: string;
  allowedCompanies?: string[];
}

interface InstanceConfig {
  sites?: SiteConfig[];
}

const SCOPES = [
  "https://www.googleapis.com/auth/analytics.readonly",
  "https://www.googleapis.com/auth/webmasters.readonly",
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidDate(s: string): boolean {
  return DATE_RE.test(s) || s === "today" || s === "yesterday" || /^\d+daysAgo$/.test(s);
}

interface AuthCacheEntry {
  client: AuthClient;
}
// Cache key includes companyId so two companies that share a service-account
// secret each get their own auth client. Never share an authed client across
// company boundaries (per the company-isolation contract in the README).
const authCache = new Map<string, AuthCacheEntry>();

async function getAuthClient(
  ctx: PluginContext,
  secretRef: string,
  companyId: string,
): Promise<AuthClient> {
  const cacheKey = `${companyId}:${secretRef}`;
  const cached = authCache.get(cacheKey);
  if (cached) return cached.client;

  const json = await ctx.secrets.resolve(secretRef);
  let credentials: Record<string, unknown>;
  try {
    credentials = JSON.parse(json);
  } catch {
    throw new Error(
      `Service account secret is not valid JSON. Verify the secret value contains the full JSON key from GCP.`,
    );
  }

  const auth = new GoogleAuth({
    credentials: credentials as Parameters<typeof GoogleAuth.prototype.fromJSON>[0],
    scopes: SCOPES,
  });
  const client = await auth.getClient();
  authCache.set(cacheKey, { client });
  return client;
}

function findSite(config: InstanceConfig, key: string): SiteConfig | undefined {
  const lower = key.toLowerCase();
  return (config.sites ?? []).find((s) => (s.key ?? "").toLowerCase() === lower);
}

function listSitesForCompany(config: InstanceConfig, companyId: string): ToolResult {
  const visible = (config.sites ?? []).filter((s) =>
    isCompanyAllowed(s.allowedCompanies, companyId),
  );
  const sites = visible.map((s) => ({
    key: s.key,
    name: s.name ?? null,
    description: s.description ?? null,
    ga4Wired: !!s.ga4PropertyId,
    gscWired: !!s.gscSiteUrl,
  }));
  return {
    content: `${sites.length} site(s) available to this company: ${
      sites.map((s) => s.key).join(", ") || "(none)"
    }.`,
    data: { sites },
  };
}

async function gaRunReport(
  ctx: PluginContext,
  config: InstanceConfig,
  runCtx: ToolRunContext,
  params: {
    siteKey?: string;
    startDate?: string;
    endDate?: string;
    metrics?: string[];
    dimensions?: string[];
    limit?: number;
    orderByMetric?: string;
  },
): Promise<ToolResult> {
  if (!params.siteKey) return { error: "siteKey is required" };
  if (!params.startDate || !params.endDate) {
    return { error: "startDate and endDate are required" };
  }
  if (!Array.isArray(params.metrics) || params.metrics.length === 0) {
    return { error: "metrics must be a non-empty array" };
  }
  if (!isValidDate(params.startDate) || !isValidDate(params.endDate)) {
    return { error: "Dates must be YYYY-MM-DD, 'today', 'yesterday', or 'NdaysAgo'." };
  }

  const site = findSite(config, params.siteKey);
  if (!site) return { error: `Site "${params.siteKey}" not configured.` };

  try {
    assertCompanyAccess(ctx, {
      tool: "ga_run_report",
      resourceLabel: `google-analytics site "${params.siteKey}"`,
      resourceKey: params.siteKey,
      allowedCompanies: site.allowedCompanies,
      companyId: runCtx.companyId,
    });
  } catch (err) {
    return { error: (err as Error).message };
  }

  if (!site.ga4PropertyId) {
    return { error: `Site "${site.key}" has no ga4PropertyId.` };
  }
  if (!site.serviceAccountJson) {
    return { error: `Site "${site.key}" has no serviceAccountJson secret.` };
  }

  const authClient = await getAuthClient(ctx, site.serviceAccountJson, runCtx.companyId);
  const client = google.analyticsdata({
    version: "v1beta",
    auth: authClient as unknown as Parameters<typeof google.analyticsdata>[0]["auth"],
  });

  const requestBody: Record<string, unknown> = {
    dateRanges: [{ startDate: params.startDate, endDate: params.endDate }],
    metrics: params.metrics.map((name) => ({ name })),
    dimensions: (params.dimensions ?? []).map((name) => ({ name })),
    limit: String(params.limit ?? 100),
  };
  if (params.orderByMetric) {
    requestBody.orderBys = [
      { desc: true, metric: { metricName: params.orderByMetric } },
    ];
  }

  try {
    const res = await client.properties.runReport({
      property: site.ga4PropertyId,
      requestBody,
    });
    const dimHeaders = res.data.dimensionHeaders?.map((h) => h.name ?? "") ?? [];
    const metHeaders = res.data.metricHeaders?.map((h) => h.name ?? "") ?? [];
    const rows = (res.data.rows ?? []).map((r) => {
      const out: Record<string, string> = {};
      r.dimensionValues?.forEach((v, i) => {
        out[dimHeaders[i] ?? `dim_${i}`] = v.value ?? "";
      });
      r.metricValues?.forEach((v, i) => {
        out[metHeaders[i] ?? `met_${i}`] = v.value ?? "";
      });
      return out;
    });
    await ctx.telemetry.track("google-analytics.ga_run_report", {
      site: site.key ?? "",
      companyId: runCtx.companyId,
    });
    return {
      content: `GA4 ${site.key}: ${rows.length} rows.`,
      data: {
        site: site.key,
        property: site.ga4PropertyId,
        rowCount: res.data.rowCount ?? rows.length,
        dimensions: dimHeaders,
        metrics: metHeaders,
        rows,
      },
    };
  } catch (err) {
    return { error: `[EGA_RUN_REPORT] ${(err as Error).message}` };
  }
}

async function gaRealtime(
  ctx: PluginContext,
  config: InstanceConfig,
  runCtx: ToolRunContext,
  params: { siteKey?: string; dimension?: string },
): Promise<ToolResult> {
  if (!params.siteKey) return { error: "siteKey is required" };
  const site = findSite(config, params.siteKey);
  if (!site) return { error: `Site "${params.siteKey}" not configured.` };

  try {
    assertCompanyAccess(ctx, {
      tool: "ga_realtime",
      resourceLabel: `google-analytics site "${params.siteKey}"`,
      resourceKey: params.siteKey,
      allowedCompanies: site.allowedCompanies,
      companyId: runCtx.companyId,
    });
  } catch (err) {
    return { error: (err as Error).message };
  }

  if (!site.ga4PropertyId) {
    return { error: `Site "${site.key}" has no ga4PropertyId.` };
  }
  if (!site.serviceAccountJson) {
    return { error: `Site "${site.key}" has no serviceAccountJson secret.` };
  }
  const dimension = params.dimension ?? "country";

  const authClient = await getAuthClient(ctx, site.serviceAccountJson, runCtx.companyId);
  const client = google.analyticsdata({
    version: "v1beta",
    auth: authClient as unknown as Parameters<typeof google.analyticsdata>[0]["auth"],
  });

  try {
    const res = await client.properties.runRealtimeReport({
      property: site.ga4PropertyId,
      requestBody: {
        dimensions: [{ name: dimension }],
        metrics: [{ name: "activeUsers" }],
      },
    });
    const rows = (res.data.rows ?? []).map((r) => ({
      [dimension]: r.dimensionValues?.[0]?.value ?? "",
      activeUsers: r.metricValues?.[0]?.value ?? "0",
    }));
    const total = rows.reduce((acc, r) => acc + Number(r.activeUsers || 0), 0);
    await ctx.telemetry.track("google-analytics.ga_realtime", {
      site: site.key ?? "",
      companyId: runCtx.companyId,
    });
    return {
      content: `GA4 realtime ${site.key}: ${total} active users.`,
      data: {
        site: site.key,
        property: site.ga4PropertyId,
        totalActiveUsers: total,
        rows,
      },
    };
  } catch (err) {
    return { error: `[EGA_REALTIME] ${(err as Error).message}` };
  }
}

async function gscSearchAnalytics(
  ctx: PluginContext,
  config: InstanceConfig,
  runCtx: ToolRunContext,
  params: {
    siteKey?: string;
    startDate?: string;
    endDate?: string;
    dimensions?: string[];
    rowLimit?: number;
  },
): Promise<ToolResult> {
  if (!params.siteKey) return { error: "siteKey is required" };
  if (!params.startDate || !params.endDate) {
    return { error: "startDate and endDate are required" };
  }
  if (!DATE_RE.test(params.startDate) || !DATE_RE.test(params.endDate)) {
    return { error: "GSC dates must be YYYY-MM-DD." };
  }

  const site = findSite(config, params.siteKey);
  if (!site) return { error: `Site "${params.siteKey}" not configured.` };

  try {
    assertCompanyAccess(ctx, {
      tool: "gsc_search_analytics",
      resourceLabel: `google-analytics site "${params.siteKey}"`,
      resourceKey: params.siteKey,
      allowedCompanies: site.allowedCompanies,
      companyId: runCtx.companyId,
    });
  } catch (err) {
    return { error: (err as Error).message };
  }

  if (!site.gscSiteUrl) {
    return { error: `Site "${site.key}" has no gscSiteUrl.` };
  }
  if (!site.serviceAccountJson) {
    return { error: `Site "${site.key}" has no serviceAccountJson secret.` };
  }

  const authClient = await getAuthClient(ctx, site.serviceAccountJson, runCtx.companyId);
  const client = google.searchconsole({
    version: "v1",
    auth: authClient as unknown as Parameters<typeof google.searchconsole>[0]["auth"],
  });

  try {
    const res = await client.searchanalytics.query({
      siteUrl: site.gscSiteUrl,
      requestBody: {
        startDate: params.startDate,
        endDate: params.endDate,
        dimensions: params.dimensions ?? ["date"],
        rowLimit: params.rowLimit ?? 100,
      },
    });
    const rows = res.data.rows ?? [];
    await ctx.telemetry.track("google-analytics.gsc_search_analytics", {
      site: site.key ?? "",
      companyId: runCtx.companyId,
    });
    return {
      content: `GSC ${site.key}: ${rows.length} rows.`,
      data: {
        site: site.key,
        siteUrl: site.gscSiteUrl,
        rowCount: rows.length,
        rows,
      },
    };
  } catch (err) {
    return { error: `[EGSC_QUERY] ${(err as Error).message}` };
  }
}

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    ctx.logger.info("google-analytics plugin setup");
    const config = (await ctx.config.get()) as InstanceConfig;
    const sites = config.sites ?? [];
    const orphans = sites.filter(
      (s) => !s.allowedCompanies || s.allowedCompanies.length === 0,
    );
    ctx.logger.info(`google-analytics: ready. ${sites.length} site(s) configured.`);
    if (orphans.length > 0) {
      ctx.logger.warn(
        `google-analytics: ${orphans.length} site(s) have no allowedCompanies and will reject every call. ` +
          `Backfill on the plugin settings page: ${orphans
            .map((s) => s.key ?? "(no-key)")
            .join(", ")}`,
      );
    }

    ctx.tools.register(
      "list_sites",
      {
        displayName: "List configured sites",
        description:
          "Return the GA/GSC sites the calling company is allowed to use. Sites scoped to other companies are filtered out (resource discovery is scoped to prevent leaking the existence of resources the agent cannot use). No secret material is returned.",
        parametersSchema: { type: "object", properties: {} },
      },
      async (_params, runCtx: ToolRunContext): Promise<ToolResult> => {
        const fresh = (await ctx.config.get()) as InstanceConfig;
        return listSitesForCompany(fresh, runCtx.companyId);
      },
    );

    ctx.tools.register(
      "ga_run_report",
      {
        displayName: "Run GA4 report",
        description:
          "Run a GA4 runReport. Returns rows shaped as objects keyed by dimension/metric name.",
        parametersSchema: {
          type: "object",
          properties: {
            siteKey: { type: "string" },
            startDate: { type: "string" },
            endDate: { type: "string" },
            metrics: { type: "array", items: { type: "string" } },
            dimensions: { type: "array", items: { type: "string" } },
            limit: { type: "number" },
            orderByMetric: { type: "string" },
          },
          required: ["siteKey", "startDate", "endDate", "metrics"],
        },
      },
      async (params, runCtx: ToolRunContext): Promise<ToolResult> => {
        const fresh = (await ctx.config.get()) as InstanceConfig;
        return gaRunReport(ctx, fresh, runCtx, params as Parameters<typeof gaRunReport>[3]);
      },
    );

    ctx.tools.register(
      "ga_realtime",
      {
        displayName: "GA4 realtime",
        description: "Active users in the last 30 minutes, by dimension.",
        parametersSchema: {
          type: "object",
          properties: {
            siteKey: { type: "string" },
            dimension: { type: "string" },
          },
          required: ["siteKey"],
        },
      },
      async (params, runCtx: ToolRunContext): Promise<ToolResult> => {
        const fresh = (await ctx.config.get()) as InstanceConfig;
        return gaRealtime(ctx, fresh, runCtx, params as Parameters<typeof gaRealtime>[3]);
      },
    );

    ctx.tools.register(
      "gsc_search_analytics",
      {
        displayName: "Search Console search analytics",
        description:
          "Run a Google Search Console search analytics query for a verified site.",
        parametersSchema: {
          type: "object",
          properties: {
            siteKey: { type: "string" },
            startDate: { type: "string" },
            endDate: { type: "string" },
            dimensions: { type: "array", items: { type: "string" } },
            rowLimit: { type: "number" },
          },
          required: ["siteKey", "startDate", "endDate"],
        },
      },
      async (params, runCtx: ToolRunContext): Promise<ToolResult> => {
        const fresh = (await ctx.config.get()) as InstanceConfig;
        return gscSearchAnalytics(
          ctx,
          fresh,
          runCtx,
          params as Parameters<typeof gscSearchAnalytics>[3],
        );
      },
    );
  },

  async onHealth() {
    return { status: "ok", message: "google-analytics ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
