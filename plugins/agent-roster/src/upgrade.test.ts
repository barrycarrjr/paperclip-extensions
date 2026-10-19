import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import manifest from "./manifest.js";
import { fixture } from "./fixtures.js";
import { changeKeep, handleApiRequest, handlePauseAction, readRoster } from "./service.js";
import { plugin } from "./worker.js";
import { DAY_MS, verdict, type RosterRow } from "./roster.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompany = "22222222-2222-4222-8222-222222222222";
const agentId = "aaaaaaaa-0000-4000-8000-000000000001";
const foreignAgent = "bbbbbbbb-0000-4000-8000-000000000001";
const scope = { companyId, userId: "board-example", isInstanceAdmin: false };
const params = { agentId, hostScope: scope, note: "Example seasonal review" };
const now = new Date("2026-10-18T00:00:00Z");

test("installed PR14 migration bytes, namespace, identity and UI slots remain compatible", async () => {
  const migration = await readFile(new URL("../migrations/0001_init.sql", import.meta.url));
  assert.equal(createHash("sha256").update(migration.toString("utf8").replace(/\r\n/g, "\n")).digest("hex"), "258d7883500c1a5d9fee7d69ff9f5f1fafa13dea54dce5cac24dbf02b330393c");
  assert.equal(manifest.id, "agent-roster");
  assert.equal(manifest.database?.namespaceSlug, "roster");
  assert.equal(manifest.version, "0.2.0");
  assert.deepEqual((await readdir(new URL("../migrations/", import.meta.url))).filter((name) => name.endsWith(".sql")), ["0001_init.sql"]);
  assert.deepEqual(manifest.ui?.slots?.map((slot) => slot.id), ["roster-sidebar", "roster-page", "roster-widget"]);
});

test("seeded PR14 marks survive worker upgrade with all evidence and suppress the idle widget", async () => {
  const f = await fixture();
  try {
    await f.db.query(`INSERT INTO ${f.ctx.db.namespace}.keep_marks VALUES ($1, $2, $3, $4, $5)`, [companyId, agentId, "Example old keep note", "board-before-upgrade", "2026-10-01T00:00:00Z"]);
    const before = (await f.db.query(`SELECT * FROM ${f.ctx.db.namespace}.keep_marks`)).rows;
    await plugin.definition.setup(f.ctx);
    const roster = await readRoster(f.ctx, companyId, now);
    const row = roster.rows.find((item) => item.id === agentId)!;
    assert.equal(row.verdict, "Kept on purpose");
    assert.equal(row.usage, "Idle");
    assert.equal(row.costCents30, 200);
    assert.deepEqual(row.keep, { note: "Example old keep note", markedBy: "board-before-upgrade", markedAt: "2026-10-01T00:00:00.000Z" });
    assert.equal(roster.idleCount, 0);
    assert.equal(roster.idleCostCents30, 0);
    assert.equal((await f.handlers.get("roster.widget")!({ hostScope: scope }) as { visible: boolean }).visible, false);
    assert.deepEqual((await f.db.query(`SELECT * FROM ${f.ctx.db.namespace}.keep_marks`)).rows, before);
    assert.equal(f.entries.length, 0);
  } finally { await plugin.definition.onShutdown?.(); await f.db.close(); }
});

test("Keep validates trimmed note bounds, updates one row and Unkeep restores the evidence verdict", async () => {
  const f = await fixture();
  try {
    for (const note of [undefined, null, "  ", "x".repeat(501)]) await assert.rejects(changeKeep(f.ctx, { ...params, note }, true), /1 to 500/);
    assert.equal(f.entries.length, 0);
    await changeKeep(f.ctx, { ...params, note: ` ${"x".repeat(500)} ` }, true);
    await changeKeep(f.ctx, params, true);
    const rows = (await f.db.query<{ note: string }>(`SELECT * FROM ${f.ctx.db.namespace}.keep_marks`)).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].note, params.note);
    assert.equal((await readRoster(f.ctx, companyId, now)).rows.find((row) => row.id === agentId)?.verdict, "Kept on purpose");
    await changeKeep(f.ctx, params, false);
    assert.equal((await readRoster(f.ctx, companyId, now)).rows.find((row) => row.id === agentId)?.verdict, "Idle");
    assert.equal((await f.db.query(`SELECT * FROM ${f.ctx.db.namespace}.keep_marks`)).rows.length, 0);
    assert.deepEqual(f.entries.map((entry) => entry.message), ["agent_roster.keep_requested", "agent_roster.keep_completed", "agent_roster.keep_requested", "agent_roster.keep_completed", "agent_roster.unkeep_requested", "agent_roster.unkeep_completed"]);
    assert.ok(f.entries.every((entry) => (entry.metadata as Record<string, unknown>).requestedByUserId === scope.userId));
    assert.ok(f.entries.every((entry) => !("note" in (entry.metadata as object))));
  } finally { await f.db.close(); }
});

test("Keep and Unkeep deny missing board scope, tampering, foreign and terminated agents and revoked configuration", async () => {
  const f = await fixture();
  try {
    f.setConfig({ allowedCompanies: ["*"] });
    for (const kept of [true, false]) {
      for (const patch of [{ hostScope: undefined }, { hostScope: { companyId } }, { companyId: otherCompany }, { agentId: foreignAgent }, { agentId: "aaaaaaaa-0000-4000-8000-000000000005" }]) {
        await assert.rejects(changeKeep(f.ctx, { ...params, ...patch }, kept));
      }
    }
    await changeKeep(f.ctx, params, true);
    f.setConfig({ allowedCompanies: [] });
    await assert.rejects(changeKeep(f.ctx, params, false), /not enabled/);
    assert.equal((await f.db.query(`SELECT * FROM ${f.ctx.db.namespace}.keep_marks`)).rows.length, 1);
  } finally { await f.db.close(); }
});

