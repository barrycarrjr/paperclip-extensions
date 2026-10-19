import assert from "node:assert/strict";
import test from "node:test";
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import { fixture } from "./fixtures.js";
import { bridgeCompany, handleApiRequest, readCompanyPrefix, readRoster } from "./service.js";
import { plugin } from "./worker.js";
import manifest from "./manifest.js";

const now = new Date("2026-10-18T00:00:00Z");
export const input = (patch: Partial<PluginApiRequestInput> = {}): PluginApiRequestInput => ({
  routeKey: "roster.pause", method: "POST", path: "/agents/idle-a/pause", params: { agentId: "idle-a" }, query: {},
  body: { confirmed: true, requestId: "request-example-1" }, actor: { actorType: "user", actorId: "board-example", grantedPermission: "agents:create" }, companyId: "company-a", headers: {}, ...patch,
});
test("real SQL gives scoped counts and costs without join multiplication or terminated agents", async () => {
  const f = await fixture();
  try {
    const result = await readRoster(f.ctx, "company-a", now);
    assert.equal(result.idleCount, 1); assert.equal(result.idleCostCents30, 200);
    assert.deepEqual(result.rows.map((r) => [r.id, r.verdict]), [["idle-a", "Idle"], ["low-a", "Low use"], ["active-a", "Active"], ["new-a", "New"]]);
    const active = result.rows.find((row) => row.id === "active-a")!;
    assert.deepEqual([active.runs30, active.runs90, active.openIssues, active.costCents30, active.lastRunAt], [4, 5, 2, 400, "2026-10-17T00:00:00.000Z"]);
    assert.equal(result.rows[0].lastRunAt, null);
    // Count at the 30/90-day boundary; future and unstarted runs never count.
    await f.db.exec(`INSERT INTO heartbeat_runs VALUES ('boundary30', 'company-a', 'low-a', '2026-09-18Z'), ('boundary90', 'company-a', 'low-a', '2026-07-20Z'), ('future', 'company-a', 'low-a', '2026-11-01Z');`);
    const low = (await readRoster(f.ctx, "company-a", now)).rows.find((row) => row.id === "low-a")!;
    assert.equal(low.runs30, 2); assert.equal(low.runs90, 3); assert.equal(low.lastRunAt, "2026-10-17T00:00:00.000Z");
  } finally { await f.db.close(); }
});
test("empty, missing, malformed and denied configuration fail closed before database access", async () => {
  const f = await fixture();
  try {
    f.ctx.db.query = async () => { throw new Error("must not query"); };
    for (const config of [{}, { allowedCompanies: [] }, { allowedCompanies: ["*", {}] }, { allowedCompanies: ["company-a", null] }, { allowedCompanies: ["*", ""] }, { allowedCompanies: ["company-b"] }, { allowedCompanies: "company-a" }]) {
      f.setConfig(config);
      assert.equal((await handleApiRequest(f.ctx, input())).status, 403);
      await assert.rejects(readRoster(f.ctx, "company-a", now), /not enabled/);
    }
  } finally { await f.db.close(); }
});
test("Portfolio-wide enables both companies while host scope and every aggregate remain isolated", async () => {
  const f = await fixture();
  try {
    f.setConfig({ allowedCompanies: ["*"] });
    await plugin.definition.setup(f.ctx);
    for (const companyId of ["company-a", "company-b"]) {
      assert.deepEqual(await f.handlers.get("roster.visible")!({ hostScope: { companyId } }), { visible: true, companyId });
      const roster = await readRoster(f.ctx, companyId, now);
      assert.deepEqual(roster.rows.map((row) => row.id).sort(), companyId === "company-a" ? ["active-a", "idle-a", "low-a", "new-a"] : ["other-b"]);
      assert.equal(roster.idleCostCents30, companyId === "company-a" ? 200 : 0);
      assert.equal((await handleApiRequest(f.ctx, input({ routeKey: "roster.list", method: "GET", companyId, actor: { actorType: "user", actorId: "board-example" } }))).status, 200);
    }
    await assert.rejects(bridgeCompany(f.ctx, { hostScope: { companyId: "company-a" }, companyId: "company-b" }), /host-verified/);
    for (const key of ["roster.list", "roster.widget"]) await assert.rejects(f.handlers.get(key)!({ hostScope: { companyId: "company-a" }, companyId: "company-b" }), /host-verified/);
    assert.deepEqual(await f.handlers.get("roster.visible")!({ hostScope: { companyId: "company-a" }, companyId: "company-b" }), { visible: false });
    assert.equal((await handleApiRequest(f.ctx, input({ params: { agentId: "other-b" }, body: { confirmed: true, requestId: "request-example-1", companyId: "company-b" } }))).status, 404);
    assert.equal(f.entries.length, 0);
  } finally { await plugin.definition.onShutdown?.(); await f.db.close(); }
});
test("Pause requires the exact host permission stamp before lookup, audit or mutation; reads need no stamp", async () => {
  const f = await fixture();
  try {
    assert.equal((await handleApiRequest(f.ctx, input({ routeKey: "roster.list", method: "GET", actor: { actorType: "user", actorId: "board-example" } }))).status, 200);
    f.ctx.agents.get = async () => { assert.fail("denied Pause must not look up an agent"); };
    f.ctx.agents.pause = async () => { assert.fail("denied Pause must not mutate an agent"); };
    f.ctx.activity.log = async () => { assert.fail("denied Pause must not write activity"); };
    for (const grantedPermission of [undefined, "issues:create"]) {
      const response = await handleApiRequest(f.ctx, input({ actor: { actorType: "user", actorId: "board-example", grantedPermission }, body: { confirmed: true, requestId: "request-example-1", grantedPermission: "agents:create", actor: { grantedPermission: "agents:create" } } }));
      assert.equal(response.status, 403);
    }
  } finally { await f.db.close(); }
});
test("data handlers require host company, reject tampering, hide unauthorized UI, and register every hook key", async () => {
  const f = await fixture();
  try {
    await plugin.definition.setup(f.ctx);
    assert.deepEqual([...f.handlers.keys()].sort(), ["roster.list", "roster.visible", "roster.widget"]);
    await assert.rejects(bridgeCompany(f.ctx, { companyId: "company-a" }), /host-verified/);
    await assert.rejects(bridgeCompany(f.ctx, { companyId: "company-b", hostScope: { companyId: "company-a" } }), /host-verified/);
    await assert.rejects(f.handlers.get("roster.list")!({ hostScope: { companyId: "company-b" } }), /not enabled/);
    assert.deepEqual(await f.handlers.get("roster.visible")!({ hostScope: { companyId: "company-b" } }), { visible: false });
    assert.deepEqual(await f.handlers.get("roster.widget")!({ hostScope: { companyId: "company-b" } }), { visible: false });
    const result = await f.handlers.get("roster.list")!({ companyId: "company-a", hostScope: { companyId: "company-a" } }) as { companyId: string };
    assert.equal(result.companyId, "company-a");
  } finally { await plugin.definition.onShutdown?.(); await f.db.close(); }
});
test("pause requires a board actor, explicit confirmation and an agent belonging to the authorized company", async () => {
  const f = await fixture();
  try {
    for (const patch of [
      { actor: { actorType: "agent" as const, actorId: "agent-example" } },
      { companyId: "company-b", body: { confirmed: true, requestId: "request-example-1", companyId: "company-a" } },
    ]) assert.equal((await handleApiRequest(f.ctx, input(patch))).status, 403);
    assert.equal((await handleApiRequest(f.ctx, input({ body: { confirmed: false, requestId: "request-example-1" } }))).status, 400);
    assert.equal((await handleApiRequest(f.ctx, input({ params: { agentId: "other-b" } }))).status, 404);
    assert.equal((await handleApiRequest(f.ctx, input({ params: { agentId: "gone-a" } }))).status, 409);
    await f.db.exec("UPDATE agents SET status = 'pending_approval' WHERE id = 'new-a'");
    assert.equal((await handleApiRequest(f.ctx, input({ params: { agentId: "new-a" } }))).status, 409);
    assert.equal(f.entries.length, 0);
    assert.equal((await f.ctx.agents.get("idle-a", "company-a"))?.status, "idle");
  } finally { await f.db.close(); }
});
test("pause audits every HTTP attempt; immediate retries avoid another pause and a later resumed agent remains auditable", async () => {
  const f = await fixture();
  try {
    const original = f.ctx.agents.pause;
    let pauses = 0;
    f.ctx.agents.pause = async (id, companyId) => { pauses++; assert.equal(f.entries[0].message, "agent_roster.pause_requested"); return original(id, companyId); };
    assert.equal((await handleApiRequest(f.ctx, input())).status, 200);
    assert.equal((await handleApiRequest(f.ctx, input())).status, 200);
    assert.equal(pauses, 1);
    assert.deepEqual(f.entries.map((e) => e.message), ["agent_roster.pause_requested", "agent_roster.pause_completed", "agent_roster.pause_requested", "agent_roster.pause_completed"]);
    assert.deepEqual(f.entries[1].metadata, { requestedByUserId: "board-example", requestId: "request-example-1" });
    await f.db.exec("UPDATE agents SET status = 'idle' WHERE id = 'idle-a'");
    assert.equal((await handleApiRequest(f.ctx, input())).status, 200);
    assert.equal(pauses, 2); assert.equal(f.entries.length, 6);
  } finally { await f.db.close(); }
});
test("audit outage prevents mutation; completion outage explicitly reports the partial result and can be retried", async () => {
  const f = await fixture();
  try {
    const log = f.ctx.activity.log;
    f.ctx.activity.log = async () => { throw new Error("example outage"); };
    assert.equal((await handleApiRequest(f.ctx, input())).status, 503);
    assert.equal((await f.ctx.agents.get("idle-a", "company-a"))?.status, "idle");
    f.ctx.activity.log = async (entry) => { if (entry.message.endsWith("completed")) throw new Error("example outage"); await log(entry); };
    const partial = await handleApiRequest(f.ctx, input());
    assert.equal(partial.status, 502); assert.equal((partial.body as { paused: boolean }).paused, true);
    assert.match((partial.body as { error: string }).error, /Agent is paused/);
    f.ctx.activity.log = log;
    assert.equal((await handleApiRequest(f.ctx, input())).status, 200);
    assert.equal(f.entries.length, 3);
  } finally { await f.db.close(); }
});
test("manifest limits core reads, declares board routes and has no agent write tools or termination capability", () => {
  assert.deepEqual(manifest.database?.coreReadTables, ["agents", "heartbeat_runs", "cost_events", "issues", "companies"]);
  assert.ok(manifest.apiRoutes?.every((route) => route.auth === "board"));
  assert.equal(manifest.apiRoutes?.find((route) => route.routeKey === "roster.pause")?.requiredUserPermission, "agents:create");
  assert.equal(manifest.tools?.length ?? 0, 0);
  assert.equal(manifest.capabilities.includes("database.namespace.write"), false);
});

