# Paperclip Extensions

Plugins, skills, agents, routines, and bundles for a paperclip instance.
Plugins ship as `.pcplugin` archives; the other four are exposed in a single
`templates-index.json` artifact that the Paperclip host fetches on every
release and renders in **Instance Settings → Templates → Import from
library**.

## Why this lives separately

Paperclip's bundled skills (`paperclip`, `paperclip-create-agent`, etc.) live in
`paperclipai/paperclip` upstream. This repo is for **portfolio-specific**
extensions — skills tuned to the operator's businesses, mailboxes, accounting
flow, and customer base.

Most extensions here will stay portfolio-private forever. A few might prove
general enough to contribute upstream — that decision happens after a few
weeks of real use, not upfront.

## Repo layout

```
paperclip-extensions/
├── README.md
├── plugins/                   ← paperclip plugins (npm packages), one folder per plugin
│   ├── email-tools/
│   ├── help-scout/
│   └── phone-tools/
├── skills/                    ← markdown skills, one folder per skill
│   └── email-send/SKILL.md
├── agents/                    ← agent-template definitions
│   └── phone-assistant/AGENT.md
├── routines/                  ← routine-template definitions (cron + variables)
│   └── pbx-daily-call-report/ROUTINE.md
└── bundles/                   ← recipes that group plugin + agent + skills + routines
    └── phone-assistant/BUNDLE.md
```

- **Plugins** are typed paperclip extensions built against
  `@paperclipai/plugin-sdk`. They register tools, settings, UI, etc. and
  install into paperclip via the Plugin Manager UI or `paperclipai plugin
  install <path>`.
- **Skills** are markdown procedures an agent reads and follows.
- **Agents** are pre-configured agent role/permissions + a system-prompt
  body. Importing an agent template creates a row that operators can edit
  and deploy to one or many companies.
- **Routines** are recurring-job templates — cron schedule, variables,
  which skill to invoke. Importing a routine creates a draft you bind to
  per-company secrets before deploying.
- **Bundles** are one-click recipes (e.g., "Phone Assistant pack") that
  expand into multiple skills + an agent + routines, all wired against a
  required plugin. Built to take a company from zero to a fully-equipped
  domain agent in under five minutes.

See `AGENTS.md` for the lifecycle rules and frontmatter schemas.

## Registering a skill in paperclip

1. Open paperclip → Skills tab → **+ Add**
2. Paste the **absolute path** to the skill folder, e.g.
   `%USERPROFILE%\paperclip-extensions\skills\email-send`
3. Click **Add**. The skill becomes available for any agent in any company.

## Installing a plugin in paperclip

Three ways, easiest first:

### From the Plugin Library (zero hoops)

Open paperclip → Plugin Manager. The **Plugin Library** section at the top
lists every plugin in this repo's latest GitHub release. Click **Install**
and you're done. No clone, no node, no build step.

(Requires the paperclip server to have network access to GitHub. The
library defaults to `barrycarrjr/paperclip-extensions`; override per-instance
with the `PAPERCLIP_PLUGIN_LIBRARY_REPO` environment variable.)

### From a `.pcplugin` file

Hand someone a single `<plugin-id>-<version>.pcplugin` archive. They open
Plugin Manager → **Install Plugin** → **Upload .pcplugin**, drop the file,
done. Build one yourself with:

```bash
paperclipai plugin pack <plugin-folder>
# → <plugin-id>-<version>.pcplugin in the current directory
```

### From a local path (dev workflow)

```bash
cd <plugin-folder>
pnpm install && pnpm build

# Then from inside your paperclip checkout:
cd /path/to/paperclip
pnpm --filter paperclipai exec tsx src/index.ts plugin install --local <plugin-folder>
```

The plugin worker reloads automatically; no manual paperclip restart
needed. Best for active development — the source folder stays linked so
clicking **↻ Reinstall** in the UI re-reads after each `pnpm build`.

> Don't use `npx paperclipai` — that fetches the published `paperclipai`
> package from npm, which won't have your fork's changes. Always run the
> CLI through pnpm from the paperclip workspace.

## Releasing plugins

`.github/workflows/release.yml` watches for tag pushes (`v*`). When you tag:

```bash
# Bump per-plugin versions in plugins/<id>/src/manifest.ts (and package.json)
# as needed, commit, then:
git tag v0.4.0
git push origin v0.4.0
```

CI:
1. Builds every plugin under `plugins/` (esbuild)
2. Packs each into a `.pcplugin` zip
3. Generates an `index.json` listing all packed plugins with their metadata
4. Merges any `coming-soon.json` placeholder entries into `index.json` with
   `comingSoon: true` so plugin *ideas* surface in the Plugin Manager
