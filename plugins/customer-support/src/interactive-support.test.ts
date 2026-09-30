import assert from "node:assert/strict";
import { readFile, readdir, mkdtemp, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import type { Config } from "./routing.js";
import { delegateInteractiveCase, diagnoseInteractiveCase, endInteractiveDelegation, getInteractiveCase, openInteractiveCase, resolveInteractiveTarget, runInteractiveRepair, recordInteractiveOutcome } from "./interactive-support.js";
import { withRemoteSlot } from "./remote-task-queue.js";
import { prepareRepair } from "./repair-catalog.js";
import { listDevices, saveKnowledge, searchKnowledge } from "./support-knowledge.js";

const namespace = "plugin_customer_support_0c69412611";
const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";
const target = "pc.example.local";
const config: Config = { connections: [], remoteAccessProfiles: [{ id: "office", companyId,
  credentialUser: "EXAMPLE\\support", passwordRef: "33333333-3333-4333-8333-333333333333",
  scopes: [{ kind: "dns_suffix", value: "example.local", transport: "Wmi" }],
}] };
const run: ToolRunContext = { companyId, userId: "operator", chatSessionId: "chat-a", agentId: "", runId: "run-a", userPermission: "support:repair", userConfirmed: true };
async function fixture() {
  const db = new PGlite();
  await db.exec(`CREATE SCHEMA ${namespace}`);
  for (const name of (await readdir(new URL("../migrations/", import.meta.url))).filter(n => n.endsWith(".sql")).sort()) {
    await db.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  const events: unknown[] = [];
  const ctx = { db: { namespace,
    query: async (sql: string, values?: unknown[]) => {
      assert.match(sql.trim(), /^SELECT\b/i, "Plugin db.query only permits reads");
      return (await db.query(sql, values)).rows;
    },
    execute: async (sql: string, values?: unknown[]) => {
      assert.match(sql.trim(), /^(INSERT|UPDATE|DELETE)\b/i);
      return { rowCount: (await db.query(sql, values)).affectedRows };
    },
  }, activity: { log: async (entry: unknown) => { events.push(entry); } } } as unknown as PluginContext;
  const opened = await openInteractiveCase(ctx, config, run, { target: "pc", summary: "Computer is slow" });
  const repair = { caseId: opened.caseId, target, expectedReviewVersion: opened.reviewVersion,
    script: "Restart-Service ExampleService", verificationScript: "if ((Get-Service ExampleService).Status -ne 'Running') { throw 'Still stopped' }",
    expectedEffect: "Service runs", recoveryNotes: "Restore captured settings if verification fails" };
  return { db, ctx, events, opened, repair };
}
test("target resolution is company scoped and ambiguous short names are refused", () => {
  assert.equal(resolveInteractiveTarget(config, companyId, "PC"), target);
  assert.throws(() => resolveInteractiveTarget(config, otherCompanyId, "pc"));
  assert.throws(() => resolveInteractiveTarget(config, companyId, "pc; restart"));
  const twoDomains: Config = { ...config, remoteAccessProfiles: [{ ...config.remoteAccessProfiles![0]!, scopes: [
    ...config.remoteAccessProfiles![0]!.scopes!, { kind: "dns_suffix", value: "branch.example.local", transport: "Wmi" },
  ] }] };
  assert.throws(() => resolveInteractiveTarget(twoDomains, companyId, "pc"));
});

test("repair and verification stay together across different cases on the same computer", async () => {
  const { db, ctx, repair } = await fixture();
  try {
    const otherRun = { ...run, chatSessionId: "chat-b" };
    const otherCase = await openInteractiveCase(ctx, config, otherRun, { target, summary: "Second incident" });
    const sequence: string[] = [];
    let started!: () => void; let release!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let firstCalls = 0; let secondCalls = 0;
    const first = runInteractiveRepair(ctx, config, run, repair, false, async () => {
      sequence.push(++firstCalls === 1 ? "first-repair" : "first-verify");
      if (firstCalls === 1) { started(); await gate; }
      return { runId: "first", status: "succeeded", exitCode: 0 };
    });
    await running;
    const second = runInteractiveRepair(ctx, config, otherRun, { ...repair, caseId: otherCase.caseId }, false, async () => {
      sequence.push(++secondCalls === 1 ? "second-repair" : "second-verify");
      return { runId: "second", status: "succeeded", exitCode: 0 };
    });
    await withRemoteSlot("another.example.local", async () => { sequence.push("other-computer"); });
    release();
    await Promise.all([first, second]);
    assert.deepEqual(sequence, ["first-repair", "other-computer", "first-verify", "second-repair", "second-verify"]);
  } finally { await db.close(); }
});

test("delegation revoked while waiting for the target prevents remote execution", async () => {
  const { db, ctx, repair } = await fixture();
  try {
    await delegateInteractiveCase(ctx, config, run, { ...repair, purpose: "Fix the incident" });
    let started!: () => void; let release!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const slot = withRemoteSlot(target, async () => { started(); await gate; });
    await running;
    let calls = 0;
    const pending = runInteractiveRepair(ctx, config, { ...run, userConfirmed: false }, repair, true, async () => {
      calls++; return { runId: "should-not-start", status: "succeeded", exitCode: 0 };
    });
    // Wait for the approved proposal, rather than racing the initial delegation check.
    for (let count = 0; count < 100; count++) {
      const rows = await db.query(`SELECT id FROM ${namespace}.support_actions WHERE status='approved'`);
      if (rows.rows.length) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await endInteractiveDelegation(ctx, config, run, repair);
    release(); await slot;
    assert.equal((await pending as { status: string }).status, "unknown");
    assert.equal(calls, 0);
  } finally { await db.close(); }
});

test("persisted running or unknown repairs block a new case after process state is lost", async () => {
  const { db, ctx, repair, opened } = await fixture();
  try {
    // Seed the persisted state of an interrupted worker, with no process queue.
    await db.query(`INSERT INTO ${namespace}.support_actions
      (company_id,case_id,case_review_version,target_address,script_text,script_sha256,verification_text,verification_sha256,expected_effect,recovery_notes,proposed_by_user_id,status)
      VALUES($1,$2,1,$3,'old','old','old','old','Old attempt','Inspect first','operator','running')`, [companyId, opened.caseId, target.toUpperCase()]);
    const secondRun = { ...run, chatSessionId: "after-restart" };
    const second = await openInteractiveCase(ctx, config, secondRun, { target, summary: "New incident after restart" });
    const request = { ...repair, caseId: second.caseId };
    let calls = 0;
    const runner = async () => ({ runId: String(++calls), status: "succeeded", exitCode: 0 });
    await assert.rejects(runInteractiveRepair(ctx, config, secondRun, request, false, runner), /still running/);
    assert.equal(calls, 0);
    await db.query(`UPDATE ${namespace}.support_actions SET status='unknown' WHERE case_id=$1`, [opened.caseId]);
    await assert.rejects(runInteractiveRepair(ctx, config, secondRun, { ...request, script: "A different proposed repair" }, false, runner), /awaits inspection/);
    assert.equal(calls, 0);
    // Explicit dashboard inspection/review advances the original case version.
    await db.query(`UPDATE ${namespace}.support_cases SET review_version=review_version+1 WHERE id=$1`, [opened.caseId]);
    const result = await runInteractiveRepair(ctx, config, secondRun, { ...request, script: "A fresh repair after inspection" }, false, runner) as { status: string };
    assert.equal(result.status, "verified"); assert.equal(calls, 2);
  } finally { await db.close(); }
});

test("proposal failures release pending claims without making a lost request executable again", async () => {
  const { db, ctx, repair } = await fixture();
  try {
    let failProposal = true;
    const execute = ctx.db.execute;
    ctx.db.execute = async (sql, params) => {
      if (failProposal && sql.includes("INSERT INTO") && sql.includes(".support_actions")) {
        failProposal = false; throw new Error("Database unavailable before remote execution");
      }
      return execute(sql, params);
    };
    let calls = 0;
    const runner = async () => ({ runId: String(++calls), status: "succeeded", exitCode: 0 });
    await assert.rejects(runInteractiveRepair(ctx, config, run, repair, false, runner), /Database unavailable/);
    assert.equal((await runInteractiveRepair(ctx, config, run, repair, false, runner) as { status: string }).status, "not_started");
    assert.equal(calls, 0);
    const fresh = { ...repair, script: "Start-Service ExampleService" };
    assert.equal((await runInteractiveRepair(ctx, config, run, fresh, false, runner) as { status: string }).status, "verified");
    assert.equal(calls, 2);
  } finally { await db.close(); }
});

test("recorded symptoms require consent and evidence, close/reopen the case and end delegation", async () => {
  const { db, ctx, opened, repair, events } = await fixture();
  try {
    const outcome = { ...repair, outcome: "resolved", basis: "person_confirmed", summary: "The incident is resolved", evidence: "The person confirmed the original symptom is gone" };
    await assert.rejects(recordInteractiveOutcome(ctx, config, { ...run, userConfirmed: false }, outcome));
    await assert.rejects(recordInteractiveOutcome(ctx, config, { ...run, userPermission: "support:diagnose" }, outcome));
    await assert.rejects(recordInteractiveOutcome(ctx, config, { ...run, chatSessionId: "wrong" }, outcome));
    await assert.rejects(recordInteractiveOutcome(ctx, config, run, { ...outcome, basis: "not_confirmed" }));
    await assert.rejects(recordInteractiveOutcome(ctx, config, run, { ...outcome, evidence: "password=private-value" }));
    await delegateInteractiveCase(ctx, config, run, { ...repair, purpose: "Repair the computer" });
    const closed = await recordInteractiveOutcome(ctx, config, run, outcome);
    assert.equal(closed.status, "resolved"); assert.equal(closed.reviewVersion, 2);
    const history = await getInteractiveCase(ctx, config, run, { caseId: opened.caseId });
    assert.equal(history.case.symptom_basis, "person_confirmed");
    assert.equal(history.case.delegated_until, null);
    await assert.rejects(runInteractiveRepair(ctx, config, run, { ...repair, expectedReviewVersion: 2 }, false, async () => { throw new Error("must not run"); }));
    await assert.rejects(recordInteractiveOutcome(ctx, config, run, outcome), /review changed/);
    const reopened = await recordInteractiveOutcome(ctx, config, run, { ...outcome, expectedReviewVersion: 2, outcome: "still_present", summary: "The symptom returned", evidence: "The person reported recurrence" });
    assert.equal(reopened.status, "triage"); assert.equal(reopened.reviewVersion, 3);
    assert.equal((events.at(-1) as { metadata: { outcome: string } }).metadata.outcome, "still_present");
    await runInteractiveRepair(ctx, config, run, { ...repair, expectedReviewVersion: 3 }, false, async () => { throw new Error("Lost response"); });
    await assert.rejects(recordInteractiveOutcome(ctx, config, run, { ...outcome, expectedReviewVersion: 3 }), /pending\/unknown/);
  } finally { await db.close(); }
});

test("Windows rehearsal writes, verifies and recovers an isolated test file; lost replies never replay", { skip: process.platform !== "win32" }, async () => {
  const { db, ctx, repair, opened } = await fixture();
  const directory = await mkdtemp(join(tmpdir(), "support-repair-rehearsal-"));
  const marker = join(directory, "marker.txt");
  const quoted = `'${marker.replaceAll("'", "''")}'`;
  let calls = 0;
  const runner = async (_ctx: PluginContext, _access: unknown, _caseId: string, script: string) => {
    calls++;
    const command = Buffer.from(`$ErrorActionPreference='Stop'; ${script}`, "utf16le").toString("base64");
    await promisify(execFile)("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", command], { windowsHide: true, timeout: 10000 });
    return { runId: `isolated-${calls}`, status: "succeeded", exitCode: 0 };
  };
  try {
    const create = { ...repair, script: `Set-Content -LiteralPath ${quoted} -Value 'rehearsal'`, verificationScript: `if ((Get-Content -LiteralPath ${quoted} -Raw).Trim() -ne 'rehearsal') { throw 'Marker did not match' }`, expectedEffect: "Write only an isolated temporary test file", recoveryNotes: "Remove that exact test file" };
    assert.equal((await runInteractiveRepair(ctx, config, run, create, false, runner) as { status: string }).status, "verified");
    await runInteractiveRepair(ctx, config, run, create, false, runner);
    assert.equal(calls, 2);
    const history = await getInteractiveCase(ctx, config, run, { caseId: opened.caseId });
    assert.equal(history.actions[0]!.repairExitCode, 0); assert.equal(history.actions[0]!.verificationExitCode, 0);
    const remove = { ...create, script: `Remove-Item -LiteralPath ${quoted}`, verificationScript: `if (Test-Path -LiteralPath ${quoted}) { throw 'Marker remains' }` };
    assert.equal((await runInteractiveRepair(ctx, config, run, remove, false, runner) as { status: string }).status, "verified");
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    const uncertain = { ...create, script: `${create.script}; Write-Output 'new attempt'` };
    const lostReply = async (...args: Parameters<typeof runner>) => { await runner(...args); throw new Error("Reply lost after local write"); };
    assert.equal((await runInteractiveRepair(ctx, config, run, uncertain, false, lostReply) as { status: string }).status, "unknown");
    assert.match(await readFile(marker, "utf8"), /rehearsal/);
    await assert.rejects(runInteractiveRepair(ctx, config, run, uncertain, false, runner), /unknown or running/);
    assert.equal(calls, 5);
  } finally {
    await unlink(marker).catch(error => { if (error.code !== "ENOENT") throw error; });
    await rmdir(directory);
    await db.close();
  }
});
test("internal cases need no connector, resume safely and isolate company, person and chat", async () => {
  const { db, ctx, opened } = await fixture();
  try {
    assert.equal((await openInteractiveCase(ctx, config, run, { target, summary: "Still slow" })).caseId, opened.caseId);
    for (const actor of [{ ...run, companyId: otherCompanyId }, { ...run, userId: "other" }, { ...run, chatSessionId: "other" }, { ...run, userId: null }, { ...run, userPermission: undefined }]) {
      await assert.rejects(getInteractiveCase(ctx, config, actor, { caseId: opened.caseId }));
    }
    const diagnostic = await diagnoseInteractiveCase(ctx, config, run, { caseId: opened.caseId, check: "performance" }, async (_ctx, access, id, script, output) => {
      assert.equal(access.target, target); assert.equal(id, opened.caseId); assert.equal(output, true);
      assert.match(script, /Win32_OperatingSystem/);
      return { runId: "diagnostic-1", status: "succeeded", exitCode: 0, output: '{"freeMemoryMb":100}' };
    });
    assert.equal(diagnostic.check, "performance");
    assert.match(diagnostic.instruction, /snapshot, not a complete health assessment/);
    assert.equal((await getInteractiveCase(ctx, config, run, { caseId: opened.caseId })).checks.length, 1);
    await assert.rejects(diagnoseInteractiveCase(ctx, config, run, { caseId: opened.caseId, check: "arbitrary" }));
  } finally { await db.close(); }
});
test("inline repairs require consent, bind exact target/version, verify and deduplicate across turns", async () => {
  const { db, ctx, repair } = await fixture();
  try {
    let calls = 0;
    const runner = async () => ({ runId: `remote-${++calls}`, status: "succeeded", exitCode: 0 });
    await assert.rejects(runInteractiveRepair(ctx, config, { ...run, userConfirmed: false }, repair, false, runner));
    await assert.rejects(runInteractiveRepair(ctx, config, { ...run, userPermission: "support:diagnose" }, repair, false, runner));
    await assert.rejects(runInteractiveRepair(ctx, config, run, { ...repair, target: "another.example.local" }, false, runner));
    await assert.rejects(runInteractiveRepair(ctx, config, run, { ...repair, expectedReviewVersion: 2 }, false, runner));
    assert.equal(calls, 0);
    const result = await runInteractiveRepair(ctx, config, run, repair, false, runner) as { status: string };
    assert.equal(result.status, "verified"); assert.equal(calls, 2);
    assert.deepEqual(await runInteractiveRepair(ctx, config, { ...run, runId: "new-turn" }, repair, false, runner), result);
    assert.equal(calls, 2);
  } finally { await db.close(); }
});
test("delegation expires, is revoked, and cannot survive case review changes or close", async () => {
  const { db, ctx, repair } = await fixture();
  try {
    const delegatedRun = { ...run, userConfirmed: false };
    await assert.rejects(delegateInteractiveCase(ctx, config, delegatedRun, { ...repair, purpose: "Fix this computer" }));
    await delegateInteractiveCase(ctx, config, run, { ...repair, purpose: "Fix this computer" });
    let calls = 0;
    const runner = async () => ({ runId: `remote-${++calls}`, status: "succeeded", exitCode: 0 });
    assert.equal((await runInteractiveRepair(ctx, config, delegatedRun, repair, true, runner) as {status: string}).status, "verified");
    await endInteractiveDelegation(ctx, config, run, repair);
    await assert.rejects(runInteractiveRepair(ctx, config, delegatedRun, repair, true, runner));
    await delegateInteractiveCase(ctx, config, run, { ...repair, purpose: "Fix this computer" });
    await db.query(`UPDATE ${namespace}.support_interactive_cases SET delegated_until=now()-interval '1 minute'`);
    await assert.rejects(runInteractiveRepair(ctx, config, delegatedRun, repair, true, runner));
    await delegateInteractiveCase(ctx, config, run, { ...repair, purpose: "Fix this computer" });
    await db.query(`UPDATE ${namespace}.support_cases SET review_version=2`);
    await assert.rejects(runInteractiveRepair(ctx, config, delegatedRun, { ...repair, expectedReviewVersion: 2 }, true, runner));
    await db.query(`UPDATE ${namespace}.support_cases SET status='resolved'`);
    await assert.rejects(delegateInteractiveCase(ctx, config, run, { ...repair, expectedReviewVersion: 2, purpose: "Fix this computer" }));
    assert.equal(calls, 2);
  } finally { await db.close(); }
});
test("lost remote response blocks subsequent repairs and concurrent proposals run only once", async () => {
  const { db, ctx, repair } = await fixture();
  try {
    let calls = 0;
    const runner = async () => { calls++; throw new Error("Response lost"); };
    const outcomes = await Promise.allSettled([
      runInteractiveRepair(ctx, config, run, repair, false, runner),
      runInteractiveRepair(ctx, config, run, { ...repair, script: "Restart-Service AnotherService" }, false, runner),
    ]);
    assert.equal(calls, 1);
    assert.ok(outcomes.some(r => r.status === "fulfilled" && (r.value as { status: string }).status === "unknown"));
    await assert.rejects(runInteractiveRepair(ctx, config, run, { ...repair, script: "Another change" }, false, runner), /unknown or running/);
    assert.equal(calls, 1);
  } finally { await db.close(); }
});

test("extended diagnostics keep secondary probes scoped and save refreshable company inventory", async () => {
  const { db, ctx, opened } = await fixture();
  try {
    let calls = 0;
    const runner = async () => { calls++; return { runId: "inventory", status: "succeeded", exitCode: 0, output: JSON.stringify({ computer: "PC", os: "Windows", commands: [] }) }; };
    await assert.rejects(diagnoseInteractiveCase(ctx, config, run, { caseId: opened.caseId, check: "network", options: { testTarget: "outside.other.local", port: 445 } }, runner));
    assert.equal(calls, 0);
    await diagnoseInteractiveCase(ctx, config, run, { caseId: opened.caseId, check: "inventory" }, runner);
    await diagnoseInteractiveCase(ctx, config, run, { caseId: opened.caseId, check: "inventory" }, runner);
    assert.equal((await listDevices(ctx, config, run)).devices.length, 1);
    assert.equal((await listDevices(ctx, { remoteAccessProfiles: [{ ...config.remoteAccessProfiles![0]!, companyId: otherCompanyId }] }, { ...run, companyId: otherCompanyId })).devices.length, 0);
    const missing = await diagnoseInteractiveCase(ctx, config, run, { caseId: opened.caseId, check: "directory" }, async () => ({ runId: "missing", status: "succeeded", exitCode: 0, output: '{"supported":false,"missing":"RSAT"}' }));
    assert.match(missing.instruction, /missing modules/);
    assert.equal((missing.result as { findings: { supported: boolean } }).findings.supported, false);
  } finally { await db.close(); }
});

test("prepared repairs run through existing consent, verification and deduplication", async () => {
  const { db, ctx, opened } = await fixture();
  try {
    const plan = await prepareRepair(ctx, config, { ...run, userConfirmed: false }, { caseId: opened.caseId, operation: "restart_spooler" });
    assert.match(plan.instruction, /nothing was executed/);
    assert.equal((await db.query(`SELECT * FROM ${namespace}.support_actions`)).rows.length, 0);
    await assert.rejects(prepareRepair(ctx, config, run, { caseId: opened.caseId, operation: "flush_dns", options: { testTarget: "outside.other.local" } }));
    let calls = 0;
    const runner = async () => { calls++; return { runId: "repair", status: "succeeded", exitCode: 0 }; };
    await assert.rejects(runInteractiveRepair(ctx, config, { ...run, userConfirmed: false }, plan.repair, false, runner));
    await runInteractiveRepair(ctx, config, run, plan.repair, false, runner);
    await runInteractiveRepair(ctx, config, run, plan.repair, false, runner);
    assert.equal(calls, 2);
  } finally { await db.close(); }
});

test("knowledge publication needs consent, rejects credentials and binds verified fixes to actual outcomes", async () => {
  const { db, ctx, opened, repair } = await fixture();
  try {
    const entry = { title: "Print service procedure", topic: "printers", body: "Inspect spooler, confirm restart, and verify the queue.", kind: "procedure", caseId: opened.caseId };
    await assert.rejects(saveKnowledge(ctx, config, { ...run, userConfirmed: false }, entry));
    await assert.rejects(saveKnowledge(ctx, config, run, { ...entry, body: "password=do-not-store" }));
    await assert.rejects(saveKnowledge(ctx, config, run, { ...entry, kind: "verified_fix", actionId: "66666666-6666-4666-8666-666666666666" }));
    await saveKnowledge(ctx, config, run, entry);
    assert.equal((await searchKnowledge(ctx, config, run, { query: "spooler" })).entries.length, 1);
    assert.equal((await searchKnowledge(ctx, config, run, { query: "%" })).entries.length, 0);
    const outcome = await runInteractiveRepair(ctx, config, run, repair, false, async () => ({ runId: "verified", status: "succeeded", exitCode: 0 })) as { actionId: string };
    const verified = await saveKnowledge(ctx, config, run, { ...entry, kind: "verified_fix", actionId: outcome.actionId });
    assert.equal(verified.kind, "verified_fix");
    await assert.rejects(saveKnowledge(ctx, config, { ...run, userId: "another-person" }, { ...entry, kind: "verified_fix", actionId: outcome.actionId }));
    const otherConfig = { remoteAccessProfiles: [{ ...config.remoteAccessProfiles![0]!, companyId: otherCompanyId }] };
    assert.equal((await searchKnowledge(ctx, otherConfig, { ...run, companyId: otherCompanyId }, { query: "spooler" })).entries.length, 0);
  } finally { await db.close(); }
});
