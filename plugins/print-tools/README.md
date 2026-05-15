# print-tools

Paperclip plugin that lets agents print plain-text content to any Windows printer visible to the machine running Paperclip — locally attached printers and LAN printers both work.

> **Install + setup walkthrough** lives in-app: open the plugin's settings page in Paperclip and follow the **Setup** tab. This README is an overview of capabilities and a reference for tool/event shapes.

## Recent changes

- **v0.1.13** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.1.12** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.1.11** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.1.10** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.1.9** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.1.8** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.1.7** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.1.6** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.1.5** — Harden instanceConfigSchema with additionalProperties: false to reject unknown keys on config POST.

- **v0.1.4** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.1.3** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.1.2** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.1.1** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

## What it does

Registers two agent tools:

| Tool | What it does |
|---|---|
| `list_printers` | Returns all Windows printers visible to the Paperclip server process |
| `print_text` | Prints a text string to a named printer (or the configured default) |

No secrets required. No external services. Works entirely through the Windows print subsystem via PowerShell.

## Setup

### 1. Install the plugin

From inside your Paperclip checkout:

```bash
pnpm --filter paperclipai exec tsx src/index.ts plugin install --local <path-to-print-tools>
```

### 2. Configure on the settings page

Open `/instance/settings/plugins/print-tools` and fill in:

- **Default printer name** — the exact Windows name of the printer agents should use when none is specified. To find it, open PowerShell and run:
  ```powershell
  Get-Printer | Select-Object Name, Default
  ```
  Copy the `Name` value exactly, including spaces. Example: `Brother HL-L2350DW series`.

- **Allowed companies** — pick the Paperclip companies whose agents can call these tools. Use `["*"]` for portfolio-wide access.

That's it — no API keys, no OAuth, no secrets.

### 3. Verify

Ask an agent: *"list my printers"*. It should return the printers visible on the server machine. Then: *"print 'Hello World'"* — a page should come out.

## Tools

### `list_printers`

No parameters. Returns all printers visible to the Paperclip server process.

**Returns:**
```json
{
  "printers": [
    { "name": "Brother HL-L2350DW series", "isDefault": true, "status": "Normal" },
    { "name": "Microsoft Print to PDF", "isDefault": false, "status": "Normal" }
  ]
}
```

**Sample invocation:**
> "What printers do I have available?"

---

### `print_text`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `content` | string | yes | The text to print |
| `printer` | string | no | Exact printer name from `list_printers`. Omit to use the configured default. |
| `jobTitle` | string | no | Label shown in the Windows print queue |
| `copies` | integer | no | Number of copies (1–99, default 1) |

**Returns:**
```json
{ "ok": true, "printer": "Brother HL-L2350DW series" }
```

**Sample invocations:**
> "Print the following summary to my Brother printer: [text]"
> "Print 2 copies of this to the default printer"

## Error codes

| Code | Meaning |
|---|---|
| `[ECOMPANY_NOT_ALLOWED]` | The calling agent's company is not in `allowedCompanies`. Add the company UUID on the settings page. |
| `[EPRINT_NO_PRINTER]` | The named printer was not found. Call `list_printers` and use the exact name returned. |
| `[EPRINT_SPAWN_FAILED]` | PowerShell subprocess failed. Check that `powershell.exe` is accessible from the Paperclip server process and that the printer is online. |

## Notes

- **Fire-and-forget:** `print_text` returns as soon as the job is spooled to Windows. It does not wait for the physical page to come out.
- **Copies:** `Out-Printer` in Windows PowerShell 5.1 has no `-Copies` parameter, so the plugin repeats the print pipeline N times. Each repetition is a separate print job in the queue.
- **PDF / Word docs:** out of scope for v0.1.0. Text only.
- **Remote Paperclip:** if Paperclip moves to a cloud host, this plugin will lose access to local printers. It is designed for local/LAN deployments.
