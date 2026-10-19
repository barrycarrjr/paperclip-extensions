import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentRosterPage, AgentRosterSidebar, AgentRosterWidget, HandOffNotice, IdleWidget, PauseConfirmation, RosterTable } from "./index.js";
import { loadHandOff, newPauseRequestId, pauseAgent } from "./api.js";
import type { RosterRow } from "../roster.js";

const row: RosterRow = { id: "agent-a", name: "Example <agent>", role: "engineer", status: "idle", createdAt: "2026-01-01Z", lastRunAt: null, lastHeartbeatAt: null, runs30: 0, runs90: 2, costCents30: 200, openIssues: 0, verdict: "Idle" };
const render = (component: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(component);

test("pause request IDs work without randomUUID on plain HTTP and without Web Crypto", () => {
  const withoutUuid = { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) };
  const first = newPauseRequestId(withoutUuid);
  const second = newPauseRequestId(withoutUuid);
  assert.match(first, /^[a-zA-Z0-9-]{8,80}$/);
  assert.notEqual(first, second);
  assert.match(newPauseRequestId({}), /^[a-zA-Z0-9-]{8,80}$/);
});
test("roster renders every column, escaped names, company links and host run provenance", () => {
  const html = render(createElement(RosterTable, { rows: [row], prefix: "example-company", onPause() {}, handoff: { links: [{ jobId: "job-a", title: "Example recurring job", hostRunId: "run-a", hostAgentId: "agent-a" }], notice: null } }));
  for (const label of ["Example &lt;agent&gt;", "Runs, 30 days", "Runs, 90 days", "$2.00", "Open issues", "Idle", "Never", "Pause", "Example recurring job"]) assert.ok(html.includes(label), label);
  assert.match(html, /href="\/example-company\/agents\/agent-a\/runs\/run-a"/);
  assert.match(html, /href="\/example-company\/agents\/agent-a"/);
  assert.doesNotMatch(html, /<agent>/);
  const paused = render(createElement(RosterTable, { rows: [{ ...row, status: "paused" }], prefix: null, onPause() {}, handoff: { links: [], notice: "Unavailable" } }));
  assert.match(paused, /disabled=""[^>]*>Pause/);
  assert.match(paused, /Unavailable/);
  assert.doesNotMatch(paused, /No recorded production jobs/);
});
test("widget displays idle cost and hides zero counts and stale cross-company responses", () => {
  const data = { companyId: "company-a", companyPrefix: "EXA", visible: true, idleCount: 1, idleCostCents30: 200 };
  assert.match(render(createElement(IdleWidget, { data, companyId: "company-a", prefix: null })), /1 idle agent, \$2.00 in the last 30 days/);
  assert.match(render(createElement(IdleWidget, { data, companyId: "company-a", prefix: null })), /href="\/EXA\/agent-roster"/);
  assert.match(render(createElement(IdleWidget, { data: { ...data, companyPrefix: null }, companyId: "company-a", prefix: null })), /role="alert"/);
  assert.equal(render(createElement(IdleWidget, { data: { ...data, idleCount: 0 }, companyId: "company-a", prefix: null })), "");
  assert.equal(render(createElement(IdleWidget, { data, companyId: "company-b", prefix: null })), "");
});
test("confirmation describes reversible impact, cancellation and errors; busy disables duplicate submissions", () => {
  const html = render(createElement(PauseConfirmation, { name: "Example agent", busy: true, error: "Example logging outage", onCancel() {}, onConfirm() {} }));
  assert.match(html, /role="alertdialog"/); assert.match(html, /resume the agent/); assert.match(html, /Cancel/);
  assert.match(html, /autofocus=""/);
  assert.match(html, /var\(--card\)/); assert.match(html, /var\(--card-foreground\)/);
  assert.match(html, /role="alert"[^>]*>Example logging outage/);
  assert.match(html, /disabled=""[^>]*>Pausing/);
});
test("page, sidebar and dashboard surface hook errors; disallowed companies render no UI", () => {
  const global = globalThis as unknown as { __paperclipPluginBridge__?: unknown };
  const previous = global.__paperclipPluginBridge__;
  let denied = false;
  let stale = false;
  global.__paperclipPluginBridge__ = { sdkUi: {
    useHostContext: () => ({ companyId: "company-a", companyPrefix: "example-company" }),
    usePluginData: () => stale ? { loading: false, data: { visible: true, companyId: "company-b" }, error: null } : denied ? { loading: false, data: { visible: false }, error: null } : { loading: false, error: { message: "Example worker outage" } },
  } };
  try {
    for (const component of [AgentRosterPage, AgentRosterSidebar, AgentRosterWidget]) assert.match(render(createElement(component)), /Example worker outage/);
    denied = true;
    for (const component of [AgentRosterPage, AgentRosterSidebar, AgentRosterWidget]) assert.equal(render(createElement(component)), "");
    stale = true;
    for (const component of [AgentRosterPage, AgentRosterSidebar, AgentRosterWidget]) assert.equal(render(createElement(component)), "");
  } finally { global.__paperclipPluginBridge__ = previous; }
});
const respond = (payload: unknown, status = 200): typeof fetch => async () => new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
test("Hand-off maps only production hostAgentId and deduplicates each job/agent; no inferred skill ownership", async () => {
  let requested = "";
  const fetcher: typeof fetch = async (url, options) => {
    requested = String(url); assert.equal(options?.credentials, "include");
    return respond({ state: { companyId: "company-a", jobs: [{ id: "job-a", companyId: "company-a", title: "Example job", skillKey: "example-skill", runs: [
      { mode: "production", hostAgentId: "agent-a", hostRunId: "old" },
      { mode: "historical", hostAgentId: "agent-h", hostRunId: "historical" },
      { mode: "production", hostAgentId: "agent-a", hostRunId: "latest" },
      { mode: "production" },
    ] }] } })(url, options);
  };
  assert.deepEqual((await loadHandOff("company-a", fetcher)).links, [{ jobId: "job-a", title: "Example job", hostAgentId: "agent-a", hostRunId: "latest" }]);
  assert.equal(requested, "/api/plugins/handoff-pipeline/api/summary?companyId=company-a");
  await assert.rejects(loadHandOff("company-a", respond({ state: { companyId: "company-b", jobs: [] } })), /mismatched/);
  await assert.rejects(loadHandOff("company-a", respond({ state: { companyId: "company-a", jobs: [{ companyId: "company-b", id: "job-b", title: "Other", runs: [] }] } })), /another company/);
});
test("optional Hand-off absence/denial is disclosed and server failures never become an empty state", async () => {
  for (const status of [403, 404]) {
    const handoff = await loadHandOff("company-a", respond({}, status));
    const html = render(createElement(HandOffNotice, { handoff }));
    assert.ok(handoff.notice);
    assert.match(html, /role="status"/);
    assert.doesNotMatch(html, /<a\b|Open Hand-off audit/);
  }
  const failed = render(createElement(HandOffNotice, { handoff: { links: [], notice: "Example summary outage" } }));
  assert.match(failed, /Example summary outage/);
  assert.doesNotMatch(failed, /<a\b/);
  assert.equal(render(createElement(HandOffNotice, { handoff: { links: [], notice: null } })), "");
  await assert.rejects(loadHandOff("company-a", respond({ error: "Example unavailable" }, 503)), /Example unavailable/);
  await assert.rejects(loadHandOff("company-a", respond({})), /invalid/);
});
test("pause client sends explicit confirmation and a stable retry ID to the scoped board API", async () => {
  const fetcher: typeof fetch = async (url, options) => {
    assert.equal(String(url), "/api/plugins/agent-roster/api/agents/agent-a/pause?companyId=company-a");
    assert.equal(options?.method, "POST"); assert.equal(options?.credentials, "include");
    assert.deepEqual(JSON.parse(String(options?.body)), { confirmed: true, requestId: "request-example-1" });
    return respond({ paused: true })(url, options);
  };
  await pauseAgent("company-a", "agent-a", "request-example-1", fetcher);
  await assert.rejects(pauseAgent("company-a", "agent-a", "request-example-1", respond({ error: "Agent is paused, completion logging failed" }, 502)), /completion logging failed/);
  await assert.rejects(pauseAgent("company-a", "agent-a", "request-example-1", respond({})), /unreadable/);
});
