import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "google-analytics";
const PLUGIN_VERSION = "0.3.10";

const SETUP_INSTRUCTIONS = `# Setup — Google Analytics

Connect GA4 and/or Search Console so agents can pull reports and realtime data. Uses a GCP service account — no OAuth consent flow, no browser login. Reckon on **about 20 minutes** for first-time GCP setup; subsequent sites take ~5 minutes each.

---

## 1. Create a GCP project (skip if you have one)

- Go to [https://console.cloud.google.com](https://console.cloud.google.com) → New Project
- Name it "Paperclip Analytics" or similar

---

## 2. Enable the required APIs

In the GCP project → **APIs & Services → Library**, enable:

| API | Required for |
|---|---|
| Google Analytics Data API | \`ga_run_report\`, \`ga_realtime\` |
| Google Search Console API | \`gsc_search_analytics\` |

Enable only the APIs you need — both can share the same service account.

---

## 3. Create a service account

Go to **IAM & Admin → Service Accounts → Create Service Account**:

- **Name**: "Paperclip Analytics Reader"
- **Description**: (optional)
- Click **Create and Continue** → skip role assignment → **Done**

Click the new service account → **Keys → Add Key → Create new key → JSON**. A JSON file downloads to your computer. **Keep this file — it's your only copy.**

---

## 4. Grant the service account access to your GA4 property

In [Google Analytics](https://analytics.google.com):

- Go to **Admin → Property → Property Access Management**
- Click **+** → Add users
- Paste the service account email (from the JSON file's \`client_email\` field)
- Role: **Viewer** (read-only)
- Save

Repeat for each GA4 property you want to connect.

---

## 5. Grant the service account access to Search Console

In [Google Search Console](https://search.google.com/search-console):

- Go to **Settings → Users and permissions → Add user**
- Paste the service account email
- Permission: **Restricted** (read-only)
- Add user

Repeat for each GSC site.

---

## 6. Create a Paperclip secret with the service account JSON

The service account JSON contains credentials — treat it as a secret.

In Paperclip, switch to the company that should own this analytics connection:

- Go to **Secrets → Add**
- Name it (e.g. \`gcp-analytics-sa-json\`)
- Paste the **entire contents** of the downloaded JSON file as the value
- Save, then **copy the secret's UUID**

> One service account key can be reused across multiple GA4 properties and GSC sites if they all granted access to the same service account email.

---

## 7. Configure the plugin (this page, **Configuration** tab)

Click the **Configuration** tab above. Under **Sites**, click **+ Add item** and fill in:

| Field | Value |
|---|---|
| **Identifier** | e.g. \`acme-main\` |
| **Display name** | e.g. "Acme Corp Site" |
| **GA4 property ID** | e.g. \`properties/123456789\` — find it in GA4 → Admin → Property Settings |
| **Search Console site URL** | exact URL as in GSC, e.g. \`https://example.com/\` or \`sc-domain:example.com\` |
| **Service account JSON** | UUID of the secret from step 6 |
| **Allowed companies** | tick the companies whose agents may read this site's data |

---

## Troubleshooting

- **\`[EGAUTH]\` error** — the service account JSON is malformed or the secret UUID is wrong. Paste the full JSON from the downloaded file.
- **403 on GA4** — the service account email wasn't added to the GA4 property (step 4). Check IAM.
- **403 on Search Console** — the service account email wasn't added to the GSC site (step 5), OR the site URL in the plugin config doesn't exactly match the verified URL in Search Console (protocol, trailing slash matter).
- **No data returned** — GA4 properties can take 24–48 h to show data for a newly connected account. Try \`ga_realtime\` first since it shows live data immediately.
`;

const manifest: PaperclipPluginManifestV1 & { setupInstructions?: string } = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Google Analytics",
  setupInstructions: SETUP_INSTRUCTIONS,
  description:
    "Read GA4 reports, GA4 realtime data, and Search Console search analytics. Service-account JSON is stored encrypted; one secret can be shared across many sites.",
  author: "Barry Carr & Tony Allard",
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
    additionalProperties: false,
    properties: {
      sites: {
        type: "array",
        title: "Sites",
        description:
          "Each site exposes a GA4 property and/or a Search Console property. The serviceAccountJson secret can be reused across sites that share a service account. Every site must list the company UUIDs allowed to read it under 'Allowed companies' — empty list = unusable (fail-safe default deny).",
        items: {
          type: "object",
          required: ["key", "serviceAccountJson", "allowedCompanies"],
          properties: {
            name: {
              type: "string",
              title: "Display name",
              description:
                "Human-readable label shown in this settings form (e.g. 'Acme Corp site', 'Brand B site'). Free-form.",
            },
            key: {
              type: "string",
              title: "Identifier",
              description:
                "Short stable ID agents pass when querying this site (e.g. 'acme', 'kids-brand'). Lowercase, no spaces. Once skills reference it, don't change it — that's why it's separate from Display name. Must be unique.",
            },
            allowedCompanies: {
              type: "array",
              items: { type: "string", format: "company-id" },
              title: "Allowed companies",
              description:
                "Companies allowed to read this site's GA/GSC data. Tick 'Portfolio-wide' or specific companies. Empty = unusable.",
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
          siteKey: { type: "string", description: "Site identifier from list_sites." },
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
