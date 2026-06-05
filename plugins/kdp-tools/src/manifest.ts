import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 & { setupInstructions?: string } = {
  id: "kdp-tools",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "KDP Tools",
  setupInstructions: `# Setup — KDP Tools

Validate and publish ePub/PDF manuscripts to Amazon Kindle Direct Publishing. Manages the pending/published/error folder pipeline.

---

## 1. Store KDP credentials as Paperclip secrets

- \`KDP_EMAIL\` — Amazon account email
- \`KDP_PASSWORD\` — Amazon account password or app-specific password
- \`KDP_MFA_SECRET\` — TOTP seed for MFA (optional)

---

## 2. Configure the plugin (Configuration tab)

- **Stories root** — path to the folder pipeline root (e.g. \`/workspace/stories\`)
- **Content types** — which subfolder types to scan: books, childrens_books, comics, graphic_novels, short_stories
- **KDP credentials** — paste secret UUIDs

---

## 3. Folder structure

\`\`\`
stories/
├── books/
│   ├── pending/        ← drop ePub/PDF + metadata.json here
│   ├── published/      ← successfully published
│   └── error/          ← failed with error report
├── childrens_books/
│   ├── pending/ | published/ | error/
└── ...
\`\`\`
`,
  description:
    "Validate and publish ePub/PDF manuscripts to Amazon KDP. Manages pending/published/error folder pipeline with metadata sidecar files.",
  author: "BookZeta",
  categories: ["automation"],
  capabilities: [
    "agent.tools.register",
    "instance.settings.register",
    "secrets.read-ref",
    "http.outbound",
    "telemetry.track",
  ],
  entrypoints: { worker: "./dist/worker.js" },
  instanceConfigSchema: {
    type: "object",
    propertyOrder: ["storiesRoot", "contentTypes", "kdpEmailRef", "kdpPasswordRef", "kdpMfaSecretRef", "allowedCompanies"],
    properties: {
      storiesRoot: { type: "string", title: "Stories root directory", description: "Root path for the folder pipeline (e.g. ./stories)." },
      contentTypes: {
        type: "array",
        title: "Content types",
        items: { type: "string" },
        description: "Subfolder names to scan: books, childrens_books, comics, graphic_novels, short_stories.",
      },
      kdpEmailRef: { type: "string", format: "secret-ref", title: "KDP email" },
      kdpPasswordRef: { type: "string", format: "secret-ref", title: "KDP password" },
      kdpMfaSecretRef: { type: "string", format: "secret-ref", title: "KDP MFA secret (optional)" },
      allowedCompanies: { type: "array", items: { type: "string", format: "company-id" }, title: "Allowed companies" },
    },
  },
  tools: [
    {
      name: "kdp_scan_pending",
      displayName: "Scan KDP pending files",
      description: "Scan the pending folders for each content type and return a list of ready manuscripts with their metadata status.",
      parametersSchema: {
        type: "object",
        properties: {
          contentTypes: { type: "string", description: "Comma-separated content types to scan. Default: all configured." },
        },
      },
    },
    {
      name: "kdp_validate",
      displayName: "Validate KDP manuscript",
      description: "Validate an ePub or PDF file against KDP requirements. Checks file integrity, metadata completeness, and cover image specs.",
      parametersSchema: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Path to the ePub or PDF file." },
          metadataPath: { type: "string", description: "Path to the companion metadata.json. Auto-detected if omitted." },
        },
        required: ["filePath"],
      },
    },
    {
      name: "kdp_publish",
      displayName: "Publish to KDP",
      description: "Submit a validated manuscript to KDP. Moves the file to published/ on success or error/ on failure.",
      parametersSchema: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Path to the manuscript file." },
          contentType: { type: "string", description: "Content type (books, childrens_books, comics, graphic_novels, short_stories)." },
          dryRun: { type: "boolean", description: "Validate only, don't submit. Default false." },
        },
        required: ["filePath", "contentType"],
      },
    },
    {
      name: "kdp_move_file",
      displayName: "Move KDP file",
      description: "Move a file and its sidecar files between pending/published/error folders.",
      parametersSchema: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Path to the file to move." },
          destination: { type: "string", description: "'published' or 'error'." },
          reason: { type: "string", description: "Reason for moving (written to error report if destination is 'error')." },
        },
        required: ["filePath", "destination"],
      },
    },
  ],
};

export default manifest;
