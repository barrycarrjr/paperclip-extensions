import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 & { setupInstructions?: string } = {
  id: "acx-tools",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "ACX Audiobook Tools",
  setupInstructions: "# Setup — ACX Tools\n\nSee the companion skill `acx-audiobook-publisher` for full setup and folder structure documentation.\n\nStore ACX credentials as Paperclip secrets: `ACX_EMAIL`, `ACX_PASSWORD`, `ACX_MFA_SECRET` (optional).",
  description: "Validate and publish audiobooks to Audible via ACX. Checks audio against ACX specs. Manages pending/published/error pipeline.",
  author: "BookZeta",
  categories: ["automation"],
  capabilities: ["agent.tools.register", "instance.settings.register", "secrets.read-ref", "http.outbound", "telemetry.track"],
  entrypoints: { worker: "./dist/worker.js" },
  instanceConfigSchema: {
    type: "object",
    properties: {
      audiobooksRoot: { type: "string", title: "Audiobooks root directory" },
      acxEmailRef: { type: "string", format: "secret-ref", title: "ACX email" },
      acxPasswordRef: { type: "string", format: "secret-ref", title: "ACX password" },
      acxMfaSecretRef: { type: "string", format: "secret-ref", title: "ACX MFA secret (optional)" },
      allowedCompanies: { type: "array", items: { type: "string", format: "company-id" }, title: "Allowed companies" },
    },
  },
  tools: [
    { name: "acx_scan_pending", displayName: "Scan ACX pending", description: "Scan pending folder for audiobook projects.", parametersSchema: { type: "object", properties: {} } },
    { name: "acx_validate_audio", displayName: "Validate audio", description: "Validate audio against ACX specs (44.1kHz, ≥192kbps, peak ≤-3dB, RMS -23 to -18dB, noise ≤-60dB).", parametersSchema: { type: "object", properties: { projectPath: { type: "string" } }, required: ["projectPath"] } },
    { name: "acx_validate_cover", displayName: "Validate cover", description: "Validate cover art (min 2400×2400, square, JPEG/PNG).", parametersSchema: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] } },
    { name: "acx_publish", displayName: "Publish to ACX", description: "Submit audiobook to ACX. Moves to published/ or error/.", parametersSchema: { type: "object", properties: { projectPath: { type: "string" }, relatedKdpAsin: { type: "string" }, dryRun: { type: "boolean" } }, required: ["projectPath"] } },
    { name: "acx_move_project", displayName: "Move ACX project", description: "Move project between pending/published/error.", parametersSchema: { type: "object", properties: { projectPath: { type: "string" }, destination: { type: "string" }, reason: { type: "string" } }, required: ["projectPath", "destination"] } },
  ],
};

export default manifest;
