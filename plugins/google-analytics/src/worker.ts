import {
  definePlugin,
  runWorker,
  type PluginContext,
  type ToolResult,
} from "@paperclipai/plugin-sdk";
import { GoogleAuth, type AuthClient } from "google-auth-library";
import { google } from "googleapis";

interface SiteConfig {
  key?: string;
  description?: string;
  ga4PropertyId?: string;
  gscSiteUrl?: string;
  serviceAccountJson?: string;
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

interface AuthClientCache {
  secretRef: string;
  client: AuthClient;
}
const authCache = new Map<string, AuthClientCache>();

async function getAuthClient(ctx: PluginContext, secretRef: string): Promise<AuthClient> {
  const cached = authCache.get(secretRef);
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
  authCache.set(secretRef, { secretRef, client });
  return client;
}

function findSite(config: InstanceConfig, key: string): SiteConfig | undefined {
  const lower = key.toLowerCase();
  return (config.sites ?? []).find((s) => (s.key ?? "").toLowerCase() === lower);
}

function listSites(config: InstanceConfig): ToolResult {
  const sites = (config.sites ?? []).map((s) => ({
    key: s.key,
    description: s.description ?? null,
    ga4Wired: !!s.ga4PropertyId,
    gscWired: !!s.gscSiteUrl,
  }));
  return {
    content: `Configured sites: ${sites.map((s) => s.key).join(", ") || "(none)"}.`,
    data: { sites },
  };
}

async function gaRunReport(
  ctx: PluginContext,
  config: InstanceConfig,
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
  if (!site.ga4PropertyId) {
    return { error: `Site "${site.key}" has no ga4PropertyId.` };
  }
  if (!site.serviceAccountJson) {
    return { error: `Site "${site.key}" has no serviceAccountJson secret.` };
  }

  const authClient = await getAuthClient(ctx, site.serviceAccountJson);
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
    return { error: `GA4 runReport failed: ${(err as Error).message}` };
  }
}

async function gaRealtime(
  ctx: PluginContext,
  config: InstanceConfig,
  params: { siteKey?: string; dimension?: string },
): Promise<ToolResult> {
  if (!params.siteKey) return { error: "siteKey is required" };
  const site = findSite(config, params.siteKey);
  if (!site) return { error: `Site "${params.siteKey}" not configured.` };
  if (!site.ga4PropertyId) {
    return { error: `Site "${site.key}" has no ga4PropertyId.` };
  }
  if (!site.serviceAccountJson) {
    return { error: `Site "${site.key}" has no serviceAccountJson secret.` };
  }
  const dimension = params.dimension ?? "country";

  const authClient = await getAuthClient(ctx, site.serviceAccountJson);
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
    return { error: `GA4 runRealtimeReport failed: ${(err as Error).message}` };
  }
}

async function gscSearchAnalytics(
  ctx: PluginContext,
  config: InstanceConfig,
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
  if (!site.gscSiteUrl) {
    return { error: `Site "${site.key}" has no gscSiteUrl.` };
  }
  if (!site.serviceAccountJson) {
    return { error: `Site "${site.key}" has no serviceAccountJson secret.` };
  }

  const authClient = await getAuthClient(ctx, site.serviceAccountJson);
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
    return { error: `GSC searchanalytics.query failed: ${(err as Error).message}` };
  }
}

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    ctx.logger.info("google-analytics plugin setup");
    const config = (await ctx.config.get()) as InstanceConfig;
    const siteCount = (config.sites ?? []).length;
    ctx.logger.info(`google-analytics: ready. ${siteCount} site(s) configured.`);

    ctx.tools.register(
      "list_sites",
      {
        displayName: "List configured sites",
        description:
          "Return the list of GA/GSC sites configured for this plugin. No secret material is returned.",
        parametersSchema: { type: "object", properties: {} },
      },
      async (): Promise<ToolResult> => {
        const fresh = (await ctx.config.get()) as InstanceConfig;
        return listSites(fresh);
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
      async (params): Promise<ToolResult> => {
        const fresh = (await ctx.config.get()) as InstanceConfig;
        return gaRunReport(ctx, fresh, params as Parameters<typeof gaRunReport>[2]);
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
      async (params): Promise<ToolResult> => {
        const fresh = (await ctx.config.get()) as InstanceConfig;
        return gaRealtime(ctx, fresh, params as Parameters<typeof gaRealtime>[2]);
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
      async (params): Promise<ToolResult> => {
        const fresh = (await ctx.config.get()) as InstanceConfig;
        return gscSearchAnalytics(
          ctx,
          fresh,
          params as Parameters<typeof gscSearchAnalytics>[2],
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
