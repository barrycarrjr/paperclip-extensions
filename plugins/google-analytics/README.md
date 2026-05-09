# Google Analytics (paperclip plugin)

Read GA4 reports, GA4 realtime data, and Search Console search analytics.
Service-account auth via the encrypted secrets store; one secret can be
shared across many sites.

## Recent changes

- **v0.3.1** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.0** — `setupInstructions` rendered as a Setup tab on the plugin's
  settings page (canonical install walkthrough); `name` field on each site
  is now optional.
- **v0.2.0** — per-site `allowedCompanies` isolation. Agents calling from
  a company not on the list get back `[ECOMPANY_NOT_ALLOWED]`.
  `list_sites` only returns sites the calling company is allowed to read.
  Auth client cache keyed by `(companyId, secretRef)` — two companies that
  share a service-account secret each get their own auth client.

## Install

```bash
cd %USERPROFILE%\paperclip-extensions\plugins\google-analytics
pnpm install
pnpm build

# Then from your paperclip checkout:
cd %USERPROFILE%\paperclip
pnpm --filter paperclipai exec tsx src/index.ts plugin install --local %USERPROFILE%\paperclip-extensions\plugins\google-analytics
```

## Configure

### 1. Create a GCP service account

1. https://console.cloud.google.com/iam-admin/serviceaccounts → pick your
   project (create one if needed) → **Create service account**.
2. Grant it no project roles. The access happens at the GA / GSC layer,
   not via project IAM.
3. Once created → **Keys** → **Add key** → **JSON**. Download the file.
   This file is the entire credentials blob you'll paste into a paperclip
   secret next.
4. Copy the service account's email — you'll need it twice in step 2.

### 2. Grant the service account access to GA + GSC

For **GA4**: open https://analytics.google.com → Admin → Property Access
Management → **+ Add user** → paste the service account email → role
**Viewer**.

For **Search Console**: open https://search.google.com/search-console →
Settings → Users and permissions → **Add user** → paste the service
account email → permission **Restricted** (read-only is fine).

### 3. Store the JSON key as a paperclip secret

1. Open `<COMPANY-PREFIX>/company/settings/secrets`.
2. **+ Create secret**. Name e.g. `GA_SERVICE_ACCOUNT_JSON`.
3. Provider: `Local encrypted`.
4. Value: paste the **entire JSON contents** of the key file from step 1.
5. Save. Copy the secret's UUID.

### 4. Add a site row in plugin settings

Open `/instance/settings/plugins/google-analytics`. Click **+ Add item**.

| Field | Notes |
|---|---|
| Display name | Free-form label (e.g. "Acme Corp site") shown on this settings page |
| Identifier | Short stable ID (e.g. `acme`) agents pass as `siteKey`. Lowercase, no spaces. **Don't change after skills reference it.** |
| Allowed companies | Company UUID list. `["*"]` = portfolio-wide. Empty = unusable. |
| Description | Free-form note shown in `list_sites` |
| GA4 property ID | `properties/123456789` (find in GA4 → Admin → Property Settings) |
| Search Console site URL | Exact URL as registered in GSC, e.g. `https://example.com/` or `sc-domain:example.com` |
| Service account JSON | Paste the secret UUID from step 3 |

You can configure GA-only or GSC-only or both per site — each tool checks
whichever field it needs.

## Tools

### `list_sites`

No params. Returns sites the calling company is allowed to read (filtered
by `allowedCompanies`). Sites scoped to other companies are not visible.
No secret material is returned.

```json
{ "sites": [{ "key": "acme", "name": "Acme Corp site", "description": "...", "ga4Wired": true, "gscWired": true }] }
```

### `ga_run_report`

Runs a GA4 `runReport` for the named site.

| Param | Notes |
|---|---|
| `siteKey` | Required. The site Identifier from plugin config. Calling company must be in that site's Allowed companies. |
| `startDate` / `endDate` | YYYY-MM-DD, `today`, `yesterday`, or `NdaysAgo`. |
| `metrics` | Required, non-empty array of GA4 metric names. Common: `activeUsers`, `sessions`, `screenPageViews`, `conversions`, `totalRevenue`. |
| `dimensions` | Optional. Common: `date`, `country`, `pagePath`, `sessionSource`, `deviceCategory`. |
| `limit` | Default 100. |
| `orderByMetric` | Optional metric to sort by (descending). |

### `ga_realtime`

Active users in the last 30 minutes for the named site.

| Param | Notes |
|---|---|
| `siteKey` | Required. |
| `dimension` | Default `country`. Also valid: `city`, `deviceCategory`, etc. |

### `gsc_search_analytics`

| Param | Notes |
|---|---|
| `siteKey` | Required. |
| `startDate` / `endDate` | YYYY-MM-DD only. |
| `dimensions` | Optional, subset of `["date", "query", "page", "country", "device"]`. Default `["date"]`. |
| `rowLimit` | Default 100. |

### Example invocation

```http
POST /api/plugins/tools/execute
{
  "tool": "google-analytics.ga_run_report",
  "params": {
    "siteKey": "acme",
    "startDate": "7daysAgo",
    "endDate": "today",
    "metrics": ["activeUsers", "sessions"],
    "dimensions": ["date"]
  },
  "runContext": {
    "agentId": "...",
    "runId": "...",
    "companyId": "<must-be-in-site-allowedCompanies>",
    "projectId": "..."
  }
}
```

## Error codes

| Code | When |
|---|---|
| `[ECOMPANY_NOT_ALLOWED]` | Calling company isn't in the site's `allowedCompanies` list, or the list is empty. |
| `[EGA_RUN_REPORT]` | GA4 `runReport` failed. Wrapped error from googleapis. |
| `[EGA_REALTIME]` | GA4 `runRealtimeReport` failed. |
| `[EGSC_QUERY]` | Search Console `searchanalytics.query` failed. |

Service-account auth errors typically surface as `[EGA_*]` or `[EGSC_*]`
with messages like `403 PERMISSION_DENIED` — re-check that the SA email
was added to the GA property / GSC site (step 2 above).

## Authors

Barry Carr · Tony Allard
