import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { PGlite } from "@electric-sql/pglite";
import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import type { Config } from "./routing.js";
import { startFleetCheck, continueFleetCheck, getFleetCheck, stopFleetCheck } from "./fleet-health.js";
import { inventoryIdentity, listAssets, rememberAsset } from "./asset-inventory.js";
import { openInteractiveCase, diagnoseInteractiveCase } from "./interactive-support.js";
import { evaluateHealth } from "./health-evaluation.js";
import { discoverDevices } from "./network-discovery.js";

const namespace = "plugin_customer_support_0c69412611";
const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompany = "22222222-2222-4222-8222-222222222222";
const run: ToolRunContext = { companyId, userId: "operator", chatSessionId: "chat", agentId: "", runId: "turn", userPermission: "support:diagnose" };
const cfg: Config = { remoteAccessProfiles: [{ id: "office", companyId, credentialUser: "EXAMPLE\\support", passwordRef: "33333333-3333-4333-8333-333333333333", scopes: [{ kind: "dns_suffix", value: "office.example.local", transport: "Wmi" }] }] };
const snapshot = { computer: "PC", domain: "office.example.local", hardwareUuid: "44444444-4444-4444-8444-444444444444", machineGuid: "55555555-5555-4555-8555-555555555555", ipv4Addresses: ["192.0.2.1"], os: "Example Windows" };
function findings() { return { sections: {
  inventory: { status: "available", data: snapshot }, performance: { status: "available", data: { cpuLoadPercent: [5], totalMemoryMB: 8000, freeMemoryMB: 4000 } },
  storage: { status: "available", data: { disks: [{ drive: "C:", sizeGB: 100, freeGB: 1 }] } },
  services: { status: "available", data: { stoppedAutomaticServices: [{ name: "ExampleTriggerService", exitCode: 0 }] } },
  events: { status: "available", data: { events: [] } }, updates: { status: "available", data: { pendingRestart: { windowsUpdate: true } } },
  printers: { status: "unavailable" },
} }; }
const scan: typeof discoverDevices = async () => ({ networkId: "office", cidr: "192.0.2.0/24", startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), status: "completed", checkedAddresses: 254, totalAddresses: 254, notObserved: 251, methods: [], ports: [], instruction: "Read-only discovery", devices: [
  { address: "192.0.2.1", names: ["pc.office.example.local"], pingResponded: true, openPorts: [{ port: 445, service: "SMB" }], remoteTarget: "pc.office.example.local" },
  { address: "192.0.2.2", names: ["alias.office.example.local"], pingResponded: true, openPorts: [{ port: 445, service: "SMB" }], remoteTarget: "alias.office.example.local" },
  { address: "192.0.2.3", names: [], pingResponded: true, openPorts: [{ port: 9100, service: "Raw printing" }], remoteTarget: null },
] });
async function fixture() {
  const db = new PGlite(); await db.exec(`CREATE SCHEMA ${namespace}`);
  for (const file of (await readdir(new URL("../migrations/", import.meta.url))).filter(name => name.endsWith(".sql")).sort()) await db.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  const ctx = { db: { namespace,
    query: async (sql: string, params: unknown[]) => { assert.match(sql.trim(), /^SELECT\b/i); return (await db.query(sql, params)).rows; },
    execute: async (sql: string, params: unknown[]) => { assert.match(sql.trim(), /^(INSERT|UPDATE|DELETE)\b/i); return { rowCount: (await db.query(sql, params)).affectedRows }; },
  }, activity: { log: async () => {} } } as unknown as PluginContext;
  const diagnose: typeof diagnoseInteractiveCase = async (context, config, caller, input) => diagnoseInteractiveCase(context, config, caller, input, async (_context, _access, _case, script, diagnostic) => {
    assert.equal(diagnostic, true); assert.ok(script.includes("Win32_ComputerSystemProduct")); assert.ok(!script.includes("# SUPPORT_INVENTORY_SCRIPT"));
    return { status: "succeeded", exitCode: 0, runId: "test", output: JSON.stringify(findings()) };
  });
  return { db, ctx, diagnose };
}
async function planned(ctx: PluginContext, input: Record<string, unknown> = {}) {
  const result = await startFleetCheck(ctx, cfg, run, input, scan);
  assert.ok("fleetId" in result); return result;
}
test("authenticated hardware identity groups aliases, separates companies and flags possible clones or renames", async () => {
  const { db, ctx } = await fixture();
  try {
    const first = await openInteractiveCase(ctx, cfg, run, { target: "pc", summary: "Inventory" });
    const second = await openInteractiveCase(ctx, cfg, run, { target: "alias", summary: "Inventory" });
    const a = await rememberAsset(ctx, cfg, companyId, first.target, first.caseId, snapshot);
    const b = await rememberAsset(ctx, cfg, companyId, second.target, second.caseId, snapshot);
    assert.equal(a.assetId, b.assetId); assert.equal(a.identityStrength, "windows_hardware");
    const assets = await listAssets(ctx, cfg, companyId); assert.equal(assets.length, 1); assert.ok(assets[0]!.aliases.some(alias => alias.address === "192.0.2.1"));
    assert.equal((await listAssets(ctx, cfg, otherCompany)).length, 0);
    const conflict = await rememberAsset(ctx, cfg, companyId, first.target, first.caseId, { ...snapshot, computer: "OTHER-PC" });
    assert.equal(conflict.identityConflict, true);
    assert.notEqual(inventoryIdentity("pc.office.example.local", { serial: "shared-placeholder" }).key, inventoryIdentity("alias.office.example.local", { serial: "shared-placeholder" }).key);
    assert.equal(inventoryIdentity(first.target, { ...snapshot, hardwareUuid: "00000000-0000-0000-0000-000000000000" }).strength, "target_only");
    await assert.rejects(rememberAsset(ctx, cfg, otherCompany, first.target, first.caseId, snapshot));
  } finally { await db.close(); }
});
test("health findings expose actual conditions and unavailable checks without treating normal service stops as faults", () => {
  const evaluation = evaluateHealth(findings());
  assert.equal(evaluation.assessment, "partial"); assert.deepEqual(evaluation.unavailable, ["printers"]);
  assert.ok(evaluation.observed.some(item => item.kind === "disk_space" && item.severity === "critical"));
  assert.ok(evaluation.observed.some(item => item.kind === "services" && item.severity === "info"));
  assert.equal(evaluation.needsAttention, true);
  const empty = evaluateHealth({}); assert.equal(empty.unavailable.length, 7); assert.equal(empty.assessment, "partial");
  assert.ok(empty.instruction.includes("not a clean bill of health"));
  const onlyServices = evaluateHealth({ sections: { services: findings().sections.services } }); assert.equal(onlyServices.needsAttention, false);
});
test("the assembled health diagnostic parses in Windows PowerShell and preserves embedded dollar tokens", { skip: process.platform !== "win32" }, async () => {
  const { db, ctx } = await fixture();
  try {
    const opened = await openInteractiveCase(ctx, cfg, run, { target: "pc", summary: "Health parser test" });
    await diagnoseInteractiveCase(ctx, cfg, run, { caseId: opened.caseId, check: "health" }, async (_ctx, _access, _case, script) => {
      assert.ok(script.includes("-match '^\\d+\\.\\d+\\.\\d+\\.\\d+$'"));
      const command = "$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(),[ref]$tokens,[ref]$errors) | Out-Null; $errors | Select-Object ErrorId,Message | ConvertTo-Json -Compress; if ($errors.Count) { exit 1 }";
      await new Promise<void>((resolve, reject) => {
        const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
        child.on("error", reject); child.on("close", code => code === 0 ? resolve() : reject(new Error(output)));
        child.stdin.end(script);
      });
      return { status: "succeeded", exitCode: 0, runId: "parser", output: JSON.stringify(findings()) };
    });
  } finally { await db.close(); }
});
test("fleet checks persist snapshots/cases, group asset counts and resume progress without replay", async () => {
  const { db, ctx, diagnose } = await fixture();
  try {
    const initial = await planned(ctx); assert.equal(initial.counts.pending, 2); assert.equal(initial.counts.skipped, 1);
    const resumed = await planned(ctx); assert.equal(resumed.fleetId, initial.fleetId);
    const step = await continueFleetCheck(ctx, cfg, run, { fleetId: initial.fleetId }, diagnose);
    assert.equal(step.counts.succeeded, 1); assert.equal(step.counts.pending, 1);
    const saved = await getFleetCheck(ctx, cfg, run, { fleetId: initial.fleetId }); assert.equal(saved.counts.succeeded, 1);
    const done = await continueFleetCheck(ctx, cfg, run, { fleetId: initial.fleetId }, diagnose);
    assert.equal(done.status, "completed"); assert.equal(done.counts.succeeded, 2); assert.equal(done.distinctAuthenticatedAssets, 1);
    assert.ok(done.items.filter(item => item.status === "succeeded").every(item => item.case_id));
    let commands = 0;
    await continueFleetCheck(ctx, cfg, run, { fleetId: initial.fleetId }, async () => { commands++; throw new Error(); });
    assert.equal(commands, 0);
  } finally { await db.close(); }
});
test("fleet permission/person/chat/company and target access are enforced before remote checks", async () => {
  const { db, ctx } = await fixture();
  try {
    const job = await planned(ctx); let commands = 0; const diagnose: typeof diagnoseInteractiveCase = async () => { commands++; throw new Error("Never run"); };
    for (const invalid of [{ ...run, userPermission: undefined }, { ...run, userPermission: "support:repair" }, { ...run, companyId: otherCompany }, { ...run, userId: "different" }, { ...run, chatSessionId: "different" }]) {
      await assert.rejects(getFleetCheck(ctx, cfg, invalid, { fleetId: job.fleetId }));
      await assert.rejects(continueFleetCheck(ctx, cfg, invalid, { fleetId: job.fleetId }, diagnose));
    }
    const revoked = await continueFleetCheck(ctx, {}, run, { fleetId: job.fleetId }, diagnose);
    assert.equal(revoked.counts.failed, 1); assert.equal(commands, 0);
  } finally { await db.close(); }
});
test("concurrent continuations claim only one computer and stopping preserves the running result", async () => {
  const { db, ctx, diagnose } = await fixture();
  try {
    const job = await planned(ctx); let commands = 0; let started!: () => void; let release!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; }); const wait = new Promise<void>(resolve => { release = resolve; });
    const paused: typeof diagnoseInteractiveCase = async (...args) => { commands++; started(); await wait; return diagnose(...args); };
    const running = continueFleetCheck(ctx, cfg, run, { fleetId: job.fleetId }, paused); await began;
    const concurrent = await continueFleetCheck(ctx, cfg, run, { fleetId: job.fleetId }, paused);
    assert.equal(concurrent.counts.running, 1); assert.equal(commands, 1);
    const cancelled = await stopFleetCheck(ctx, cfg, run, { fleetId: job.fleetId }); assert.equal(cancelled.status, "cancelled"); assert.equal(cancelled.counts.pending, 0);
    release(); const finished = await running; assert.equal(finished.status, "cancelled"); assert.equal(finished.counts.succeeded, 1);
    await continueFleetCheck(ctx, cfg, run, { fleetId: job.fleetId }, paused); assert.equal(commands, 1);
  } finally { await db.close(); }
});
test("worker-loss diagnostics become interrupted and remaining steps continue without replaying them", async () => {
  const { db, ctx, diagnose } = await fixture();
  try {
    const job = await planned(ctx);
    await db.query(`UPDATE ${namespace}.support_fleet_items SET status='running',started_at=now()-interval '9 minutes' WHERE fleet_id=$1 AND ordinal=0`, [job.fleetId]);
    const next = await continueFleetCheck(ctx, cfg, run, { fleetId: job.fleetId }, diagnose);
    assert.equal(next.counts.interrupted, 1); assert.equal(next.counts.succeeded, 1); assert.equal(next.status, "completed");
  } finally { await db.close(); }
});
test("stopping during planning also skips devices saved after the stop", async () => {
  const { db, ctx } = await fixture();
  try {
    const execute = ctx.db.execute.bind(ctx.db); let stopped = false;
    ctx.db.execute = async (sql, params) => {
      const result = await execute(sql, params);
      if (!stopped && sql.includes("INSERT INTO") && sql.includes("support_fleet_items")) {
        stopped = true;
        await stopFleetCheck(ctx, cfg, run, { fleetId: params![1] });
      }
      return result;
    };
    const job = await planned(ctx);
    assert.equal(job.status, "cancelled"); assert.equal(job.counts.pending, 0); assert.equal(job.counts.skipped, 3);
    let commands = 0;
    await continueFleetCheck(ctx, cfg, run, { fleetId: job.fleetId }, async () => { commands++; throw new Error(); });
    assert.equal(commands, 0);
  } finally { await db.close(); }
});
test("batch/target limits are explicit and a printer without Windows access is never assessed as healthy", async () => {
  const { db, ctx } = await fixture();
  try {
    await assert.rejects(planned(ctx, { maxDevices: 21 }));
    await assert.rejects(planned(ctx, { targets: ["other.office.example.local"] }));
    const job = await planned(ctx, { maxDevices: 1 }); assert.equal(job.counts.pending, 1); assert.equal(job.counts.skipped, 2);
    assert.ok(job.items.find(item => item.discovered_address === "192.0.2.3")!.reason!.includes("health was not assessed"));
  } finally { await db.close(); }
});
