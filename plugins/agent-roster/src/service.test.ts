import assert from "node:assert/strict";
import test from "node:test";
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import { fixture } from "./fixtures.js";
import { bridgeCompany, handleApiRequest as handleReadApi, handlePauseAction, readCompanyPrefix, readRoster } from "./service.js";
import { plugin } from "./worker.js";
import manifest from "./manifest.js";

const now = new Date("2026-10-18T00:00:00Z");
export const input = (patch: Partial<PluginApiRequestInput> & { admin?: boolean } = {}): PluginApiRequestInput & { admin?: boolean } => ({
  routeKey: "roster.pause", method: "POST", path: "/agents/aaaaaaaa-0000-4000-8000-000000000001/pause", params: { agentId: "aaaaaaaa-0000-4000-8000-000000000001" }, query: {},
  body: { confirmed: true, requestId: "request-example-1" }, actor: { actorType: "user", actorId: "board-example", grantedPermission: "agents:create" }, companyId: "11111111-1111-4111-8111-111111111111", headers: {}, admin: true, ...patch,
});
// Model the real bridge's current admin attestation separately from API grants.
async function handleApiRequest(ctx: Parameters<typeof handleReadApi>[0], request: PluginApiRequestInput & { admin?: boolean }) {
  if (request.routeKey !== "roster.pause") return handleReadApi(ctx, request);
  return handlePauseAction(ctx, { ...(request.body as object), agentId: request.params.agentId,
    hostScope: { companyId: request.companyId, userId: request.actor.actorType === "user" ? request.actor.actorId : null, isInstanceAdmin: request.admin === true } });
}

