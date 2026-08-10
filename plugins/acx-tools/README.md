# acx-tools

Paperclip plugin that exposes Audible/ACX audiobook publishing operations as agent tools. Validates audio against ACX specs and manages the pending/published/error pipeline.

## Recent changes

- **v0.1.4** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.1.3** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.1.2** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.1.1** — Replace the never-wired native `sharp` dependency with pure-JS `image-size`, and implement the previously skipped cover dimension check: `acx_validate_cover` now enforces the ACX 2400×2400 minimum. Native modules can't load from a `.pcplugin` install (only `dist/` ships), so `sharp` could never have worked there.

## Tools

| Tool | Description |
|---|---|
| `acx_scan_pending` | Scan pending folder for audiobook projects |
| `acx_validate_audio` | Validate audio against ACX specs |
| `acx_validate_cover` | Validate cover art (2400×2400 min) |
| `acx_publish` | Submit audiobook to ACX |
| `acx_move_project` | Move projects between pending/published/error |

## Setup

1. Store ACX credentials as Paperclip secrets: `ACX_EMAIL`, `ACX_PASSWORD`, `ACX_MFA_SECRET`
2. Configure audiobooks root path on `/instance/settings/plugins/acx-tools`

## Build

```bash
pnpm install
pnpm build
```

## Companion skill

`acx-audiobook-publisher` — teaches agents the audiobook publishing workflow.
