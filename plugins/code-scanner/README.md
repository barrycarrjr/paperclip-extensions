# code-scanner — Paperclip plugin

Read-only code and agent-observability detectors. Backs the **Steward**
agent's daily-sweep skill, but works for any agent that wants to run a
gitleaks / knip / TODO-age / doc-drift / agent-state check.

Five tools, all read-only:

| Tool | What it does |
|---|---|
| `code_secret_scan` | gitleaks against the working tree of a configured repo |
| `code_dead_export_scan` | knip against a configured TS/JS repo |
| `code_todo_age_scan` | `git grep` + `git blame` for stale TODO/FIXME/XXX |
| `code_doc_drift_scan` | extracts code-style refs from README/AGENTS.md and grep-checks each |
| `agent_observability_query` | cross-company agent state — paused, stale heartbeat, error |

No mutation tools. There's nothing this plugin can write to.

> **Install + setup walkthrough** lives in-app: open the plugin's settings page in Paperclip and follow the **Setup** tab. This README is an overview of capabilities and a reference for tool/event shapes.

## Recent changes

- **v0.2.6** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.2.5** — Harden instanceConfigSchema with additionalProperties: false to reject unknown keys on config POST.

- **v0.2.4** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.2.3** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.2.2** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.2.1** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

## Prerequisites — install on the host

The plugin shells out to existing tools. Install them once on the
machine that runs Paperclip:

- **gitleaks** — https://github.com/gitleaks/gitleaks/releases. Drop the
  binary on PATH, or set `gitleaksBinary` in the plugin's settings to an
  absolute path. If missing, `code_secret_scan` returns
  `[ESCANNER_GITLEAKS_MISSING]`.

- **knip** — `pnpm add -D knip` in the target repo (recommended) or rely
  on `npx knip`. The plugin's default `knipBinary` is `npx knip`; tweak
  if your setup needs a specific path. If missing,
  `code_dead_export_scan` returns `[ESCANNER_KNIP_MISSING]`.

- **git** — assumed present. `code_todo_age_scan` and
  `code_doc_drift_scan` use `git grep` and `git blame`.

## Configuration

Settings page: `/instance/settings/plugins/code-scanner` after install.

```jsonc
{
  "repos": [
    {
      "key": "paperclip",
      "displayName": "Paperclip",
      "path": "C:\\path\\to\\paperclip",
      "allowedCompanies": ["*"]
    },
    {
      "key": "paperclip-extensions",
      "displayName": "Paperclip extensions",
      "path": "C:\\path\\to\\paperclip-extensions",
      "allowedCompanies": ["*"]
    }
  ],
  "todoAgeMonths": 6,
  "gitleaksBinary": "gitleaks",
  "knipBinary": "npx knip"
}
```

The agent calls `code_secret_scan({ repoKey: "paperclip" })`, etc. — it
never names a path. The operator decides which paths are scannable.

## Company isolation

Every repo entry carries `allowedCompanies`. Empty/missing = unusable.
`["*"]` = portfolio-wide. The worker rejects calls from companies not
in the list with `[ECOMPANY_NOT_ALLOWED]`. For Steward, both repos are
typically `["*"]` since the whole point is portfolio-wide observation.

## LLM-agnostic

No LLM SDKs imported. The plugin executes external tools (gitleaks,
knip, git) and Paperclip API reads. Adapter-neutral.

## Steward integration

`agent_observability_query` uses `ctx.companies.list` and
`ctx.agents.list` — Steward (resident in HQ) gets cross-company read for
free via the HQ portfolio-root authz bypass. No special config needed
beyond installing the plugin and allow-listing it for HQ.

## Phase 1 sweep skill (recommended)

Steward's first sweep should call only the highest-confidence detectors:

1. `code_secret_scan` against both repos — secrets are blast-radius
   prevention; surface immediately.
2. `agent_observability_query` — surfaces stuck/erroring agents Barry
   should know about.

Expand to TODOs / dead exports / doc drift after seeing real findings.