5. Generates a `roadmap.json` for the host's `/instance/settings/roadmap`
   page — merging built plugins (shipped), `coming-soon.json` stubs
   (planned), and curated entries from `roadmap.json` at the repo root
6. Creates a GitHub release with the `.pcplugin` files + `index.json` +
   `roadmap.json` attached

The Plugin Library UI in any paperclip instance pointed at this repo
auto-picks up the new release on next page load (cached for 60s server-side).

### Surfacing plugin ideas (Coming Soon)

To advertise a plugin you haven't built yet, add an entry to
[`coming-soon.json`](./coming-soon.json) at the repo root:

```json
{
  "plugins": [
    {
      "id": "quickbooks-tools",
      "displayName": "QuickBooks Tools",
      "description": "Pull P&L, balance sheet, AR/AP aging from QuickBooks Online; categorize and post journal entries."
    }
  ]
}
```

Required: `id`, `displayName`, `description`. Optional: `version`,
`categories`, `author`, `apiVersion`, `capabilities`. The next release tag
publishes these as placeholder entries — the Plugin Manager shows them with
a **Coming soon** badge and the install endpoint returns 400 if anything
tries to install one. When a stub becomes a real plugin (a `plugins/<id>/`
folder with the same id ships), the built plugin takes precedence and the
stub is silently skipped — but it's still good practice to delete the stub
from `coming-soon.json` in the same commit.

### Cross-portfolio roadmap (skills / agents / routines / features / etc.)

Coming-soon plugins surface on the Plugin Manager. For everything else —
skill ideas, agent ideas, routines, broader features — use
[`roadmap.json`](./roadmap.json):

```json
{
  "items": [
    {
      "id": "agent-cfo-quickbooks",
      "type": "agent",
      "title": "CFO Agent with QuickBooks reads",
      "description": "Once quickbooks-tools ships, wire the CFO agent to it for P&L + AR/AP queries.",
      "status": "planned",
      "linkedPluginId": "quickbooks-tools"
    }
  ]
}
```

Required: `id`, `title`. Optional: `type` (`skill | agent | routine |
feature | plugin | other`, default `other`), `description`, `status` (`idea
| planned | in-progress | shipped | wont-do`, default `idea`), `addedAt`
(YYYY-MM-DD), `linkedPluginId` (cross-links to a plugin in the Plugin
Manager), `notes` (free-form markdown).

The release pipeline merges built plugins (status=shipped) and
`coming-soon.json` stubs (status=planned) into the same artifact, so don't
re-list plugin entries here — only the cross-cutting things. Every paperclip
instance pointed at this repo renders the merged roadmap at
`/instance/settings/roadmap` (accessible from the Roadmap icon in the
account menu).

## Components currently here

| Path | Type | Status | Notes |
|---|---|---|---|
| `skills/email-send/` | Skill | Description-only | Documents the email-send procedure. Pairs with the `email-tools` plugin which exposes the actual tool. |
| `plugins/email-tools/` | Plugin | Built, ready to install | Native paperclip plugin that registers `email_send`. Multi-mailbox SMTP via nodemailer; per-mailbox passwords stored in the encrypted secrets store. |
| `plugins/social-poster/` | Plugin | Built, ready to install | Posts to Facebook Pages, Instagram Business, and X via the official APIs. OAuth 1.0a in-tree for X. |
| `plugins/google-analytics/` | Plugin | Built, ready to install | GA4 reporting + realtime + Search Console search analytics. Service-account JSON stored as a paperclip secret. |

## Workflow

```bash
# Add a new skill
mkdir skills/new-skill
# write skills/new-skill/SKILL.md

# Commit
git add skills/new-skill
git commit -m "Add new-skill: <one-line summary>"

# Push (when remote is configured)
git push origin master
```

Branching: commit directly to `master` for routine changes; spin off a
feature branch + PR only when something needs review or co-development.

## When to upstream a skill or plugin

Most extensions here are portfolio-specific and will never leave. But if one
proves general (e.g., a smart email-routing classifier any paperclip user
might want):

1. Strip portfolio-specific assumptions from config and prose
2. Make config env-driven, not hardcoded
3. Open a PR against `paperclipai/paperclip` adding the skill/plugin to their
   bundled set, OR publish independently and submit to skills.sh / npm

Don't optimize for upstream up front — write for yourself first, decide later.

## Authors

Barry Carr · Tony Allard
