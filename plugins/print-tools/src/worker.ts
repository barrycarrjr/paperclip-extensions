import {
  definePlugin,
  runWorker,
  type PluginContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { assertCompanyAccess } from "./companyAccess.js";

interface InstanceConfig {
  defaultPrinter?: string;
  allowedCompanies?: string[];
}

function runPowerShell(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ps = spawn("powershell.exe", ["-NonInteractive", "-Command", command]);
    let stdout = "";
    let stderr = "";
    ps.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    ps.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    ps.on("close", (code: number | null) => {
      if (code !== 0) {
        reject(
          new Error(
            `[EPRINT_SPAWN_FAILED] PowerShell exited ${code ?? "null"}: ${stderr.trim() || stdout.trim()}`,
          ),
        );
      } else {
        resolve(stdout.trim());
      }
    });
    ps.on("error", (err: Error) => {
      reject(new Error(`[EPRINT_SPAWN_FAILED] Failed to start PowerShell: ${err.message}`));
    });
  });
}

function parsePrinterJson(raw: string): Array<{ Name?: string; Default?: boolean; PrinterStatus?: string }> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

// Escape a string value for use inside a PowerShell single-quoted string.
function psSingleQuote(s: string): string {
  return s.replace(/'/g, "''");
}

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    ctx.logger.info("print-tools plugin setup");

    ctx.tools.register(
      "list_printers",
      {
        displayName: "List Printers",
        description:
          "Return all Windows printers visible to the Paperclip server.",
        parametersSchema: {} as Record<string, unknown>,
      },
      async (_params, runCtx: ToolRunContext): Promise<ToolResult> => {
        const config = (await ctx.config.get()) as InstanceConfig;

        assertCompanyAccess(ctx, {
          tool: "list_printers",
          resourceLabel: "print-tools",
          resourceKey: "instance",
          allowedCompanies: config.allowedCompanies,
          companyId: runCtx.companyId,
        });

        const raw = await runPowerShell(
          "@(Get-Printer | Select-Object Name,Default,PrinterStatus) | ConvertTo-Json -Compress",
        );

        const parsed = parsePrinterJson(raw);
        const printers = parsed.map((p) => ({
          name: p.Name ?? "",
          isDefault: !!p.Default,
          status: p.PrinterStatus ?? "Unknown",
        }));

        await ctx.telemetry.track("print-tools.list_printers", {
          count: printers.length,
          companyId: runCtx.companyId,
        });

        return {
          content: `Found ${printers.length} printer(s).`,
          data: { printers },
        };
      },
    );

    ctx.tools.register(
      "print_text",
      {
        displayName: "Print Text",
        description: "Print plain-text content to a Windows printer.",
        parametersSchema: {} as Record<string, unknown>,
      },
      async (params, runCtx: ToolRunContext): Promise<ToolResult> => {
        const config = (await ctx.config.get()) as InstanceConfig;

        assertCompanyAccess(ctx, {
          tool: "print_text",
          resourceLabel: "print-tools",
          resourceKey: "instance",
          allowedCompanies: config.allowedCompanies,
          companyId: runCtx.companyId,
        });

        const p = params as {
          content?: string;
          printer?: string;
          jobTitle?: string;
          copies?: number;
        };

        if (!p.content || p.content.trim() === "") {
          return { error: "content is required and cannot be empty." };
        }

        const printerName = (p.printer ?? config.defaultPrinter ?? "").trim();
        const copies = Math.max(1, Math.min(99, Math.floor(p.copies ?? 1)));

        // Validate named printer exists before writing the temp file.
        if (printerName) {
          const raw = await runPowerShell(
            "@(Get-Printer | Select-Object -ExpandProperty Name) | ConvertTo-Json -Compress",
          );
          let names: string[] = [];
          try {
            const parsed = JSON.parse(raw);
            names = Array.isArray(parsed) ? parsed : [parsed];
          } catch {
            names = [];
          }
          const found = names.some((n) => n.toLowerCase() === printerName.toLowerCase());
          if (!found) {
            return {
              error: `[EPRINT_NO_PRINTER] Printer "${printerName}" not found. Call list_printers to see available printers.`,
            };
          }
        }

        // Write to a temp file to avoid PowerShell escaping issues with the content.
        const tmpFile = join(tmpdir(), `paperclip-print-${randomUUID()}.txt`);
        try {
          writeFileSync(tmpFile, p.content, "utf8");

          const printerArg = printerName ? `-Name '${psSingleQuote(printerName)}'` : "";
          // Out-Printer has no -Copies parameter in Windows PowerShell 5.1,
          // so repeat the pipeline for each copy.
          const escapedPath = psSingleQuote(tmpFile);
          const command =
            copies === 1
              ? `Get-Content -Path '${escapedPath}' | Out-Printer ${printerArg}`
              : `1..${copies} | ForEach-Object { Get-Content -Path '${escapedPath}' | Out-Printer ${printerArg} }`;

          await runPowerShell(command);
        } finally {
          try {
            unlinkSync(tmpFile);
          } catch {
            // Temp file cleanup failure is non-fatal.
          }
        }

        const resolvedPrinter = printerName || "Windows default";

        await ctx.telemetry.track("print-tools.print_text", {
          printerName: resolvedPrinter,
          contentLength: p.content.length,
          copies,
          companyId: runCtx.companyId,
        });

        return {
          content: `Print job sent to ${resolvedPrinter}.`,
          data: { ok: true, printer: resolvedPrinter },
        };
      },
    );
    ctx.actions.register("list_printers_options", async () => {
      const raw = await runPowerShell(
        "@(Get-Printer | Select-Object -ExpandProperty Name) | ConvertTo-Json -Compress",
      );
      let names: string[] = [];
      try {
        const parsed = JSON.parse(raw);
        names = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        names = [];
      }
      return { options: names };
    });
  },
});

runWorker(plugin, import.meta.url);

export default plugin;
