# AGENTS.md

Guidance for human and AI contributors working in this repository.

## 1. Purpose

`paperclip-extensions` ships **plugins** (under `plugins/<plugin-id>/`) and **skills** (under `skills/<skill-id>/`) that run against [Paperclip](../paperclip/). Plugins are the typed integration layer (tools, events, scoped HTTP API, UI slots); skills are markdown procedures consumed by agents at runtime. This document covers the lifecycle rules — anything semantic about a specific plugin lives in that plugin's `README.md`.

## 2. Read This First

If you've never touched the repo before, look at:

1. `README.md` (this repo) — top-level orientation.
2. `plugins/<plugin>/README.md` for whichever plugin you're touching — the running `## Recent changes` log + tool/event surface.
3. `plugins/<plugin>/src/manifest.ts` — the source of truth for capabilities, tools, events, API routes, and UI slots.
4. The Paperclip plugin SDK docs in `paperclip/packages/plugins/sdk/` if you're adding a new SDK call.

## 3. Repo Map

```
plugins/                  # versioned plugins; each ships as its own .pcplugin
  <plugin-id>/
    src/                  # worker + manifest + (optional) UI bundle
    package.json          # version lives here; bumped per-plugin
    README.md             # operator-facing capability overview + recent changes
    esbuild.config.mjs    # build config
    tsconfig.json
    dist/                 # build output, gitignored
skills/                   # markdown procedures, no version field, no .pcplugin
plugin-plans/             # gitignored design notes (see git/info/exclude)
dist-pcplugins/           # gitignored release artifacts
.github/workflows/        # release.yml fires on `v*` tags
scripts/                  # repo-wide helpers (build:all, pack:all, etc.)
```

## 4. Plugin Lifecycle Rules

### 4.1 Creating a new plugin

- Scope check: this repo is for **generic** plugins reusable across operators. Personal/company-specific plugins stay out of version control.
- Use a fresh plugin-id with the `-tools` or domain-noun suffix (`stripe-tools`, `email-tools`, `social-poster`).
- Clone the structure of an existing simple plugin (`print-tools` is the smallest reference; `phone-tools` has the richest UI surface).
- Manifest essentials: `id`, `apiVersion: 1`, `version` (start `0.1.0`), `displayName`, `description`, `author`, `categories`, `capabilities`, `entrypoints.worker` (and `entrypoints.ui` if shipping UI slots). See `paperclip/packages/shared/src/types/plugin.ts` for the schema.
- LLM-agnostic: do NOT add `@anthropic-ai/sdk`, `openai`, `@google-ai/generativelanguage` etc. as dependencies. Plugins consume LLMs only via Paperclip's adapter layer.
- Company isolation: every account / mailbox / project / workspace declared in `instanceConfigSchema.accounts` (or equivalent) MUST carry an `allowedCompanies: string[]` field with `format: "company-id"` items. Default behaviour is fail-safe deny — empty list = unusable.
- No native bindings (`sharp`, `sqlite3`, `canvas`). The install step copies `dist/` only — native add-ons fail to load. Use pure-JS alternatives (`jimp`, etc.).
- Build scripts must be Windows-compatible. No `cp`/`rm`/`mkdir`/`chmod` shell-outs in build steps; use `node -e "require('fs').cpSync/rmSync(...)"`.
- Reuse Paperclip form components (`EnvVarEditor`, `CompanyMultiSelectField` via `format: "company-id"`). Don't roll your own row UIs.

### 4.2 Updating a plugin (the rule that's been broken before)

**Whenever you bump a plugin's version, the plugin's `README.md` MUST be updated in the same commit.** No "I'll update the docs later." This applies to:

- Bumping `version` in `package.json` or `PLUGIN_VERSION` in `src/manifest.ts`.
- Adding / removing / renaming a tool, event, capability, error code, API route, UI slot, or manifest field.
- Adding / changing `setupInstructions` (the in-app Setup tab).

