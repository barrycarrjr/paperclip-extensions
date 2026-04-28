import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "google-analytics";
const PLUGIN_VERSION = "0.1.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Google Analytics",
  description:
    "Read GA4 reports, GA4 realtime data, and Search Console search analytics. Service-account JSON is stored encrypted; one secret can be shared across many sites.",
  author: "Barry Carr",
  categories: ["connector"],
  capabilities: [
    "agent.tools.register",
    "instance.settings.register",
    "secrets.read-ref",
    "http.outbound",
    "telemetry.track",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      sites: {
        type: "array",
        title: "Sites",
        description:
          "Each site exposes a GA4 property and/or a Search Console property. The serviceAccountJson secret can be reused across sites that share a service account.",
        items: {
          type: "object",
          required: ["key", "serviceAccountJson"],
          properties: {
            key: {
              type: "string",
              title: "Key",
              description:
                "Lowercase identifier agents reference (e.g. 'acme', 'kids-brand').",
            },
            description: {
              type: "string",
              title: "Description",
              description: "Free-form note describing the site (shown in list_sites).",
            },
            ga4PropertyId: {
              type: "string",
              title: "GA4 property ID",
              description:
                "Full property resource string, e.g. 'properties/123456789'. Find it in GA4 → Admin → Property Settings.",
            },
            gscSiteUrl: {
              type: "string",
              title: "Search Console site URL",
              description:
                "Exact URL as registered in Search Console, e.g. 'https://example.com/' or 'sc-domain:example.com'.",
            },
            serviceAccountJson: {
              type: "string",
              format: "secret-ref",
              title: "Service account JSON",
              description:
                "Secret holding the entire GCP service account JSON key. Must have analytics.readonly + webmasters.readonly scopes granted.",
            },
          },
        },
      },
    },
  },
  tools: [
    {
      name: "list_sites",
      displayName: "List configured sites",
      description:
        "Return the list of GA/GSC sites configured for this plugin (key, description, which IDs are wired). No secrets are returned.",
      parametersSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "ga_run_report",
      displayName: "Run GA4 report",
      description:
        "Run a GA4 report. Common metrics: activeUsers, sessions, screenPageViews, conversions, totalRevenue. Common dimensions: date, country, pagePath, sessionSource, deviceCategory. Date strings accept YYYY-MM-DD, 'today', 'yesterday', 'NdaysAgo'.",
      parametersSchema: {
        type: "object",
        properties: {
          siteKey: { type: "string", description: "Site key from list_sites." },
          startDate: { type: "string" },
          endDate: { type: "string" },
          metrics: {
            type: "array",
            items: { type: "string" },
            description: "GA4 metric names.",
          },
          dimensions: {
            type: "array",
            items: { type: "string" },
            description: "Optional GA4 dimension names.",
          },
          limit: { type: "number" },
          orderByMetric: { type: "string" },
        },
        required: ["siteKey", "startDate", "endDate", "metrics"],
      },
    },
    {
      name: "ga_realtime",
      displayName: "GA4 realtime",
      description:
        "Active users in the last 30 minutes for a GA4 property, broken down by the given dimension (default: country).",
      parametersSchema: {
        type: "object",
        properties: {
          siteKey: { type: "string" },
          dimension: { type: "string", description: "country, city, deviceCategory, etc." },
        },
        required: ["siteKey"],
      },
    },
    {
      name: "gsc_search_analytics",
      displayName: "Search Console search analytics",
      description:
        "Run a Search Console search analytics query for a verified site. Returns rows by date/query/page/country/device. Dates: YYYY-MM-DD.",
      parametersSchema: {
        type: "object",
        properties: {
          siteKey: { type: "string" },
          startDate: { type: "string" },
          endDate: { type: "string" },
          dimensions: {
            type: "array",
            items: { type: "string", enum: ["date", "query", "page", "country", "device"] },
          },
          rowLimit: { type: "number" },
        },
        required: ["siteKey", "startDate", "endDate"],
      },
    },
  ],
};

export default manifest;
