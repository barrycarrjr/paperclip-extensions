# RevenueCat Tools (paperclip plugin)

Read RevenueCat subscriber and entitlement data, set custom attributes,
and pull approximate metrics snapshots. Multi-project, per-project
`allowedCompanies`, mutations gated.

> Build this plugin only if at least one of your LLCs uses RevenueCat
> (mobile-app subscription billing). Web SaaS billed only through Stripe
> doesn't need it.

> **Install + setup walkthrough** lives in-app: open the plugin's settings page in Paperclip and follow the **Setup** tab. This README is an overview of capabilities and a reference for tool/event shapes.

## Recent changes

- **v0.2.2** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

## Tools registered

| Tool | Kind | Notes |
|---|---|---|
| `revenuecat_get_subscriber` | read | Full subscriber object — entitlements, subscriptions, attributes. |
| `revenuecat_list_subscribers` | read | Paginated v2 listing. Requires `projectId` on the project config. |
| `revenuecat_get_subscriber_attributes` | read | Custom attributes + last-updated timestamps. |
| `revenuecat_set_subscriber_attribute` | mutation | Set attributes for personalization / lifecycle. |
| `revenuecat_delete_subscriber` | mutation | Permanent delete. RARE. |
| `revenuecat_get_metrics_snapshot` | read (cached 5min) | Approximate active / MRR / new / churn over a window. |

Every tool accepts an optional `project` parameter; if omitted, falls
back to the configured `defaultProject`.

## Install

```bash
cd %USERPROFILE%\paperclip-extensions\plugins\revenuecat-tools
pnpm install
pnpm build

# From paperclip:
pnpm --filter paperclipai exec tsx src/index.ts plugin install --local %USERPROFILE%\paperclip-extensions\plugins\revenuecat-tools
```

## Configure

### 1. Get a Project Secret API key

In app.revenuecat.com:

1. Open the project.
2. **Project Settings** → **API keys** → **Secret API keys** → **+ New**.
3. Name it (e.g. `paperclip`). Copy the secret key — shown once.
4. Note the **Project ID** (also on Project Settings) — you'll need it
   for the v2 endpoints.

> Don't use the public SDK keys — those are scoped for the mobile app.
> The plugin uses the server-side **secret** key.

### 2. Store the key as a paperclip secret

1. `<COMPANY-PREFIX>/company/settings/secrets` → **+ Create secret**
2. Name: `REVENUECAT_KEY_DEMOAPP`
3. Provider: `Local encrypted`. Value: paste the secret key.
4. Copy the secret's UUID.

### 3. Bind the project in the plugin config

Open `/instance/settings/plugins/revenuecat-tools`. **+ Add item**:

| Field | Example | Notes |
|---|---|---|
| `Identifier` | `demo-app` | Stable ID agents pass. Lowercase. |
| `Display name` | `Demo iOS App` | Free-form. |
| `Project secret API key` | (secret UUID) | Resolved at runtime. |
| `RevenueCat project ID` | `proj_abcXYZ123` | Required for `revenuecat_list_subscribers` and `_get_metrics_snapshot` (v2 API). |
| `Allowed companies` | tick the LLC | Empty = unusable. |

(Optionally) set **Default project key**.

## Tool usage examples

### Get one subscriber

```ts
await tools.invoke("revenuecat_get_subscriber", {
  appUserId: "auth0|abc123",
});
// → entitlements: { pro: { expires_at: …, active: true } }, subscriptions: …
```

### Tag a subscriber for a winback campaign

```ts
await tools.invoke("revenuecat_set_subscriber_attribute", {
  appUserId: "auth0|abc123",
  attributes: {
    winback_cohort: "2026-q2",
    last_paperclip_touch: new Date().toISOString(),
  },
});
```

(Requires `allowMutations=true`.)

### Snapshot for a metrics dashboard

```ts
await tools.invoke("revenuecat_get_metrics_snapshot", { windowDays: 30 });
// → { activeSubsCount: 1247, mrrEstimate: 4200.50, newSubsInWindow: 89, churnInWindow: 32, churnRate: 0.025, ... }
```

## Cross-plugin reconciliation note

Stripe and RevenueCat sometimes disagree about a customer's state — e.g.
they cancelled an in-app subscription but bought a web subscription
through Stripe. **Reconciliation logic belongs in skills, not in this
plugin.** Patterns that work:

- Look up the customer in both systems by a stable identity (email or
  user_id) and merge state in the calling skill (`email-winback`,
  `metrics-collector`).
- Don't trust `entitlements.<key>.active` alone if there's also a
  Stripe path — check both.

## MRR estimate caveat

`revenuecat_get_metrics_snapshot.mrrEstimate` is **approximate**. It
sums `price_in_purchased_currency` across active subs without:

- normalizing annual → monthly (treats every active sub as month-priced)
- converting currencies
- accounting for promotional pricing or family-share

For exact MRR use the RevenueCat dashboard or BigQuery export. The
plugin's number is "good enough for a daily metrics row, not for a
board deck."

## Pagination cap

`revenuecat_get_metrics_snapshot` paginates up to 5 pages × 1000 = 5000
subscribers max to keep cost ceiling predictable. If the project has
more, the snapshot is marked `paginationTruncated: true`. Up the cap
(or move to the BigQuery export) for projects with >5000 active
subscribers.

## Error codes

| Code | Meaning |
|---|---|
| `[EPROJECT_REQUIRED]` | No project param and no default. |
| `[EPROJECT_NOT_FOUND]` | Project identifier not in plugin config. |
| `[ECOMPANY_NOT_ALLOWED]` | Calling company isn't in this project's `allowedCompanies`. |
| `[ECONFIG]` | Missing apiKeyRef / projectId, or secret didn't resolve. |
| `[EDISABLED]` | Mutation called while `allowMutations=false`. |
| `[EINVALID_INPUT]` | Required param missing. |
| `[ERC_AUTH]` | 401 — token invalid. |
| `[ERC_FORBIDDEN]` | 403. |
| `[ERC_NOT_FOUND]` | 404 — subscriber or project not found. |
| `[ERC_INVALID]` | 422. |
| `[ERC_RATE_LIMIT]` | 429. |
| `[ERC_NETWORK]` | Pre-RevenueCat network error. |
| `[ERC_UPSTREAM_5xx]` | RevenueCat returned 5xx. |

## `allowedCompanies` cheatsheet

Each RevenueCat project usually corresponds to one mobile app — scope
to the LLC that owns it. Single-company lists are typical.

## Out of scope (this version)

- Webhook handling (sub renewed / cancelled / new) — needs Paperclip
  inbound HTTP.
- App Store Connect / Play Console direct integrations (RevenueCat is
  the abstraction).
- Customer-info sync to other systems.
- Currency normalization in MRR estimate.

## Versioning

`0.1.0` — initial release. 6 tools across reads / mutations / metrics.
