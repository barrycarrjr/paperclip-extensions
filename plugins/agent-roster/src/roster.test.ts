import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRoster, usageOf, type RosterStats } from "./roster.js";

const NOW = new Date("2026-10-18T12:00:00.000Z");
const daysBefore = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

function agent(overrides: Partial<RosterStats>): RosterStats {
  return {
    agentId: "agent",
    name: "Agent",
    role: "general",
    title: null,
    status: "idle",
    createdAt: daysBefore(60),
    lastRunAt: daysBefore(1),
    runsLast30Days: 10,
    runsLast90Days: 30,
    costCentsLast30Days: 0,
    openIssues: 0,
    keep: null,
    ...overrides,
  };
}

test("calls an agent idle after 30 days without a run, the same rule as structural findings", () => {
  assert.equal(usageOf(agent({ lastRunAt: daysBefore(31) }), NOW), "idle");
  assert.equal(usageOf(agent({ lastRunAt: null }), NOW), "idle");
  assert.equal(usageOf(agent({ lastRunAt: daysBefore(29) }), NOW), "active");
});

test("never judges an agent created in the last 7 days", () => {
  assert.equal(usageOf(agent({ createdAt: daysBefore(3), lastRunAt: null, runsLast30Days: 0 }), NOW), "new");
  assert.equal(usageOf(agent({ createdAt: daysBefore(8), lastRunAt: null, runsLast30Days: 0 }), NOW), "idle");
});

test("calls an agent low use at 3 runs or fewer in 30 days, unless it has open issues", () => {
  assert.equal(usageOf(agent({ runsLast30Days: 3 }), NOW), "low_use");
  assert.equal(usageOf(agent({ runsLast30Days: 4 }), NOW), "active");
  assert.equal(usageOf(agent({ runsLast30Days: 1, openIssues: 2 }), NOW), "active");
});

test("a keep mark turns only a flagged agent into kept, and the summary leaves it out", () => {
  const keep = { note: "Seasonal", markedBy: "user-1", markedAt: daysBefore(2) };
  const roster = buildRoster([
    agent({ agentId: "a", name: "Idle kept", lastRunAt: null, keep, costCentsLast30Days: 500 }),
    agent({ agentId: "b", name: "Active kept", keep }),
    agent({ agentId: "c", name: "Idle", lastRunAt: null, costCentsLast30Days: 250 }),
    agent({ agentId: "d", name: "Quiet", runsLast30Days: 2, costCentsLast30Days: 100 }),
  ], NOW);

  assert.deepEqual(roster.rows.map((row) => [row.name, row.verdict]), [
    ["Idle", "idle"],
    ["Quiet", "low_use"],
    ["Idle kept", "kept"],
    ["Active kept", "active"],
  ]);
  assert.deepEqual(roster.summary, { agentCount: 4, idleCount: 1, lowUseCount: 1, keptCount: 1, flaggedCostCentsLast30Days: 350 });
});
