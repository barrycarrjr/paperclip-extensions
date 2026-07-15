import { definePlugin, runWorker, type PluginContext, type ToolResult, type ToolRunContext } from "@paperclipai/plugin-sdk";
import { promises as fs } from "node:fs";
import path from "node:path";

type InstanceConfig = { storiesRoot?: string; contentTypes?: string[]; kdpEmailRef?: string; kdpPasswordRef?: string; kdpMfaSecretRef?: string; allowedCompanies?: string[] };

const DEFAULT_CONTENT_TYPES = ["books", "childrens_books", "comics", "graphic_novels", "short_stories"];

function checkCompany(config: InstanceConfig, companyId: string): string | null {
  const allowed = config.allowedCompanies ?? [];
  if (allowed.length > 0 && !allowed.includes("*") && !allowed.includes(companyId)) return `[ECOMPANY_NOT_ALLOWED] Company ${companyId} not allowed.`;
  return null;
}

async function ensureDirs(base: string) {
  for (const sub of ["pending", "published", "error"]) await fs.mkdir(path.join(base, sub), { recursive: true });
}

async function findSidecar(filePath: string): Promise<Record<string, unknown> | null> {
  const jsonPath = filePath.replace(/\.(epub|pdf)$/i, ".json");
  try { return JSON.parse(await fs.readFile(jsonPath, "utf-8")); } catch { return null; }
}

