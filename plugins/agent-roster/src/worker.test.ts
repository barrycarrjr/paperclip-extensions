import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Agent } from "@paperclipai/plugin-sdk";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "./manifest.js";
import plugin from "./worker.js";
import type { RosterData } from "./roster.js";

const namespace = "plugin_roster_6cd9f5bcfd";
const companyA = "11111111-1111-4111-8111-111111111111";
const companyB = "22222222-2222-4222-8222-222222222222";
const busyAgent = "aaaaaaaa-0000-4000-8000-000000000001";
const idleAgent = "aaaaaaaa-0000-4000-8000-000000000002";
const otherCompanyAgent = "bbbbbbbb-0000-4000-8000-000000000001";
const ADMIN = { hostScope: { companyId: companyA, userId: "admin-1", isInstanceAdmin: true } };
const MEMBER = { hostScope: { companyId: companyA, userId: "member-1", isInstanceAdmin: false } };

let pg: PGlite;

before(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE public.agents (id uuid PRIMARY KEY, company_id uuid NOT NULL, name text NOT NULL, role text NOT NULL, title text, status text NOT NULL, created_at timestamptz NOT NULL, last_heartbeat_at timestamptz);
    CREATE TABLE public.heartbeat_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, agent_id uuid NOT NULL, started_at timestamptz);
    CREATE TABLE public.cost_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, agent_id uuid NOT NULL, cost_cents integer NOT NULL, occurred_at timestamptz NOT NULL);
    CREATE TABLE public.issues (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, assignee_agent_id uuid, status text NOT NULL, hidden_at timestamptz);
    CREATE TABLE public.companies (id uuid PRIMARY KEY, issue_prefix text);
    INSERT INTO public.companies VALUES ('11111111-1111-4111-8111-111111111111', 'EXA'), ('22222222-2222-4222-8222-222222222222', 'OTHER');
    CREATE SCHEMA ${namespace};
  `);
  await pg.exec(await readFile(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
});

after(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`
    DELETE FROM public.agents; DELETE FROM public.heartbeat_runs; DELETE FROM public.cost_events;
    DELETE FROM public.issues; DELETE FROM ${namespace}.keep_marks;
    INSERT INTO public.agents VALUES
      ('${busyAgent}', '${companyA}', 'Busy', 'general', NULL, 'idle', now() - interval '60 days', NULL),
      ('${idleAgent}', '${companyA}', 'Sleepy', 'general', 'Researcher', 'idle', now() - interval '60 days', NULL),
      ('${otherCompanyAgent}', '${companyB}', 'Elsewhere', 'general', NULL, 'idle', now() - interval '60 days', NULL);
    INSERT INTO public.heartbeat_runs (company_id, agent_id, started_at)
      SELECT '${companyA}', '${busyAgent}', now() - (n || ' days')::interval FROM generate_series(1, 5) AS n;
    INSERT INTO public.heartbeat_runs (company_id, agent_id, started_at) VALUES ('${companyA}', '${idleAgent}', now() - interval '45 days');
    INSERT INTO public.cost_events (company_id, agent_id, cost_cents, occurred_at) VALUES
      ('${companyA}', '${busyAgent}', 120, now() - interval '2 days'),
      ('${companyA}', '${busyAgent}', 81, now() - interval '3 days'),
      ('${companyA}', '${idleAgent}', 999, now() - interval '40 days');
    INSERT INTO public.issues (company_id, assignee_agent_id, status, hidden_at) VALUES
      ('${companyA}', '${busyAgent}', 'todo', NULL), ('${companyA}', '${busyAgent}', 'done', NULL);
  `);
});

async function start(allowedCompanies: string[] = [companyA]): Promise<TestHarness> {
  const capabilities = [...manifest.capabilities];
  const harness = createTestHarness({ manifest, capabilities, config: { allowedCompanies } });
  harness.ctx.db = {
    namespace,
    async query<T>(sql: string, params: unknown[] = []) { return (await pg.query<T>(sql, params)).rows; },
    async execute(sql: string, params: unknown[] = []) { return { rowCount: (await pg.query(sql, params)).affectedRows ?? 0 }; },
  };
  harness.seed({
    agents: [
      { id: busyAgent, companyId: companyA, name: "Busy", status: "idle" },
      { id: idleAgent, companyId: companyA, name: "Sleepy", status: "idle" },
      { id: otherCompanyAgent, companyId: companyB, name: "Elsewhere", status: "idle" },
    ] as unknown as Agent[],
  });
  await plugin.definition.setup(harness.ctx);
  return harness;
}

async function list(harness: TestHarness, caller = MEMBER) {
  const roster = await harness.getData<RosterData>("roster.list", caller);
  return { roster, canPause: roster.canPause };
}

test("lists only the company's own agents, with runs, cost and open issues", async () => {
  const harness = await start();
  const { roster, canPause } = await list(harness);

  assert.equal(canPause, false);
  assert.deepEqual(roster.rows.map((row) => [row.name, row.verdict, row.runs30, row.runs90, row.costCents30, row.openIssues]), [
    ["Sleepy", "Idle", 0, 1, 0, 0],
    ["Busy", "Active", 5, 5, 201, 1],
  ]);
  assert.equal(roster.idleCount, 1);
  assert.equal(roster.idleCostCents30, 0);
});

test("takes the company from hostScope, never from the page's params", async () => {
  const harness = await start([companyA, companyB]);
  await assert.rejects(list(harness, { ...MEMBER, companyId: companyB } as typeof MEMBER), /host-verified/);
  const { roster } = await list(harness);
  assert.ok(roster.rows.every((row) => row.name !== "Elsewhere"));
});

test("shows nothing to a company that is not allowed, and refuses its actions", async () => {
  const harness = await start([companyB]);
  assert.deepEqual(await harness.getData("roster.visible", MEMBER), { visible: false });
  assert.deepEqual(await harness.getData("roster.widget", MEMBER), { visible: false });
  await assert.rejects(list(harness), /not enabled for this company/);
  await assert.rejects(harness.performAction("roster.keep-agent", { ...ADMIN, agentId: idleAgent, note: "x" }), /not enabled/);
});

test("refuses a call without hostScope, as an agent's call would arrive", async () => {
  const harness = await start();
  await assert.rejects(harness.getData("roster.list", { companyId: companyA }), /host-verified/);
});

test("lets only an instance admin pause, and logs it", async () => {
  const harness = await start();
  await assert.rejects(harness.performAction("roster.pause-agent", { ...MEMBER, agentId: idleAgent, confirmed: true, requestId: "request-example-14" }), /Only an instance admin/);

  const result = await harness.performAction("roster.pause-agent", { ...ADMIN, agentId: idleAgent, confirmed: true, requestId: "request-example-14" });

  assert.deepEqual(result, { paused: true });
  assert.equal((await harness.ctx.agents.get(idleAgent, companyA))?.status, "paused");
  assert.equal(harness.activity.length, 2);
  assert.equal(harness.activity[0]?.entityId, idleAgent);
  assert.equal((harness.activity[0]?.metadata as Record<string, unknown>).requestedByUserId, "admin-1");
});

test("will not pause an agent of another company", async () => {
  const harness = await start([companyA, companyB]);
  await assert.rejects(harness.performAction("roster.pause-agent", { ...ADMIN, agentId: otherCompanyAgent, confirmed: true, requestId: "request-example-14" }), /not found in this company/);
  assert.equal((await harness.ctx.agents.get(otherCompanyAgent, companyB))?.status, "idle");
});

test("a keep mark needs a note, moves the agent to kept, and can be removed", async () => {
  const harness = await start();
  await assert.rejects(harness.performAction("roster.keep-agent", { ...MEMBER, agentId: idleAgent, note: "  " }), /Say why/);

  await harness.performAction("roster.keep-agent", { ...MEMBER, agentId: idleAgent, note: "Seasonal: tax time only" });
  let { roster } = await list(harness);
  const kept = roster.rows.find((row) => row.id === idleAgent)!;
  assert.equal(kept.verdict, "Kept on purpose");
  assert.equal(kept.keep?.note, "Seasonal: tax time only");
  assert.equal(kept.keep?.markedBy, "member-1");
  assert.equal(roster.idleCount, 0);

  await harness.performAction("roster.unkeep-agent", { ...MEMBER, agentId: idleAgent });
  ({ roster } = await list(harness));
  assert.equal(roster.rows.find((row) => row.id === idleAgent)?.verdict, "Idle");
  assert.deepEqual(harness.activity.filter((entry) => entry.message.endsWith("completed")).map((entry) => (entry.metadata as Record<string, unknown>).action), ["roster.keep-agent", "roster.unkeep-agent"]);
});

test("the widget summary counts idle agents for the dashboard", async () => {
  const harness = await start();
  const summary = await harness.getData<{ visible: true; idleCount: number }>("roster.widget", MEMBER);
  assert.equal(summary.visible, true);
  assert.equal(summary.idleCount, 1);
});

test("pending agents can be kept and unkept without approval, runs or costs changing", async () => {
  await pg.query("UPDATE public.agents SET status = 'pending_approval' WHERE id = $1", [idleAgent]);
  await pg.query("INSERT INTO public.cost_events (company_id, agent_id, cost_cents, occurred_at) VALUES ($1, $2, 250, now() - interval '1 day')", [companyA, idleAgent]);
  const harness = await start();
  harness.seed({ agents: [{ id: idleAgent, companyId: companyA, name: "Example pending", status: "pending_approval" }] as unknown as Agent[] });
  const pending = () => harness.ctx.agents.get(idleAgent, companyA);
  const getRow = async () => (await list(harness)).roster.rows.find((row) => row.id === idleAgent)!;
  const initial = await getRow();
  assert.equal(initial.verdict, "Idle");
  assert.equal(initial.status, "pending_approval");
  assert.equal(initial.costCents30, 250);
  assert.equal((await harness.getData<{ idleCount: number }>("roster.widget", MEMBER)).idleCount, 1);
  await assert.rejects(harness.performAction("roster.pause-agent", { ...ADMIN, agentId: idleAgent, confirmed: true, requestId: "example-pending-pause" }), /cannot be paused/);
  assert.equal(harness.activity.length, 0);

  await harness.performAction("roster.keep-agent", { ...MEMBER, agentId: idleAgent, note: "Example future seasonal work" });
  const kept = await getRow();
  assert.equal(kept.verdict, "Kept on purpose");
  assert.equal(kept.keep?.note, "Example future seasonal work");
  assert.equal(kept.status, "pending_approval");
  assert.equal((await pending())?.status, "pending_approval");
  assert.deepEqual([kept.runs30, kept.runs90, kept.costCents30], [initial.runs30, initial.runs90, initial.costCents30]);
  assert.equal((await harness.getData<{ visible: boolean }>("roster.widget", MEMBER)).visible, false);
  await harness.performAction("roster.unkeep-agent", { ...MEMBER, agentId: idleAgent });
  const unkept = await getRow();
  assert.equal(unkept.verdict, "Idle");
  assert.equal(unkept.keep, null);
  assert.equal((await pending())?.status, "pending_approval");
  assert.deepEqual([unkept.status, unkept.runs30, unkept.runs90, unkept.costCents30], [initial.status, initial.runs30, initial.runs90, initial.costCents30]);
  assert.equal((await harness.getData<{ idleCount: number }>("roster.widget", MEMBER)).idleCount, 1);
  assert.deepEqual(harness.activity.map((entry) => entry.message), ["agent_roster.keep_requested", "agent_roster.keep_completed", "agent_roster.unkeep_requested", "agent_roster.unkeep_completed"]);
});

test("a pending agent's deployed keep mark remains visible and removable", async () => {
  await pg.query("UPDATE public.agents SET status = 'pending_approval' WHERE id = $1", [idleAgent]);
  await pg.query(`INSERT INTO ${namespace}.keep_marks VALUES ($1, $2, 'Example old pending mark', 'board-before-upgrade', '2026-10-01Z')`, [companyA, idleAgent]);
  const harness = await start();
  harness.seed({ agents: [{ id: idleAgent, companyId: companyA, name: "Example pending", status: "pending_approval" }] as unknown as Agent[] });
  const kept = (await list(harness)).roster.rows.find((row) => row.id === idleAgent)!;
  assert.equal(kept.verdict, "Kept on purpose");
  assert.equal(kept.keep?.note, "Example old pending mark");
  await harness.performAction("roster.unkeep-agent", { ...MEMBER, agentId: idleAgent });
  assert.equal((await list(harness)).roster.rows.find((row) => row.id === idleAgent)?.verdict, "Idle");
  assert.equal((await harness.ctx.agents.get(idleAgent, companyA))?.status, "pending_approval");
  assert.equal((await pg.query(`SELECT * FROM ${namespace}.keep_marks`)).rows.length, 0);
});
