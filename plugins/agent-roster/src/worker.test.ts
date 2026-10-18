import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Agent } from "@paperclipai/plugin-sdk";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "./manifest.js";
import plugin from "./worker.js";
import type { Roster, RosterSummary } from "./roster.js";

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
    CREATE TABLE public.agents (id uuid PRIMARY KEY, company_id uuid NOT NULL, name text NOT NULL, role text NOT NULL, title text, status text NOT NULL, created_at timestamptz NOT NULL);
    CREATE TABLE public.heartbeat_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, agent_id uuid NOT NULL, started_at timestamptz);
    CREATE TABLE public.cost_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, agent_id uuid NOT NULL, cost_cents integer NOT NULL, occurred_at timestamptz NOT NULL);
    CREATE TABLE public.issues (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, assignee_agent_id uuid, status text NOT NULL);
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
      ('${busyAgent}', '${companyA}', 'Busy', 'general', NULL, 'idle', now() - interval '60 days'),
      ('${idleAgent}', '${companyA}', 'Sleepy', 'general', 'Researcher', 'idle', now() - interval '60 days'),
      ('${otherCompanyAgent}', '${companyB}', 'Elsewhere', 'general', NULL, 'idle', now() - interval '60 days');
    INSERT INTO public.heartbeat_runs (company_id, agent_id, started_at)
      SELECT '${companyA}', '${busyAgent}', now() - (n || ' days')::interval FROM generate_series(1, 5) AS n;
    INSERT INTO public.heartbeat_runs (company_id, agent_id, started_at) VALUES ('${companyA}', '${idleAgent}', now() - interval '45 days');
    INSERT INTO public.cost_events (company_id, agent_id, cost_cents, occurred_at) VALUES
      ('${companyA}', '${busyAgent}', 120, now() - interval '2 days'),
      ('${companyA}', '${busyAgent}', 81, now() - interval '3 days'),
      ('${companyA}', '${idleAgent}', 999, now() - interval '40 days');
    INSERT INTO public.issues (company_id, assignee_agent_id, status) VALUES
      ('${companyA}', '${busyAgent}', 'todo'), ('${companyA}', '${busyAgent}', 'done');
  `);
});

async function start(allowedCompanies: string[] = [companyA]): Promise<TestHarness> {
  // agents.read is only for the tests' own status checks; the plugin does not declare it.
  const capabilities = [...manifest.capabilities, "agents.read" as const];
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
  return harness.getData<{ roster: Roster; canPause: boolean }>("roster.list", caller);
}

test("lists only the company's own agents, with runs, cost and open issues", async () => {
  const harness = await start();
  const { roster, canPause } = await list(harness);

  assert.equal(canPause, false);
  assert.deepEqual(roster.rows.map((row) => [row.name, row.verdict, row.runsLast30Days, row.runsLast90Days, row.costCentsLast30Days, row.openIssues]), [
    ["Sleepy", "idle", 0, 1, 0, 0],
    ["Busy", "active", 5, 5, 201, 1],
  ]);
  assert.deepEqual(roster.summary, { agentCount: 2, idleCount: 1, lowUseCount: 0, keptCount: 0, flaggedCostCentsLast30Days: 0 });
});

test("takes the company from hostScope, never from the page's params", async () => {
  const harness = await start([companyA, companyB]);
  const { roster } = await list(harness, { ...MEMBER, companyId: companyB } as typeof MEMBER);
  assert.ok(roster.rows.every((row) => row.name !== "Elsewhere"));
});

test("shows nothing to a company that is not allowed, and refuses its actions", async () => {
  const harness = await start([companyB]);
  assert.deepEqual(await harness.getData("roster.sidebar-visible", MEMBER), { visible: false });
  assert.deepEqual(await harness.getData("roster.summary", MEMBER), { enabled: false });
  await assert.rejects(list(harness), /not enabled for this company/);
  await assert.rejects(harness.performAction("roster.keep-agent", { ...ADMIN, agentId: idleAgent, note: "x" }), /not enabled/);
});

test("refuses a call without hostScope, as an agent's call would arrive", async () => {
  const harness = await start();
  await assert.rejects(harness.getData("roster.list", { companyId: companyA }), /not enabled/);
});

test("lets only an instance admin pause, and logs it", async () => {
  const harness = await start();
  await assert.rejects(harness.performAction("roster.pause-agent", { ...MEMBER, agentId: idleAgent }), /Only an instance admin/);

  const result = await harness.performAction("roster.pause-agent", { ...ADMIN, agentId: idleAgent });

  assert.deepEqual(result, { agentId: idleAgent, status: "paused", alreadyPaused: false });
  assert.equal((await harness.ctx.agents.get(idleAgent, companyA))?.status, "paused");
  assert.equal(harness.activity.length, 1);
  assert.equal(harness.activity[0]?.entityId, idleAgent);
  assert.equal((harness.activity[0]?.metadata as Record<string, unknown>).requestedByUserId, "admin-1");
});

test("will not pause an agent of another company", async () => {
  const harness = await start([companyA, companyB]);
  await assert.rejects(harness.performAction("roster.pause-agent", { ...ADMIN, agentId: otherCompanyAgent }), /not in this company/);
  assert.equal((await harness.ctx.agents.get(otherCompanyAgent, companyB))?.status, "idle");
});

test("a keep mark needs a note, moves the agent to kept, and can be removed", async () => {
  const harness = await start();
  await assert.rejects(harness.performAction("roster.keep-agent", { ...MEMBER, agentId: idleAgent, note: "  " }), /Say why/);

  await harness.performAction("roster.keep-agent", { ...MEMBER, agentId: idleAgent, note: "Seasonal: tax time only" });
  let { roster } = await list(harness);
  const kept = roster.rows.find((row) => row.agentId === idleAgent)!;
  assert.equal(kept.verdict, "kept");
  assert.equal(kept.keep?.note, "Seasonal: tax time only");
  assert.equal(kept.keep?.markedBy, "member-1");
  assert.equal(roster.summary.idleCount, 0);

  await harness.performAction("roster.unkeep-agent", { ...MEMBER, agentId: idleAgent });
  ({ roster } = await list(harness));
  assert.equal(roster.rows.find((row) => row.agentId === idleAgent)?.verdict, "idle");
  assert.deepEqual(harness.activity.map((entry) => (entry.metadata as Record<string, unknown>).action), ["roster.keep-agent", "roster.unkeep-agent"]);
});

test("the widget summary counts idle agents for the dashboard", async () => {
  const harness = await start();
  const summary = await harness.getData<{ enabled: true; summary: RosterSummary }>("roster.summary", MEMBER);
  assert.equal(summary.enabled, true);
  assert.equal(summary.summary.idleCount, 1);
});