async function moveWithSidecars(filePath: string, destDir: string) {
  await fs.mkdir(destDir, { recursive: true });
  const base = path.basename(filePath, path.extname(filePath));
  const dir = path.dirname(filePath);
  const entries = await fs.readdir(dir);
  for (const entry of entries) {
    if (entry.startsWith(base)) {
      await fs.rename(path.join(dir, entry), path.join(destDir, entry));
    }
  }
}

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    ctx.logger.info("kdp-tools plugin setup");

    ctx.tools.register("kdp_scan_pending", {
      displayName: "Scan KDP pending files", description: "Scan pending folders for manuscripts.",
      parametersSchema: { type: "object", properties: { contentTypes: { type: "string" } } },
    }, async (params, runCtx): Promise<ToolResult> => {
      const config = (await ctx.config.get()) as InstanceConfig;
      const err = checkCompany(config, runCtx.companyId);
      if (err) return { error: err };

      const root = config.storiesRoot ?? "./stories";
      const types = (params as { contentTypes?: string }).contentTypes?.split(",").map((s) => s.trim()) ?? config.contentTypes ?? DEFAULT_CONTENT_TYPES;
      const results: Array<{ contentType: string; fileName: string; hasMetadata: boolean; fileSize: number }> = [];

      for (const type of types) {
        const pendingDir = path.join(root, type, "pending");
        try {
          const files = await fs.readdir(pendingDir);
          for (const file of files) {
            if (!/\.(epub|pdf)$/i.test(file)) continue;
            const filePath = path.join(pendingDir, file);
            const stat = await fs.stat(filePath);
            const sidecar = await findSidecar(filePath);
            results.push({ contentType: type, fileName: file, hasMetadata: sidecar !== null, fileSize: stat.size });
          }
        } catch { /* dir doesn't exist — skip */ }
      }
      return { content: `Found ${results.length} pending manuscript(s).`, data: { files: results } };
    });

    ctx.tools.register("kdp_validate", {
      displayName: "Validate KDP manuscript", description: "Validate an ePub or PDF against KDP requirements.",
      parametersSchema: { type: "object", properties: { filePath: { type: "string" }, metadataPath: { type: "string" } }, required: ["filePath"] },
    }, async (params, runCtx): Promise<ToolResult> => {
      const config = (await ctx.config.get()) as InstanceConfig;
      const err = checkCompany(config, runCtx.companyId);
      if (err) return { error: err };

      const p = params as { filePath: string; metadataPath?: string };
      const issues: string[] = [];

      try { const stat = await fs.stat(p.filePath); if (stat.size === 0) issues.push("File is empty (0 bytes)."); } catch { return { error: `[EINVALID_INPUT] File not found: ${p.filePath}` }; }
      const ext = path.extname(p.filePath).toLowerCase();
      if (ext !== ".epub" && ext !== ".pdf") issues.push(`Unsupported format: ${ext}. KDP accepts .epub and .pdf.`);

      const metadata = p.metadataPath ? JSON.parse(await fs.readFile(p.metadataPath, "utf-8")) : await findSidecar(p.filePath);
      if (!metadata) { issues.push("No metadata.json sidecar found."); }
      else {
        if (!metadata.title) issues.push("Missing required field: title");
        if (!metadata.author) issues.push("Missing required field: author");
        if (!metadata.description) issues.push("Missing required field: description");
      }
      const valid = issues.length === 0;
      return { content: valid ? `Validation passed for ${path.basename(p.filePath)}.` : `Validation failed: ${issues.length} issue(s).`, data: { valid, issues, metadata: metadata ?? null } };
    });

    ctx.tools.register("kdp_publish", {
      displayName: "Publish to KDP", description: "Submit a manuscript to KDP. Moves to published/ or error/.",
      parametersSchema: { type: "object", properties: { filePath: { type: "string" }, contentType: { type: "string" }, dryRun: { type: "boolean" } }, required: ["filePath", "contentType"] },
    }, async (params, runCtx): Promise<ToolResult> => {
      const config = (await ctx.config.get()) as InstanceConfig;
      const err = checkCompany(config, runCtx.companyId);
      if (err) return { error: err };

      const p = params as { filePath: string; contentType: string; dryRun?: boolean };
      const root = config.storiesRoot ?? "./stories";

      if (p.dryRun) return { content: `[DRY RUN] Would publish ${path.basename(p.filePath)} to KDP.`, data: { dryRun: true } };

      // TODO: Implement actual KDP API submission when API is available
      // For now, validate and move to published/ as a placeholder
      const metadata = await findSidecar(p.filePath);
      if (!metadata) {
        const errorDir = path.join(root, p.contentType, "error");
        await moveWithSidecars(p.filePath, errorDir);
        const errorFile = path.join(errorDir, path.basename(p.filePath, path.extname(p.filePath)) + ".error.txt");
        await fs.writeFile(errorFile, `Missing metadata.json sidecar.\nTo retry: add metadata and move back to pending/.`);
        return { error: `[EVALIDATION] No metadata sidecar for ${path.basename(p.filePath)}. Moved to error/.` };
      }

      const publishedDir = path.join(root, p.contentType, "published");
      await moveWithSidecars(p.filePath, publishedDir);
      const receipt = { publishedAt: new Date().toISOString(), title: metadata.title, contentType: p.contentType, status: "SUBMITTED" };
      await fs.writeFile(path.join(publishedDir, path.basename(p.filePath, path.extname(p.filePath)) + ".published.json"), JSON.stringify(receipt, null, 2));
      return { content: `Published "${metadata.title}" to KDP.`, data: receipt };
    });

    ctx.tools.register("kdp_move_file", {
      displayName: "Move KDP file", description: "Move a file between pending/published/error.",
      parametersSchema: { type: "object", properties: { filePath: { type: "string" }, destination: { type: "string" }, reason: { type: "string" } }, required: ["filePath", "destination"] },
    }, async (params, runCtx): Promise<ToolResult> => {
      const config = (await ctx.config.get()) as InstanceConfig;
      const err = checkCompany(config, runCtx.companyId);
      if (err) return { error: err };

      const p = params as { filePath: string; destination: string; reason?: string };
      if (!["pending", "published", "error"].includes(p.destination)) return { error: "[EINVALID_INPUT] destination must be 'pending', 'published', or 'error'." };

      const parentDir = path.dirname(path.dirname(p.filePath));
      const destDir = path.join(parentDir, p.destination);
      await moveWithSidecars(p.filePath, destDir);

      if (p.destination === "error" && p.reason) {
        const errorFile = path.join(destDir, path.basename(p.filePath, path.extname(p.filePath)) + ".error.txt");
        await fs.writeFile(errorFile, `${p.reason}\nTo retry: fix the issue and move back to pending/.`);
      }
      return { content: `Moved ${path.basename(p.filePath)} to ${p.destination}/.`, data: { ok: true } };
    });
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
