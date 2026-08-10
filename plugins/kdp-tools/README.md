# kdp-tools

Paperclip plugin that exposes Amazon KDP publishing operations as agent tools. Validates manuscripts and manages the pending/published/error folder pipeline.

## Recent changes

- **v0.1.3** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.1.2** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.1.1** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

## Tools

| Tool | Description |
|---|---|
| `kdp_scan_pending` | Scan pending folders for manuscripts |
| `kdp_validate` | Validate ePub/PDF against KDP requirements |
| `kdp_publish` | Submit manuscript to KDP |
| `kdp_move_file` | Move files between pending/published/error |

## Setup

1. Store KDP credentials as Paperclip secrets: `KDP_EMAIL`, `KDP_PASSWORD`, `KDP_MFA_SECRET`
2. Configure stories root path on `/instance/settings/plugins/kdp-tools`

## Build

```bash
pnpm install
pnpm build
```

## Companion skill

`kdp-publisher` — teaches agents the full publishing workflow.