test("keep reads and deletes never affect another company's seeded mark", async () => {
  const f = await fixture();
  try {
    f.setConfig({ allowedCompanies: ["*"] });
    await f.db.query(`INSERT INTO ${f.ctx.db.namespace}.keep_marks VALUES ($1, $2, 'Example foreign mark', NULL, now())`, [otherCompany, agentId]);
    assert.equal((await readRoster(f.ctx, companyId, now)).rows.find((row) => row.id === agentId)?.keep, null);
    await changeKeep(f.ctx, params, true);
    await changeKeep(f.ctx, params, false);
    const marks = (await f.db.query<{ company_id: string }>(`SELECT * FROM ${f.ctx.db.namespace}.keep_marks`)).rows;
    assert.equal(marks.length, 1);
    assert.equal(marks[0].company_id, otherCompany);
  } finally { await f.db.close(); }
});

test("Keep audit failures stop the write or report the saved partial result and allow retry", async () => {
  const f = await fixture();
  try {
    const log = f.ctx.activity.log;
    f.ctx.activity.log = async () => { throw new Error("Example audit outage"); };
    await assert.rejects(changeKeep(f.ctx, params, true), /audit outage/);
    assert.equal((await f.db.query(`SELECT * FROM ${f.ctx.db.namespace}.keep_marks`)).rows.length, 0);
    f.ctx.activity.log = async (entry) => { if (entry.message.endsWith("completed")) throw new Error("Example audit outage"); await log(entry); };
    await assert.rejects(changeKeep(f.ctx, params, true), /decision saved/);
    assert.equal((await f.db.query(`SELECT * FROM ${f.ctx.db.namespace}.keep_marks`)).rows.length, 1);
    f.ctx.activity.log = log;
    await changeKeep(f.ctx, params, true);
    assert.equal(f.entries.at(-1)?.message, "agent_roster.keep_completed");
  } finally { await f.db.close(); }
});

test("pause rechecks admin revocation on every attempt and rejects a scoped API permission alone", async () => {
  const f = await fixture();
  try {
    const confirmed = { ...params, confirmed: true, requestId: "example-revocation-1" };
    assert.equal((await handlePauseAction(f.ctx, { ...confirmed, hostScope: { ...scope, isInstanceAdmin: true } })).status, 200);
    await f.db.exec(`UPDATE agents SET status = 'idle' WHERE id = '${agentId}'`);
    assert.equal((await handlePauseAction(f.ctx, confirmed)).status, 403);
    assert.equal((await f.ctx.agents.get(agentId, companyId))?.status, "idle");
    assert.equal(f.entries.length, 2);
    const response = await handleApiRequest(f.ctx, { routeKey: "roster.pause", method: "POST", path: "/pause", params: { agentId }, query: {}, companyId, headers: {},
      actor: { actorType: "user", actorId: scope.userId, grantedPermission: "agents:create" }, body: { confirmed: true, requestId: confirmed.requestId, isInstanceAdmin: true } });
    assert.equal(response.status, 403);
    assert.equal(f.entries.length, 2);
  } finally { await f.db.close(); }
});

test("cost and run windows include exact boundaries, exclude future rows, and retain kept cost evidence", async () => {
  const f = await fixture();
  try {
    await f.db.exec(`INSERT INTO cost_events VALUES ('${companyId}', '${agentId}', 3, '2026-09-18T00:00:00Z'), ('${companyId}', '${agentId}', 7, '2026-10-18T00:00:00Z'), ('${companyId}', '${agentId}', 999, '2026-09-17T23:59:59.999Z'), ('${companyId}', '${agentId}', 999, '2026-10-18T00:00:00.001Z');
      INSERT INTO heartbeat_runs VALUES ('exact-now', '${companyId}', '${agentId}', '2026-10-18T00:00:00Z'), ('future', '${companyId}', '${agentId}', '2026-10-18T00:00:00.001Z');`);
    await changeKeep(f.ctx, params, true);
    const row = (await readRoster(f.ctx, companyId, now)).rows.find((item) => item.id === agentId)!;
    assert.equal(row.costCents30, 210);
    assert.equal(row.runs30, 1);
    assert.equal(row.runs90, 1);
    assert.equal(row.lastRunAt, now.toISOString());
    assert.equal(row.verdict, "Kept on purpose");
  } finally { await f.db.close(); }
});

test("a keep mark changes only flagged verdicts, New remains New and Active retains its note", () => {
  const row: RosterRow = { id: agentId, name: "Example", role: "general", status: "idle", createdAt: new Date(+now - 60 * DAY_MS).toISOString(), lastRunAt: null, lastHeartbeatAt: null, runs30: 0, runs90: 0, costCents30: 0, openIssues: 0, verdict: "Idle", keep: { note: params.note, markedBy: scope.userId, markedAt: now.toISOString() } };
  assert.equal(verdict(row, +now), "Kept on purpose");
  assert.equal(verdict({ ...row, runs30: 3 }, +now), "Kept on purpose");
  assert.equal(verdict({ ...row, runs30: 4 }, +now), "Active");
  assert.equal(verdict({ ...row, runs30: 1, openIssues: 2 }, +now), "Active");
  assert.equal(verdict({ ...row, createdAt: new Date(+now - DAY_MS).toISOString() }, +now), "New");
});
