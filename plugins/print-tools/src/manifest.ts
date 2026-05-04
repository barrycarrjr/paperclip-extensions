import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "print-tools";
const PLUGIN_VERSION = "0.1.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Print Tools",
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
    propertyOrder: ["defaultPrinter", "allowedCompanies"],
    properties: {
      defaultPrinter: {
        type: "string",
        title: "Default printer name",
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
