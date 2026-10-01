import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { IntakeError, type Config } from "./routing.js";
import { resolveRemoteAccess } from "./remote-access.js";

const bridgePath = resolve(fileURLToPath(new URL("./scripts/Invoke-SupportIdentityFromStdin.ps1", import.meta.url)));

export async function runRemoteIdentity(
  ctx: PluginContext,
  config: Config,
  input: { companyId: string; caseReference: string; target: string },
): Promise<Record<string, unknown>> {
  const access = resolveRemoteAccess(config, input.companyId, input.target);
  if (process.platform !== "win32" || !existsSync(bridgePath)) {
    throw new IntakeError(422, "Remote PowerShell diagnostics require a Windows plugin host with the support scripts installed");
  }
  const password = await ctx.secrets.resolve(access.passwordRef, input.companyId);
  if (!password) throw new IntakeError(422, "Remote credential secret did not resolve");

  return await new Promise((done, reject) => {
    const child = spawn("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", bridgePath,
    ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      if (!settled) {
        settled = true;
        reject(new IntakeError(504, "Remote diagnostic timed out; execution outcome is unknown"));
      }
    }, 90_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 131_072) child.kill();
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 131_072) child.kill();
    });
    child.stdin.on("error", () => {});
    child.on("error", () => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(new IntakeError(500, "PowerShell diagnostic could not start")); }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      try {
        const result = JSON.parse(stdout) as Record<string, unknown>;
        if (code !== 0 || result.status !== "succeeded") {
          const output = typeof result.output === "string" ? result.output : "";
          reject(new IntakeError(output.includes("running scripts is disabled") ? 422 : 502,
            output.includes("running scripts is disabled")
              ? "PowerShell scripts are disabled on the target. Enable the process-only execution policy bypass for this computer and save again."
              : `Remote identity diagnostic failed (${String(result.status ?? "unknown")})`));
        } else {
          done(result);
        }
      } catch {
        reject(new IntakeError(502, "Remote diagnostic returned an invalid result"));
      }
    });
    child.stdin.end(JSON.stringify({
      operation: "identity",
      target: access.target,
      companyId: input.companyId,
      caseReference: input.caseReference,
      userName: access.credentialUser,
      password,
      transport: access.transport,
      allowProcessExecutionPolicyBypass: access.allowProcessExecutionPolicyBypass,
    }), "utf8");
  });
}
