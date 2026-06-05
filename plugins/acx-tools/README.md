# acx-tools

Paperclip plugin that exposes Audible/ACX audiobook publishing operations as agent tools. Validates audio against ACX specs and manages the pending/published/error pipeline.

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
