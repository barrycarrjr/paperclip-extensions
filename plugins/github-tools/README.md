# GitHub Tools (paperclip plugin)

GitHub repository operations as agent tools — issues, comments, repos,
pull requests, releases, search.

Multi-account, per-account `allowedCompanies` isolation, optional
per-account `allowedRepos` allow-list, and a master `allowMutations` gate.
Idempotent issue creation via auto-applied labels.

> **Install + setup walkthrough** lives in-app: open the plugin's settings page in Paperclip and follow the **Setup** tab. This README is an overview of capabilities and a reference for tool/event shapes.

## Recent changes

- **v0.2.12** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

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
| `github_list_repos` | read | Filtered by `allowedRepos` if set. |
| `github_get_issue` | read | |
| `github_list_issues` | read | Filters: state / labels / assignee / since. PRs filtered out. |
| `github_search_issues` | read | GitHub search syntax. Filtered by allowed-repos when set. |
| `github_list_comments` | read | |
| `github_list_pulls` | read | |
| `github_get_pull` | read | |
| `github_get_release` | read | One of releaseId / tag / latest. |
| `github_create_issue` | mutation | Idempotent via auto-applied label. |
| `github_add_comment` | mutation | Works on issues + PRs. |
| `github_close_issue` | mutation | stateReason: completed / not_planned. |
| `github_create_pull` | mutation | Branches must already be pushed. |
| `github_merge_pull` | mutation | Default method `squash`. |
| `github_create_release` | mutation | |

Every tool accepts an optional `account` parameter; if omitted, falls
back to the configured `defaultAccount`. Read tools also fall back to
`defaultOwner` / `defaultRepo`.

## Install

```bash
cd %USERPROFILE%\paperclip-extensions\plugins\github-tools
pnpm install
pnpm build

# From paperclip:
pnpm --filter paperclipai exec tsx src/index.ts plugin install --local %USERPROFILE%\paperclip-extensions\plugins\github-tools
```

## Configure

Two-step per GitHub account: create a Personal Access Token + paperclip
secret, then bind the account in the plugin config.

### 1. Create a Personal Access Token

GitHub has two PAT flavors:

- **Fine-grained PAT (preferred):** github.com → Settings → Developer
  settings → Personal access tokens → Fine-grained tokens → Generate.
  Set:
  - Resource owner: your user OR the org you'll target
  - Repository access: Only select repositories (pick the repos you
    want this PAT to see)
  - Permissions:
    - Issues: Read and write
    - Pull requests: Read and write
    - Contents: Read-only (write only if you want to push branches —
      this plugin doesn't, but `github_create_release` against
      protected tags may need it)
    - Metadata: Read (mandatory)
- **Classic PAT (fallback):** Settings → Developer settings → Personal
  access tokens → Tokens (classic). Add scope `repo` (which covers
  issues/PRs/releases). Broader than fine-grained, easier to set up.

Copy the token. Don't paste in chat — go straight to step 2.

### 2. Store the token as a paperclip secret

1. `<COMPANY-PREFIX>/company/settings/secrets`
2. **+ Create secret**, name e.g. `GITHUB_PAT_PERSONAL`
3. Provider: `Local encrypted`. Value: paste the PAT.
4. Copy the secret's UUID.

### 3. Bind the account in the plugin config

Open `/instance/settings/plugins/github-tools`. Click **+ Add item** under
GitHub accounts. Fill in:

| Field | Example | Notes |
|---|---|---|
| `Identifier` | `personal` | Stable ID agents pass as `account`. Lowercase, no spaces. |
| `Display name` | `Personal GitHub` | Free-form. |
| `Personal Access Token` | (secret UUID) | Resolved at runtime. |
| `Default owner (optional)` | `your-username` | When tools omit `owner`. |
| `Default repo (optional)` | `paperclip-extensions` | When tools omit `repo`. |
| `Allowed repos (owner/repo)` | `["your-username/paperclip-extensions"]` or empty | Empty = unrestricted. |
| `Allowed companies` | tick the LLC | Empty = unusable. |

(Optionally) set **Default account key** so agents can omit `account` on
every call.

## Idempotency