test("widget obtains its company route from scoped host data when Morning Brief supplies no prefix", async () => {
  const f = await fixture();
  try {
    await plugin.definition.setup(f.ctx);
    const widget = await f.handlers.get("roster.widget")!({ hostScope: { companyId: "company-a" } }) as { companyId: string; companyPrefix: string };
    assert.equal(widget.companyId, "company-a");
    assert.equal(widget.companyPrefix, "EXA");
    await assert.rejects(readCompanyPrefix(f.ctx, "company-b"), /not enabled/);
    await f.db.exec("DELETE FROM companies WHERE id = 'company-a'");
    await assert.rejects(readCompanyPrefix(f.ctx, "company-a"), /route prefix/);
  } finally { await plugin.definition.onShutdown?.(); await f.db.close(); }
});
test("unexpected host pause responses cannot produce a success or completed activity entry", async () => {
  const f = await fixture();
  try {
    f.ctx.agents.pause = async (id, companyId) => ({ id, companyId, status: "idle" }) as Awaited<ReturnType<typeof f.ctx.agents.pause>>;
    const response = await handleApiRequest(f.ctx, input());
    assert.equal(response.status, 502);
    assert.match((response.body as { error: string }).error, /did not confirm/);
    assert.equal(f.entries.length, 1); assert.equal(f.entries[0].message, "agent_roster.pause_requested");
  } finally { await f.db.close(); }
});
