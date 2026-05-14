# Rollbar Tools (paperclip plugin)

Read items / occurrences / metrics from Rollbar, plus optional
resolve / mute mutations. Multi-project, per-project `allowedCompanies`,
and **separate read + write tokens** so mutations are physically
impossible without an explicit operator opt-in.

> **Install + setup walkthrough** lives in-app: open the plugin's settings page in Paperclip and follow the **Setup** tab. This README is an overview of capabilities and a reference for tool/event shapes.

## Recent changes

- **v0.2.11** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.2.10** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.2.9** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.2.8** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.2.7** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.2.6** — Harden instanceConfigSchema with additionalProperties: false to reject unknown keys on config POST.

- **v0.2.5** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.2.4** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.2.3** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.2.2** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

## Tools registered

| Tool | Kind | Notes |
|---|---|---|
| `rollbar_list_items` | read | Filters: status / level / environment / framework / assignee / query. |
| `rollbar_get_item` | read | By itemId or per-project counter. |
| `rollbar_list_occurrences` | read | Per item. |
| `rollbar_get_occurrence` | read | Full stack/request/person. |
| `rollbar_get_top_items` | read | Active items ranked by total_occurrences over a window. |
| `rollbar_resolve_item` | mutation | Requires writeTokenRef + allowMutations. |
| `rollbar_mute_item` | mutation | Until ISO date or indefinitely. Requires writeTokenRef + allowMutations. |
| `rollbar_get_metrics_snapshot` | read (cached 5min) | active / new-in-window / occurrences / critical counts. |

Every tool accepts an optional `project` parameter; if omitted, falls
back to the configured `defaultProject`.

## Install

```bash
cd %USERPROFILE%\paperclip-extensions\plugins\rollbar-tools
pnpm install
pnpm build

# From paperclip:
pnpm --filter paperclipai exec tsx src/index.ts plugin install --local %USERPROFILE%\paperclip-extensions\plugins\rollbar-tools
```

## Configure

### 1. Issue Project Access Tokens

Rollbar uses Project Access Tokens scoped per-project, per-permission:

- **Read** — view items, occurrences, deploys
- **Write** — modify items (resolve / mute)
- **post_server_item / post_client_item** — submit new errors. **Don't
  generate these for this plugin** — we're consuming, not producing.

In Rollbar:

1. Open the project.
2. **Project Access Tokens** → **Create New Access Token**.
3. Name: `paperclip-read`. Scope: **read**. Save the token.
4. (Optional, only if you'll enable mutations) Repeat with name
   `paperclip-write`, scope **write**.

Keeping read and write as separate tokens means: if you only generate
the read token, mutations literally cannot work, even if someone flips
`allowMutations` later.

### 2. Store the tokens as paperclip secrets

For each token:

1. `<COMPANY-PREFIX>/company/settings/secrets` → **+ Create secret**.
2. Name: `ROLLBAR_READ_ACMEPRINT` / `ROLLBAR_WRITE_ACMEPRINT`.
3. Provider: `Local encrypted`. Value: paste the token.
4. Copy the secret's UUID.

### 3. Bind the project in the plugin config

Open `/instance/settings/plugins/rollbar-tools`. **+ Add item**:

| Field | Example | Notes |
|---|---|---|
| `Identifier` | `acme-print-prod` | Stable ID agents pass. |
| `Display name` | `Acme Print — Production` | Free-form. |
| `Read token` | (read secret UUID) | Required. |
| `Write token (optional)` | (write secret UUID) or blank | Required only if you'll enable mutations. |
| `Default environment filter` | `production` or blank | When set, list/snapshot tools default to this env. |
| `Allowed companies` | tick the LLC | Empty = unusable. |

(Optionally) set **Default project key** so agents can omit `project`.

## Tool usage examples

### Top items in the last 24h

```ts
await tools.invoke("rollbar_get_top_items", {
  // project omitted → defaultProject
  since: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
  limit: 10,
  levels: ["critical", "error"],
});
```

### Get the latest stack trace

```ts
const item = await tools.invoke("rollbar_get_item", { itemId: 123456 });
const lastOccId = item.data.last_occurrence_id;
const occ = await tools.invoke("rollbar_get_occurrence", {
  occurrenceId: lastOccId,
});
console.log(occ.data.data.body.trace.frames);
```

### Snapshot for a metrics dashboard

```ts
await tools.invoke("rollbar_get_metrics_snapshot", { windowHours: 24 });
// → { activeItemCount: 47, newItemsInWindow: 3, occurrencesInWindow: 1284, criticalItemCount: 2, … }
```

### Auto-resolve a fixed bug

```ts
await tools.invoke("rollbar_resolve_item", {
  itemId: 123456,
  comment: "fixed in v1.4.2",
});
```

(Requires `allowMutations=true` AND a writeTokenRef on the project.)

## Cross-plugin chain: rollbar-scraper → github-tools

`rollbar_get_top_items` → take top N → for each, call
`github-tools:github_create_issue` with `idempotencyKey: "rollbar-fp-<itemId>"`.

The github-tools plugin auto-applies a label and dedupes, so re-running
the heartbeat doesn't create duplicate tickets.

## Error codes

| Code | Meaning |
|---|---|
| `[EPROJECT_REQUIRED]` | No project param and no default. |
| `[EPROJECT_NOT_FOUND]` | Project identifier not in plugin config. |
| `[ECOMPANY_NOT_ALLOWED]` | Calling company isn't in this project's `allowedCompanies`. |
| `[ECONFIG]` | Project lacks readTokenRef, or secret didn't resolve. |
| `[EDISABLED]` | Mutation called while `allowMutations=false` OR no writeTokenRef. |
| `[EINVALID_INPUT]` | Required param missing or contradictory. |
| `[EROLLBAR_AUTH]` | 401 — token invalid. |
| `[EROLLBAR_PERM]` | 403 — token lacks scope (e.g. write op with read token). |
| `[EROLLBAR_NOT_FOUND]` | 404. |
| `[EROLLBAR_INVALID]` | 422 — body rejected. |
| `[EROLLBAR_RATE_LIMIT]` | 429. |
| `[EROLLBAR_API]` | Rollbar returned `err != 0` in the wrapped response. |
| `[EROLLBAR_NETWORK]` | Network error before reaching Rollbar. |
| `[EROLLBAR_UPSTREAM_5xx]` | 5xx response. |

## Caching

`rollbar_get_metrics_snapshot` caches results for 5 minutes per
`(project, environment, windowHours)` to avoid the cost of paginating
items repeatedly. Save the plugin config to flush.

## `allowedCompanies` cheatsheet

Same shape as every other paperclip plugin. Each Rollbar project
typically belongs to one LLC's application — prefer single-company
lists over `["*"]`.

## Out of scope (this version)

- Submitting items (we consume Rollbar, not produce).
- RQL query interface.
- Notification rule config.
- Deploy tracking (`POST /api/1/deploy/`).
- Versions / collaborators APIs.

## Versioning

`0.1.0` — initial release. 8 tools across reads / mutations / metrics.