Pass `idempotencyKey: "<your-key>"` on `github_create_issue`. The plugin:

1. Computes the label name `paperclip:idempotency-<slug>` (key
   lowercased, non-alphanumerics replaced with `-`, max 50 chars).
2. Searches for an open issue in the target repo with that label.
3. If found, returns its number with `deduped: true`.
4. Otherwise auto-creates the label (color `ededed`) if missing, then
   creates the issue with that label applied alongside whatever you
   passed in `labels`.

Useful for `rollbar-scraper` style flows where the same fingerprint
shouldn't open multiple tickets across days.

## Tool usage examples

### Create an issue (idempotent)

```ts
await tools.invoke("github_create_issue", {
  // owner/repo omitted — uses defaultOwner/defaultRepo
  title: "Production error: NullPointerException in checkout",
  body: "First seen 2026-05-01. Occurrences: 14.\n\nStack trace:\n```\n…\n```",
  labels: ["bug", "production"],
  idempotencyKey: "rollbar-fp-deadbeef",
});
```

### Open a PR

```ts
await tools.invoke("github_create_pull", {
  title: "fix: handle null cart in checkout",
  head: "fix/null-checkout",
  base: "main",
  body: "Closes #123. Tested locally.",
  draft: false,
});
```

### Merge with squash

```ts
await tools.invoke("github_merge_pull", {
  pullNumber: 456,
  // method defaults to "squash"
  sha: "abc123…",  // optional race guard
});
```

### List recent open issues

```ts
await tools.invoke("github_list_issues", {
  state: "open",
  sort: "updated",
  perPage: 20,
});
```

## Error codes

| Code | Meaning |
|---|---|
| `[EACCOUNT_REQUIRED]` | No account param and no default. |
| `[EACCOUNT_NOT_FOUND]` | Account identifier not in plugin config. |
| `[ECOMPANY_NOT_ALLOWED]` | Calling company isn't in this account's `allowedCompanies`. |
| `[ECONFIG]` | Account lacks `tokenRef` or secret didn't resolve. |
| `[EDISABLED]` | Mutation tool called while `allowMutations=false`. |
| `[EINVALID_INPUT]` | Required param missing or contradictory. |
| `[EGITHUB_FORBIDDEN_REPO]` | Addressed repo not in account's `allowedRepos`. |
| `[EGITHUB_UNAUTHORIZED]` | 401 — token invalid. |
| `[EGITHUB_FORBIDDEN]` | 403 (auth — not rate limit). |
| `[EGITHUB_RATE_LIMIT]` | 403 with x-ratelimit-remaining=0, or 429. |
| `[EGITHUB_NOT_FOUND]` | 404. |
| `[EGITHUB_CONFLICT]` | 409. |
| `[EGITHUB_VALIDATION]` | 422 — body rejected by GitHub. |
| `[EGITHUB_SERVER_5xx]` | GitHub returned a 5xx. |
| `[EGITHUB_<status>]` | Other HTTP status. |
| `[EGITHUB_UNKNOWN]` | Non-Octokit error (e.g. network). |

## Rate limits

Octokit retries internally on transient 403/secondary rate-limit responses
(up to 3× with backoff). Sustained limits return `[EGITHUB_RATE_LIMIT]`
to the caller. Check `x-ratelimit-remaining` in debug logs.

## `allowedCompanies` cheatsheet

Same as every other paperclip plugin:

| Setting | Behavior |
|---|---|
| Missing or `[]` | Account exists in config but is unusable. |
| `["company-uuid-A"]` | Only company A's agents can use it. |
| `["*"]` | Portfolio-wide. |

`allowedRepos` layers on top — both checks must pass for a tool call.

## Out of scope (this version)

- GitHub App authentication. PAT-only for now.
- Webhooks (PR opened, issue commented, etc.) — needs a Paperclip-level
  inbound HTTP path.
- File-content APIs (read/write files in the repo). The git CLI is the
  preferred path for those.
- Releases asset uploads.
- Branch creation/deletion. Push branches via git first, then call
  `github_create_pull`.

## Versioning

`0.1.0` — initial release. 14 tools across reads / mutations.