test("real SQL gives scoped counts and costs without join multiplication or terminated agents", async () => {
  const f = await fixture();
  try {
    const result = await readRoster(f.ctx, "11111111-1111-4111-8111-111111111111", now);
    assert.equal(result.idleCount, 1); assert.equal(result.idleCostCents30, 200);
    assert.deepEqual(result.rows.map((r) => [r.id, r.verdict]), [["aaaaaaaa-0000-4000-8000-000000000001", "Idle"], ["aaaaaaaa-0000-4000-8000-000000000004", "Low use"], ["aaaaaaaa-0000-4000-8000-000000000002", "Active"], ["aaaaaaaa-0000-4000-8000-000000000003", "New"]]);
    const active = result.rows.find((row) => row.id === "aaaaaaaa-0000-4000-8000-000000000002")!;
    assert.deepEqual([active.runs30, active.runs90, active.openIssues, active.costCents30, active.lastRunAt], [4, 5, 2, 400, "2026-10-17T00:00:00.000Z"]);
    assert.equal(result.rows[0].lastRunAt, null);
    // Count at the 30/90-day boundary; future and unstarted runs never count.
    await f.db.exec(`INSERT INTO heartbeat_runs VALUES ('boundary30', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000004', '2026-09-18Z'), ('boundary90', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000004', '2026-07-20Z'), ('future', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000004', '2026-11-01Z');`);
    const low = (await readRoster(f.ctx, "11111111-1111-4111-8111-111111111111", now)).rows.find((row) => row.id === "aaaaaaaa-0000-4000-8000-000000000004")!;
    assert.equal(low.runs30, 2); assert.equal(low.runs90, 3); assert.equal(low.lastRunAt, "2026-10-17T00:00:00.000Z");
  } finally { await f.db.close(); }
});
test("empty, missing, malformed and denied configuration fail closed before database access", async () => {
  const f = await fixture();
  try {
    f.ctx.db.query = async () => { throw new Error("must not query"); };
    for (const config of [{}, { allowedCompanies: [] }, { allowedCompanies: ["*", {}] }, { allowedCompanies: ["11111111-1111-4111-8111-111111111111", null] }, { allowedCompanies: ["*", ""] }, { allowedCompanies: ["22222222-2222-4222-8222-222222222222"] }, { allowedCompanies: "11111111-1111-4111-8111-111111111111" }]) {
      f.setConfig(config);
      assert.equal((await handleApiRequest(f.ctx, input())).status, 403);
      await assert.rejects(readRoster(f.ctx, "11111111-1111-4111-8111-111111111111", now), /not enabled/);
    }
  } finally { await f.db.close(); }
});
test("Portfolio-wide enables both companies while host scope and every aggregate remain isolated", async () => {
  const f = await fixture();
  try {
    f.setConfig({ allowedCompanies: ["*"] });
    await plugin.definition.setup(f.ctx);
    for (const companyId of ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]) {
      assert.deepEqual(await f.handlers.get("roster.visible")!({ hostScope: { companyId } }), { visible: true, companyId });
      const roster = await readRoster(f.ctx, companyId, now);
      assert.deepEqual(roster.rows.map((row) => row.id).sort(), companyId === "11111111-1111-4111-8111-111111111111" ? ["aaaaaaaa-0000-4000-8000-000000000001", "aaaaaaaa-0000-4000-8000-000000000002", "aaaaaaaa-0000-4000-8000-000000000003", "aaaaaaaa-0000-4000-8000-000000000004"] : ["bbbbbbbb-0000-4000-8000-000000000001"]);
      assert.equal(roster.idleCostCents30, companyId === "11111111-1111-4111-8111-111111111111" ? 200 : 0);
      assert.equal((await handleApiRequest(f.ctx, input({ routeKey: "roster.list", method: "GET", companyId, actor: { actorType: "user", actorId: "board-example" } }))).status, 200);
    }
    await assert.rejects(bridgeCompany(f.ctx, { hostScope: { companyId: "11111111-1111-4111-8111-111111111111" }, companyId: "22222222-2222-4222-8222-222222222222" }), /host-verified/);
    for (const key of ["roster.list", "roster.widget"]) await assert.rejects(f.handlers.get(key)!({ hostScope: { companyId: "11111111-1111-4111-8111-111111111111" }, companyId: "22222222-2222-4222-8222-222222222222" }), /host-verified/);
    assert.deepEqual(await f.handlers.get("roster.visible")!({ hostScope: { companyId: "11111111-1111-4111-8111-111111111111" }, companyId: "22222222-2222-4222-8222-222222222222" }), { visible: false });
    assert.equal((await handleApiRequest(f.ctx, input({ params: { agentId: "bbbbbbbb-0000-4000-8000-000000000001" }, body: { confirmed: true, requestId: "request-example-1", companyId: "22222222-2222-4222-8222-222222222222" } }))).status, 403);
    assert.equal(f.entries.length, 0);
  } finally { await plugin.definition.onShutdown?.(); await f.db.close(); }
});
test("Pause requires current host admin attestation before lookup, audit or mutation; reads need no admin flag", async () => {
  const f = await fixture();
  try {
    assert.equal((await handleApiRequest(f.ctx, input({ routeKey: "roster.list", method: "GET", actor: { actorType: "user", actorId: "board-example" } }))).status, 200);
    f.ctx.agents.get = async () => { assert.fail("denied Pause must not look up an agent"); };
    f.ctx.agents.pause = async () => { assert.fail("denied Pause must not mutate an agent"); };
    f.ctx.activity.log = async () => { assert.fail("denied Pause must not write activity"); };
    for (const grantedPermission of [undefined, "issues:create"]) {
      const response = await handleApiRequest(f.ctx, input({ admin: false, actor: { actorType: "user", actorId: "board-example", grantedPermission }, body: { confirmed: true, requestId: "request-example-1", grantedPermission: "agents:create", actor: { grantedPermission: "agents:create" } } }));
      assert.equal(response.status, 403);
    }
  } finally { await f.db.close(); }
});
test("data handlers require host company, reject tampering, hide unauthorized UI, and register every hook key", async () => {
  const f = await fixture();
  try {
    await plugin.definition.setup(f.ctx);
    assert.deepEqual([...f.handlers.keys()].sort(), ["roster.list", "roster.visible", "roster.widget"]);
    await assert.rejects(bridgeCompany(f.ctx, { companyId: "11111111-1111-4111-8111-111111111111" }), /host-verified/);
    await assert.rejects(bridgeCompany(f.ctx, { companyId: "22222222-2222-4222-8222-222222222222", hostScope: { companyId: "11111111-1111-4111-8111-111111111111" } }), /host-verified/);
    await assert.rejects(f.handlers.get("roster.list")!({ hostScope: { companyId: "22222222-2222-4222-8222-222222222222" } }), /not enabled/);
    assert.deepEqual(await f.handlers.get("roster.visible")!({ hostScope: { companyId: "22222222-2222-4222-8222-222222222222" } }), { visible: false });
    assert.deepEqual(await f.handlers.get("roster.widget")!({ hostScope: { companyId: "22222222-2222-4222-8222-222222222222" } }), { visible: false });
    const result = await f.handlers.get("roster.list")!({ companyId: "11111111-1111-4111-8111-111111111111", hostScope: { companyId: "11111111-1111-4111-8111-111111111111" } }) as { companyId: string };
    assert.equal(result.companyId, "11111111-1111-4111-8111-111111111111");
  } finally { await plugin.definition.onShutdown?.(); await f.db.close(); }
});
test("pause requires a board actor, explicit confirmation and an agent belonging to the authorized company", async () => {
  const f = await fixture();
  try {
    for (const patch of [
      { actor: { actorType: "agent" as const, actorId: "agent-example" } },
      { companyId: "22222222-2222-4222-8222-222222222222", body: { confirmed: true, requestId: "request-example-1", companyId: "11111111-1111-4111-8111-111111111111" } },
    ]) assert.equal((await handleApiRequest(f.ctx, input(patch))).status, 403);
    assert.equal((await handleApiRequest(f.ctx, input({ body: { confirmed: false, requestId: "request-example-1" } }))).status, 400);
    assert.equal((await handleApiRequest(f.ctx, input({ params: { agentId: "bbbbbbbb-0000-4000-8000-000000000001" } }))).status, 404);
    assert.equal((await handleApiRequest(f.ctx, input({ params: { agentId: "aaaaaaaa-0000-4000-8000-000000000005" } }))).status, 409);
    await f.db.exec("UPDATE agents SET status = 'pending_approval' WHERE id = 'aaaaaaaa-0000-4000-8000-000000000003'");
    assert.equal((await handleApiRequest(f.ctx, input({ params: { agentId: "aaaaaaaa-0000-4000-8000-000000000003" } }))).status, 409);
    assert.equal(f.entries.length, 0);
    assert.equal((await f.ctx.agents.get("aaaaaaaa-0000-4000-8000-000000000001", "11111111-1111-4111-8111-111111111111"))?.status, "idle");
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
    await f.db.exec("UPDATE agents SET status = 'idle' WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001'");
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
    assert.equal((await f.ctx.agents.get("aaaaaaaa-0000-4000-8000-000000000001", "11111111-1111-4111-8111-111111111111"))?.status, "idle");
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
  assert.equal(manifest.capabilities.includes("database.namespace.write"), true);
  assert.equal(manifest.database?.namespaceSlug, "roster");
});

test("widget obtains its company route from scoped host data when Morning Brief supplies no prefix", async () => {
  const f = await fixture();
  try {
    await plugin.definition.setup(f.ctx);
    const widget = await f.handlers.get("roster.widget")!({ hostScope: { companyId: "11111111-1111-4111-8111-111111111111" } }) as { companyId: string; companyPrefix: string };
    assert.equal(widget.companyId, "11111111-1111-4111-8111-111111111111");
    assert.equal(widget.companyPrefix, "EXA");
    await assert.rejects(readCompanyPrefix(f.ctx, "22222222-2222-4222-8222-222222222222"), /not enabled/);
    await f.db.exec("DELETE FROM companies WHERE id = '11111111-1111-4111-8111-111111111111'");
    await assert.rejects(readCompanyPrefix(f.ctx, "11111111-1111-4111-8111-111111111111"), /route prefix/);
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
