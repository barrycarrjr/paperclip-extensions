import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentRosterPage, AgentRosterSidebar, AgentRosterWidget, HandOffNotice, IdleWidget, KeepConfirmation, PauseConfirmation, RosterTable } from "./index.js";
import { loadHandOff, newPauseRequestId, pauseAgent, setKept } from "./api.js";
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
  const html = render(createElement(RosterTable, { rows: [row], prefix: "example-company", onPause() {}, canPause: true, handoff: { links: [{ jobId: "job-a", title: "Example recurring job", hostRunId: "run-a", hostAgentId: "agent-a" }], notice: null } }));
  for (const label of ["Example &lt;agent&gt;", "Runs, 30 days", "Runs, 90 days", "$2.00", "Open issues", "Idle", "Never", "Pause", "Example recurring job"]) assert.ok(html.includes(label), label);
  assert.match(html, /href="\/example-company\/agents\/agent-a\/runs\/run-a"/);
  assert.match(html, /href="\/example-company\/agents\/agent-a"/);
  assert.doesNotMatch(html, /<agent>/);
  const paused = render(createElement(RosterTable, { rows: [{ ...row, status: "paused" }], prefix: null, onPause() {}, canPause: true, handoff: { links: [], notice: "Unavailable" } }));
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
test("pause client sends explicit confirmation and a stable retry ID to the host-stamped admin action", async () => {
  const fetcher: typeof fetch = async (url, options) => {
    assert.equal(String(url), "/api/plugins/agent-roster/actions/roster.pause-agent");
    assert.equal(options?.method, "POST"); assert.equal(options?.credentials, "include");
    assert.deepEqual(JSON.parse(String(options?.body)), { companyId: "company-a", params: { agentId: "agent-a", confirmed: true, requestId: "request-example-1" } });
    return respond({ data: { paused: true } })(url, options);
  };
  await pauseAgent("company-a", "agent-a", "request-example-1", fetcher);
  await assert.rejects(pauseAgent("company-a", "agent-a", "request-example-1", respond({ error: "Agent is paused, completion logging failed" }, 502)), /completion logging failed/);
  await assert.rejects(pauseAgent("company-a", "agent-a", "request-example-1", respond({ code: "WORKER_ERROR", message: "Agent is paused, but completion logging failed. Retry with the same request ID." }, 502)), /Agent is paused/);
  await assert.rejects(pauseAgent("company-a", "agent-a", "request-example-1", respond({})), /unreadable/);
});

test("kept rows retain evidence, escaped notes and Unkeep; nonadmin board still has Keep but no Pause", () => {
  const kept = { ...row, verdict: "Kept on purpose" as const, keep: { note: "Example <seasonal> note", markedBy: "board-example", markedAt: "2026-10-18Z" } };
  const html = render(createElement(RosterTable, { rows: [kept], prefix: "EXA", handoff: { links: [], notice: null }, canPause: false, onPause() {}, onKeep() {}, onUnkeep() {} }));
  for (const text of ["Kept on purpose", "Keep note: Example &lt;seasonal&gt; note", "$2.00", "Edit keep note", "Unkeep", "Open agent"]) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, />Pause<|<seasonal>/);
  const flagged = render(createElement(RosterTable, { rows: [row], prefix: "EXA", handoff: null, onPause() {}, onKeep() {} }));
  assert.match(flagged, />Keep</);
  assert.doesNotMatch(flagged, />Pause</);
});

test("Keep form requires a bounded note and shows errors and theme tokens", () => {
  const html = render(createElement(KeepConfirmation, { name: "Example agent", note: "", busy: false, error: "Example save outage", onNote() {}, onCancel() {}, onConfirm() {} }));
  assert.match(html, /required=""/);
  assert.match(html, /maxLength="500"/i);
  assert.match(html, /disabled=""[^>]*>Save keep note/);
  assert.match(html, /role="alert"[^>]*>Example save outage/);
  assert.match(html, /var\(--background\)/);
  assert.match(html, /var\(--foreground\)/);
});

test("Keep and Unkeep clients carry the selected company and disclose partial-save errors", async () => {
  for (const kept of [true, false]) {
    await setKept("company-a", "agent-a", kept, "Example note", async (url, options) => {
      assert.equal(String(url), `/api/plugins/agent-roster/actions/roster.${kept ? "keep" : "unkeep"}-agent`);
      assert.deepEqual(JSON.parse(String(options?.body)), { companyId: "company-a", params: { agentId: "agent-a", ...(kept ? { note: "Example note" } : {}) } });
      return respond({ data: { kept } })(url, options);
    });
  }
  await assert.rejects(setKept("company-a", "agent-a", true, "Example", respond({ error: "Keep decision saved, but completion logging failed" }, 502)), /decision saved/);
  await assert.rejects(setKept("company-a", "agent-a", true, "Example", respond({ code: "WORKER_ERROR", message: "Keep decision saved, but completion logging failed" }, 502)), /decision saved/);
  await assert.rejects(setKept("company-a", "agent-a", true, "Example", respond({})), /unreadable/);
});

test("pending rows offer Keep and existing-note actions while Pause stays disabled", () => {
  const pending = { ...row, status: "pending_approval" };
  const props = { prefix: "EXA", handoff: null, canPause: true, onPause() {}, onKeep() {}, onUnkeep() {} };
  const html = render(createElement(RosterTable, { ...props, rows: [pending] }));
  assert.match(html, />Keep</);
  assert.match(html, /disabled=""[^>]*>Pause/);
  const kept = render(createElement(RosterTable, { ...props, rows: [{ ...pending, verdict: "Kept on purpose", keep: { note: "Example old pending note", markedBy: "board-example", markedAt: "2026-10-18Z" } }] }));
  for (const label of ["Edit keep note", "Unkeep", "Example old pending note", "$2.00"]) assert.ok(kept.includes(label), label);
  assert.match(kept, /disabled=""[^>]*>Pause/);
  const terminated = render(createElement(RosterTable, { ...props, rows: [{ ...pending, status: "terminated" }] }));
  assert.doesNotMatch(terminated, />Keep<|>Unkeep</);
});
