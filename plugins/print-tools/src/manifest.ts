import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "print-tools";
const PLUGIN_VERSION = "0.1.13";

const SETUP_INSTRUCTIONS = `# Setup — Print Tools

Give agents the ability to print text to any Windows printer visible to the Paperclip server. No external credentials or API keys needed — just configure which printers to allow and which companies can use them. Reckon on **about 5 minutes**.

---

## Requirements

- Paperclip server must be running on **Windows** (or a Windows-accessible print server)
- Target printers must be installed and visible in the Windows **Printers & scanners** settings on the Paperclip host

---

## 1. Discover your printer name

The exact Windows printer name is required. Two ways to find it:

**Via PowerShell** (on the Paperclip host):
\`\`\`powershell
Get-Printer | Select-Object Name, DriverName, PortName
\`\`\`
Copy the \`Name\` column value exactly (e.g. \`Brother HL-L2350DW series\`).

**Via Paperclip** (after configuring the plugin):
Call the \`list_printers\` tool — it returns all visible printers with their exact names.

---

## 2. Configure the plugin (this page, **Configuration** tab)

Click the **Configuration** tab above and fill in:

| Field | Value |
|---|---|
| **Default printer name** | exact printer name from step 1 (or leave blank to use the Windows system default) |
| **Allowed companies** | tick the companies whose agents may call \`list_printers\` and \`print_text\` |

**Allowed companies** is required — leave it empty and no company can use the plugin (fail-safe deny).

For a single-company setup, tick just that company. For portfolio-wide access (e.g. a shared office printer), tick **Portfolio-wide** (\`*\`).

---

## Troubleshooting

- **Printer not found** — the printer name doesn't exactly match what Windows reports. Run \`Get-Printer\` or call \`list_printers\` to verify the exact string.
- **Print job spools but nothing prints** — the printer may be offline, out of paper, or have a stuck queue. Check **Windows Settings → Printers & scanners → Open print queue**.
- **\`[ECOMPANY_NOT_ALLOWED]\`** — the calling company isn't in Allowed companies.
- **Network printer not visible** — the printer must be installed on the Paperclip host (appear in Windows Printers & scanners), not just accessible on the network. Install the printer driver on the host first.
`;

const manifest: PaperclipPluginManifestV1 & { setupInstructions?: string } = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Print Tools",
  setupInstructions: SETUP_INSTRUCTIONS,
  description:
    "Print text content to any Windows printer visible to the Paperclip server — locally attached or LAN printers.",
  author: "Barry Carr & Tony Allard",
  categories: ["automation"],
  capabilities: [
    "agent.tools.register",
    "instance.settings.register",
    "telemetry.track",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    additionalProperties: false,
    propertyOrder: ["defaultPrinter", "allowedCompanies"],
    properties: {
      defaultPrinter: {
        type: "string",
        title: "Default printer name",
        "x-paperclip-optionsFrom": { actionKey: "list_printers_options" },
        description:
          "Exact Windows printer name used when an agent calls print_text without specifying a printer. Leave blank to use the Windows system default. To find the name, call list_printers or run Get-Printer in PowerShell — the Name column is what goes here. Example: 'Brother HL-L2350DW series'.",
      },
      allowedCompanies: {
        type: "array",
        title: "Allowed companies",
        description:
          "Which Paperclip companies' agents can call list_printers and print_text. Use [\"*\"] for portfolio-wide access (any company in your instance). Get company UUIDs from the Companies page in Paperclip settings. Empty = no company can use this plugin.",
        items: { type: "string", format: "company-id" },
      },
    },
    required: ["allowedCompanies"],
  },
  tools: [
    {
      name: "list_printers",
      displayName: "List Printers",
      description:
        "Return all Windows printers visible to the Paperclip server. Use this to discover the exact printer name to pass to print_text.",
      parametersSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "print_text",
      displayName: "Print Text",
      description:
        "Print plain-text content to a Windows printer. Writes a temp file and sends it via Out-Printer. Fire-and-forget — returns ok once the job is spooled.",
      parametersSchema: {
        type: "object",
        required: ["content"],
        properties: {
          content: {
            type: "string",
            description: "The text to print. Multi-line strings are preserved.",
          },
          printer: {
            type: "string",
            description:
              "Exact printer name from list_printers. Omit to use the configured default, or the Windows system default if no default is set.",
          },
          jobTitle: {
            type: "string",
            description:
              "Label shown in the Windows print queue for this job. Optional — defaults to no title.",
          },
          copies: {
            type: "integer",
            description: "Number of copies to print. Defaults to 1. Max 99.",
            default: 1,
            minimum: 1,
            maximum: 99,
          },
        },
      },
    },
  ],
};

export default manifest;
