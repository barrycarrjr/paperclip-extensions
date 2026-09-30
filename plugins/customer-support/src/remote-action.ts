import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { IntakeError } from "./routing.js";
import type { ResolvedRemoteAccess } from "./remote-access.js";
import { withRemoteSlot } from "./remote-task-queue.js";

const bridgePath = resolve(fileURLToPath(new URL("./scripts/Invoke-SupportActionFromStdin.ps1", import.meta.url)));

export interface RemoteActionReceipt {
  runId: string | null;
  status: string;
  exitCode: number | null;
  output?: string;
}

export function validateRemoteActionReceipt(
  result: Record<string, unknown>, code: number | null,
  expected: { target: string; companyId: string; caseReference: string; scriptSha256: string },
): RemoteActionReceipt {
  if (typeof result.status !== "string" || !["succeeded", "script_failed"].includes(result.status)) {
    throw new IntakeError(502, "Remote action returned an unknown outcome");
  }
  if (result.target !== expected.target || result.company !== expected.companyId ||
      result.caseReference !== expected.caseReference ||
      typeof result.scriptSha256 !== "string" || result.scriptSha256.toLowerCase() !== expected.scriptSha256 ||
      (result.status === "succeeded" && code !== 0)) {
    throw new IntakeError(502, "Remote action receipt did not match the reviewed request");
  }
  return {
    runId: typeof result.runId === "string" ? result.runId : null,
    status: result.status,
    exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
  };
}

export async function runRemoteActionScript(
  ctx: PluginContext,
  access: ResolvedRemoteAccess,
  caseReference: string,
  script: string,
  includeDiagnosticOutput = false,
): Promise<RemoteActionReceipt> {
  return withRemoteSlot(access.target, () => runRemoteActionScriptUnlocked(ctx, access, caseReference, script, includeDiagnosticOutput));
}

/** Internal executor: caller must hold the target slot for the whole action sequence. */
export async function runRemoteActionScriptUnlocked(
  ctx: PluginContext, access: ResolvedRemoteAccess, caseReference: string, script: string, includeDiagnosticOutput = false,
): Promise<RemoteActionReceipt> {
  if (process.platform !== "win32" || !existsSync(bridgePath)) {
    throw new IntakeError(422, "Remote PowerShell actions require a Windows plugin host with the support scripts installed");
  }
  const password = await ctx.secrets.resolve(access.passwordRef, access.companyId);
  if (!password) throw new IntakeError(422, "Remote credential secret did not resolve");
  const expectedHash = createHash("sha256").update(script, "utf8").digest("hex");
  return new Promise((done, reject) => {
    const child = spawn("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", bridgePath,
    ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let settled = false;
    let tooLarge = false;
    let stderrSize = 0;
    const timer = setTimeout(() => {
      child.kill();
      if (!settled) { settled = true; reject(new IntakeError(504, "Remote action timed out; outcome is unknown")); }
    // Two write/verification legs plus a 30-second queue wait fit under the
    // host's five-minute tool ceiling. Diagnostics have a separate budget.
    }, includeDiagnosticOutput ? 150_000 : 125_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 131_072) { tooLarge = true; child.kill(); }
    });
    child.stderr.on("data", (chunk: string) => {
      stderrSize += chunk.length;
      if (stderrSize > 131_072) { tooLarge = true; child.kill(); }
    });
    child.stdin.on("error", () => {});
    child.on("error", () => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(new IntakeError(500, "PowerShell action could not start")); }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (tooLarge) { reject(new IntakeError(502, "Remote output exceeded the limit; outcome is unknown")); return; }
      try {
        const result = JSON.parse(stdout) as Record<string, unknown>;
        const receipt = validateRemoteActionReceipt(result, code, {
          target: access.target, companyId: access.companyId, caseReference, scriptSha256: expectedHash,
        });
        if (includeDiagnosticOutput && receipt.status === "succeeded" && typeof result.output === "string") {
          if (result.output.length > 65_536) throw new IntakeError(502, "Diagnostic output exceeded the limit; narrow the diagnostic filter");
          receipt.output = result.output.split(password).join("[credential removed]");
        }
        done(receipt);
      } catch (error) {
        reject(error instanceof IntakeError ? error : new IntakeError(502, "Remote action returned an invalid result"));
      }
    });
    child.stdin.end(JSON.stringify({
      operation: "script",
      target: access.target,
      companyId: access.companyId,
      caseReference,
      userName: access.credentialUser,
      password,
      transport: access.transport,
      allowProcessExecutionPolicyBypass: access.allowProcessExecutionPolicyBypass,
      scriptBase64: Buffer.from(script, "utf8").toString("base64"),
    }), "utf8");
  });
}
