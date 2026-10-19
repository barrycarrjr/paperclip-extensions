import assert from "node:assert/strict";
import test from "node:test";
import { DAY_MS, ROSTER_THRESHOLDS, verdict, type RosterRow } from "./roster.js";

const now = Date.parse("2026-10-18T00:00:00Z");
function row(patch: Partial<RosterRow> = {}): RosterRow {
  return { id: "example", name: "Example", role: "engineer", status: "idle", createdAt: new Date(now - 100 * DAY_MS).toISOString(), lastHeartbeatAt: null, lastRunAt: null, runs30: 0, runs90: 0, openIssues: 0, costCents30: 0, verdict: "Idle", ...patch };
}
test("new agents are never flagged, even without runs or assigned work", () => {
  assert.equal(verdict(row({ createdAt: new Date(now - 7 * DAY_MS + 1).toISOString() }), now), "New");
  assert.equal(verdict(row({ createdAt: new Date(now).toISOString(), runs30: 8 }), now), "New");
  assert.equal(verdict(row({ createdAt: new Date(now - 7 * DAY_MS).toISOString() }), now), "Idle");
  assert.equal(ROSTER_THRESHOLDS.idleDays, 30);
});
test("idle precedes assigned work, while recent heartbeat and exact run boundaries prevent false idle flags", () => {
  assert.equal(verdict(row({ openIssues: 3 }), now), "Idle");
  assert.equal(verdict(row({ runs30: 1 }), now), "Low use");
  assert.equal(verdict(row({ lastHeartbeatAt: new Date(now - 30 * DAY_MS + 1).toISOString() }), now), "Low use");
  assert.equal(verdict(row({ lastHeartbeatAt: new Date(now - 30 * DAY_MS).toISOString() }), now), "Idle");
});
test("low use requires both fewer than four runs and no assigned open issues", () => {
  assert.equal(verdict(row({ runs30: 3 }), now), "Low use");
  assert.equal(verdict(row({ runs30: 4 }), now), "Active");
  assert.equal(verdict(row({ runs30: 1, openIssues: 1 }), now), "Active");
});
