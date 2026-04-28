# Paperclip Extensions

Custom skills and plugins for a paperclip instance. Each subfolder is one skill
or plugin that agents can invoke as a tool.

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
├── skills/                    ← markdown skills, one folder per skill
│   └── email-send/
│       └── SKILL.md
└── plugins/                   ← paperclip plugins (npm packages), one folder per plugin
    ├── email-tools/
    │   ├── package.json
    │   ├── src/
    │   └── README.md
    ├── social-poster/
    └── google-analytics/
```

- **Skills** are markdown procedures an agent reads and follows. They use
  whatever tools the agent's runtime makes available (plugin tools,
  built-in tools, etc.).
- **Plugins** are typed paperclip extensions built against
  `@paperclipai/plugin-sdk`. They register tools, settings, UI, etc. and
  install into paperclip via `paperclipai plugin install <path>`.

## Registering a skill in paperclip

1. Open paperclip → Skills tab → **+ Add**
2. Paste the **absolute path** to the skill folder, e.g.
   `%USERPROFILE%\paperclip-extensions\skills\email-send`
3. Click **Add**. The skill becomes available for any agent in any company.

## Installing a plugin in paperclip

```bash
cd <plugin-folder>
pnpm install && pnpm build
npx paperclipai plugin install --local <plugin-folder>
```

The plugin worker reloads automatically; no manual paperclip restart
needed.

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