**Minimum README update for a version bump:**
- A `## Recent changes` running log with one bullet per shipped version (newest first). Use this format, NOT one-time "What's new in vX.Y" sections — those go stale by definition.
- If a previously-claimed feature changed shape (renamed tool, removed event), update the table where that feature lives.
- If the manifest now declares `setupInstructions` and the README doesn't mention the Setup tab, add: `> **Install + setup walkthrough** lives in-app: open the plugin's settings page in Paperclip and follow the **Setup** tab. This README is an overview of capabilities and a reference for tool/event shapes.`

**Verification before committing a bump** — diff against the previous commit and confirm a README change is in the set:

```bash
git diff HEAD~1 -- plugins/<plugin>/ | grep -E "version|PLUGIN_VERSION|README\.md"
```

If you see version / manifest changes but no README diff, stop and add one.

### 4.3 Releasing

Releases are tag-driven via `.github/workflows/release.yml`. The workflow fires on any tag matching `v*`.

1. Commit the bumps + README updates (auto-commit hook usually handles this).
2. `git push origin master`.
3. `git tag v<next-monotonic>` — repo-level monotonic tags, NOT per-plugin (`v0.13.0`, `v0.14.0`, …). Check the latest with `git tag -l 'v*' | sort -V | tail -3`.
4. `git push origin v<next>` — workflow fires. Builds every plugin, packs each into `<plugin-id>-<version>.pcplugin`, regenerates `dist-pcplugins/index.json`, attaches all to a GitHub release named `v<n>`.
5. Verify with `gh run list --workflow=release.yml --limit 1` and `gh release view v<n>`.

**Don't:**
- ❌ `pnpm pack:all` locally and call that "releasing" — `dist-pcplugins/` is gitignored, those files are local-only.
- ❌ Per-plugin tag names like `phone-tools-v0.3.0` — workflow only matches `v*` and the convention here is repo-level monotonic.

## 5. Common Operational Notes

- **Local dev loop:** after `pnpm build` in a plugin folder, run `bash scripts/dev-redeploy.sh` (each plugin has one in `scripts/`) to push the freshly-built `dist/` into the running Paperclip instance and cycle the worker. Plain `pnpm build` does NOT auto-refresh the installed copy — `paperclipai plugin reinstall <key>` is what bridges source → installed copy.
- **Secrets:** the operator stores secrets in Paperclip's encrypted secret store. Plugins reference them by UUID via `secret-ref` form fields, never hard-code values. Standard naming convention: `ALL_CAPS_SNAKE_CASE` (`HELPSCOUT_CLIENT_ID`, `IMAP_PERSONAL_PASS`, `VAPI_API_KEY`).
- **Skills directory:** `skills/` is for markdown-only procedures. They have no version field, no `.pcplugin`, no `package.json`. They ship via direct path import (`POST /api/companies/:id/skills/import`).
- **Don't post resolved secret values in commits, comments, logs, or docs.** Names + shapes are fine; values never.

## 6. Where to look if something is broken

- A plugin won't install: check `paperclipai plugin install --local <path>` output for missing-capability errors. Manifest validation is strict — `ui.slots[].type: "sidebar"` requires `ui.sidebar.register` capability, etc. See `paperclip/server/src/services/plugin-capability-validator.ts`.
- A plugin installs but doesn't show in the UI: check the worker log in the running Paperclip instance for `plugin-loader: plugin activated successfully`. If you don't see it, the worker import failed — common causes are missing `entrypoints.ui`, missing dist file, or a UI bundle that imports a bare specifier without it being externalised in `esbuild.config.mjs`.
- Hot-reload doesn't pick up a manifest change: known ESM-cache gotcha — Node caches dynamic imports by URL. The release pipeline appends a cache-bust query, but local `paperclipai plugin reinstall` does this automatically. If you suspect cache: `paperclipai plugin uninstall <key> && paperclipai plugin install --local <path>`.
