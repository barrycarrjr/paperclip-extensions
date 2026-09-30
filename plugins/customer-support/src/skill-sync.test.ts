import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { checkSkillSync } from "./skill-sync.js";
import { validateDirectory } from "./support-directory.js";
import { diagnosticScript } from "./diagnostic-catalog.js";
import { jobSource } from "./job-folders.js";
const companyId = "11111111-1111-4111-8111-111111111111";
const profileId = "22222222-2222-4222-8222-222222222222";
const details = { target: "pc.example.local", sourcePath: "D:\\Skills", backupPath: "D:\\Backup" };
const cfg = { remoteAccessProfiles: [{ id: "example", companyId, credentialUser: "EXAMPLE\\support", passwordRef: "33333333-3333-4333-8333-333333333333", scopes: [{ kind: "dns_suffix" as const, value: "example.local", transport: "Wmi" as const }] }] };
test("sync profiles reject the same root and unsafe paths; reads require company/person access and successful transport", async () => {
  assert.throws(() => validateDirectory({ kind: "sync_check", name: "Example", details: { ...details, backupPath: details.sourcePath } }));
  assert.throws(() => validateDirectory({ kind: "sync_check", name: "Example", details: { ...details, sourcePath: "D:\\Skills\\..\\Private" } }));
  const run = { companyId, userId: "operator", chatSessionId: "chat", userPermission: "support:diagnose" } as ToolRunContext;
  let logs = 0;
  const ctx = { manifest: { id: "customer-support" }, db: { namespace: "plugin_customer_support_0c69412611", query: async (_sql: string, values: string[]) => values[0] === companyId ? [{ id: profileId, kind: "sync_check", version: 1, details }] : [] }, activity: { log: async () => { logs++; } } } as unknown as PluginContext;
  const runner = async () => ({ runId: "example", status: "succeeded", exitCode: 0, output: '{"status":"local_copy_matches","cloudUploadVerified":false}' });
  assert.equal((await checkSkillSync(ctx, cfg, run, profileId, runner)).profileVersion, 1);
  assert.equal(logs, 1);
  await assert.rejects(checkSkillSync(ctx, cfg, { ...run, companyId: profileId }, profileId, runner));
  await assert.rejects(checkSkillSync(ctx, cfg, { ...run, userPermission: "support:repair" }, profileId, runner));
  await assert.rejects(checkSkillSync(ctx, cfg, run, profileId, async () => ({ runId: null, status: "script_failed", exitCode: 1 })), /no backup success/);
});
test("Windows skill comparison detects different/missing copies without exporting names or contents", { skip: process.platform !== "win32" }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "support-sync-"));
  try {
    const sourcePath = join(temp, "source"), backupPath = join(temp, "backup");
    await mkdir(sourcePath); await mkdir(backupPath);
    await writeFile(join(sourcePath, "example.md"), "Synthetic skill content");
    const scriptPath = join(temp, "check.ps1");
    await writeFile(scriptPath, diagnosticScript(await jobSource("Get-SupportSkillSync.ps1"), { sourcePath, backupPath }));
    const execute = async () => JSON.parse((await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath], { windowsHide: true, timeout: 20_000 })).stdout);
    assert.equal((await execute()).missing, 1);
    await writeFile(join(backupPath, "example.md"), "Different synthetic content");
    assert.equal((await execute()).different, 1);
    await writeFile(join(backupPath, "example.md"), "Synthetic skill content");
    const matched = await execute();
    assert.equal(matched.status, "local_copy_matches");
    assert.equal(matched.cloudUploadVerified, false); assert.equal(matched.restoreVerified, false);
    assert.doesNotMatch(JSON.stringify(matched), /example\.md|Synthetic skill content/);
    await writeFile(join(sourcePath, "large.md"), "x".repeat(262145));
    assert.equal((await execute()).status, "partial");
  } finally {
    assert.equal(dirname(resolve(temp)), resolve(tmpdir())); assert.ok(basename(temp).startsWith("support-sync-"));
    await rm(temp, { recursive: true, force: true });
  }
});

