import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { JobRun, RecurringJob } from "../contracts.js";
import { auditDates, handoffApi, qualificationCount, rankedJobs } from "./api.js";

function job(id: string, hours = 2): RecurringJob {
  return { id, companyId: "company-a", auditId: "audit", title: id, evidenceRefs: ["source"], occurrencesPerMonth: 2, manualMinutes: 90, agentMinutes: 30, monthlyHoursSaved: hours, skillKey: id, companySkillId: "company-skill", routineId: null, currentRevisionId: "current", revisions: [], stage: "draft", cleanStreak: 0, rewrittenStreak: 0, runsBlockedAt: null, examples: [], runs: [], createdAt: "2026-10-15T00:00:00Z", updatedAt: "2026-10-15T00:00:00Z" };
}

function run(id: string, exampleId: string, patch: Partial<JobRun> = {}): JobRun {
  return { id, idempotencyKey: id, mode: "historical", revisionId: "current", revisionHash: "hash", exampleId, sourceRef: "source", actualMinutes: null, originalOutput: "Original", startedAt: "2026-10-15T00:00:00Z", createdAt: "2026-10-15T00:05:00Z", reviewRequired: true, review: { verdict: "clean", reviewerId: "human", reviewedAt: "2026-10-15T01:00:00Z", revisedOutput: null, reason: null }, ...patch };
}

test("qualification uses distinct clean historical examples on the current revision", () => {
  const value = job("job");
  value.runs = [run("1", "a"), run("2", "a"), run("3", "b"), run("4", "c", { revisionId: "old" }), run("5", "d", { review: null }), run("6", "e", { mode: "production", exampleId: null }), run("7", "f", { review: { verdict: "rewritten", reviewerId: "human", reviewedAt: "2026-10-15T00:00:00Z", revisedOutput: "Corrected", reason: "Incomplete" } })];
  assert.equal(qualificationCount(value), 2);
  value.runs.push(run("8", "g"));
  assert.equal(qualificationCount(value), 3);
});

test("ranked jobs use saved hours with a stable tie break without mutating state", () => {
  const jobs = [job("c", 2), job("b", 5), job("a", 5)];
  assert.deepEqual(rankedJobs(jobs).map((value) => value.id), ["a", "b", "c"]);
  assert.deepEqual(jobs.map((value) => value.id), ["c", "b", "a"]);
});

test("audit dates accept both boundaries and reject periods outside 30 to 90 days", () => {
  assert.deepEqual(auditDates("2026-01-01", "2026-01-31"), { startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-01-31T00:00:00.000Z" });
  assert.equal(auditDates("2026-01-01", "2026-04-01").endAt, "2026-04-01T00:00:00.000Z");
  for (const end of ["2026-01-30", "2026-04-02", "2025-12-01", "bad-date"]) assert.throws(() => auditDates("2026-01-01", end), /30 to 90/);
  assert.throws(() => auditDates("2026-02-30", "2026-04-01"), /30 to 90/);
});

test("API requests keep company scope, encode IDs, and report server failures", async (context) => {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "https://paperclip.example" } } });
  context.after(() => { if (priorWindow) Object.defineProperty(globalThis, "window", priorWindow); else Reflect.deleteProperty(globalThis, "window"); });
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let response = new Response(JSON.stringify({ state: { jobs: [] } }), { status: 200 });
  context.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), init }); return response.clone(); });
  await handoffApi.summary("company & a");
  assert.equal(new URL(calls[0].url).searchParams.get("companyId"), "company & a");
  assert.equal(calls[0].init?.credentials, "include");
  assert.equal((calls[0].init?.headers as Record<string, string>)["Content-Type"], undefined);
  await handoffApi.retireJob("company-a", "job/other", { reason: "No longer needed" });
  assert.equal(new URL(calls[1].url).pathname, "/api/plugins/handoff-pipeline/api/jobs/job%2Fother/retire");
  assert.equal(calls[1].init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { reason: "No longer needed" });
  assert.equal((calls[1].init?.headers as Record<string, string>)["Content-Type"], "application/json");
  response = new Response(JSON.stringify({ error: "Company access denied" }), { status: 403 });
  await assert.rejects(handoffApi.summary("company-a"), /Company access denied/);
  response = new Response("unreadable", { status: 200 });
  await assert.rejects(handoffApi.summary("company-a"), /unreadable response/);
  const before = calls.length;
  await assert.rejects(handoffApi.summary(""), /Select a company/);
  assert.equal(calls.length, before);
});

test("rebuild preflights before saving and leaves ambiguous failures for safe reconciliation", async (context) => {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "https://paperclip.example" } } });
  context.after(() => { if (priorWindow) Object.defineProperty(globalThis, "window", priorWindow); else Reflect.deleteProperty(globalThis, "window"); });
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const responses = [
    new Response(JSON.stringify({ version: 7 }), { status: 200 }),
    new Response(JSON.stringify({ content: "New instructions\r\n" }), { status: 200 }),
    new Response(JSON.stringify({ error: "Pipeline changed" }), { status: 409 }),
    new Response(JSON.stringify({ state: { companyId: "company-a", version: 7, audits: [], events: [], jobs: [{ id: "job-a", currentRevisionId: "old", revisions: [{ id: "old", content: "Old instructions\n" }] }] } }), { status: 200 }),
    new Response(JSON.stringify({ content: "New instructions\r\n" }), { status: 200 }),
  ];
  context.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return responses.shift()!;
  });
  await assert.rejects(
    handoffApi.rebuildJob("company-a", "skill-a", "job-a", { skillContent: "New instructions\n", reason: "Improve accuracy", requestId: "rebuild-a" }),
    /SKILL.md was left as submitted/,
  );
  assert.equal(new URL(calls[0].url).pathname, "/api/plugins/handoff-pipeline/api/jobs/job-a/rebuild/preflight");
  assert.equal(new URL(calls[1].url).pathname, "/api/companies/company-a/skills/skill-a/files");
  assert.deepEqual(JSON.parse(String(calls[2].init?.body)), { skillContent: "New instructions\n", reason: "Improve accuracy", requestId: "rebuild-a", expectedVersion: 7 });
  assert.equal(new URL(calls[4].url).searchParams.get("path"), "SKILL.md");
  assert.equal(calls.filter((call) => call.init?.method === "PATCH").length, 1);
});

test("rebuild treats a confirmed revision as saved after an ambiguous response", async (context) => {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "https://paperclip.example" } } });
  context.after(() => { if (priorWindow) Object.defineProperty(globalThis, "window", priorWindow); else Reflect.deleteProperty(globalThis, "window"); });
  let call = 0;
  context.mock.method(globalThis, "fetch", async () => {
    call += 1;
    if (call === 1) return new Response(JSON.stringify({ version: 7 }), { status: 200 });
    if (call === 2) return new Response("{}", { status: 200 });
    if (call === 3) throw new Error("Connection closed");
    if (call === 4) return new Response(JSON.stringify({ state: { companyId: "company-a", version: 8, audits: [], events: [{ id: "rebuild-b", type: "rebuild", jobId: "job-a" }], jobs: [{ id: "job-a", currentRevisionId: "new", revisions: [{ id: "new", content: "New instructions\r\n" }] }] } }), { status: 200 });
    return new Response(JSON.stringify({ content: "New instructions\r\n" }), { status: 200 });
  });
  await handoffApi.rebuildJob("company-a", "skill-a", "job-a", { skillContent: "New instructions\n", reason: "Improve accuracy", requestId: "rebuild-b" });
  assert.equal(call, 5);
});

test("rebuild continues after a lost skill-update response only when live content confirms the write", async (context) => {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "https://paperclip.example" } } });
  context.after(() => { if (priorWindow) Object.defineProperty(globalThis, "window", priorWindow); else Reflect.deleteProperty(globalThis, "window"); });
  let call = 0;
  context.mock.method(globalThis, "fetch", async () => {
    call += 1;
    if (call === 1) return new Response(JSON.stringify({ version: 4 }), { status: 200 });
    if (call === 2) throw new Error("Connection closed after skill save");
    if (call === 3) return new Response(JSON.stringify({ content: "New instructions\r\n" }), { status: 200 });
    return new Response(JSON.stringify({ state: { version: 5 } }), { status: 200 });
  });
  await handoffApi.rebuildJob("company-a", "skill-a", "job-a", { skillContent: "New instructions\n", reason: "Improve accuracy", requestId: "rebuild-c" });
  assert.equal(call, 4);
});

test("rewritten production review reuses an idempotent correction before saving review", async (context) => {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "https://paperclip.example" } } });
  context.after(() => { if (priorWindow) Object.defineProperty(globalThis, "window", priorWindow); else Reflect.deleteProperty(globalThis, "window"); });
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const production = run("production-run", "", { mode: "production", exampleId: null, sourceIssueId: "issue-a", hostAgentId: "agent-a", hostRunId: "host-a", review: null });
  const responses = [
    new Response(JSON.stringify({ state: {} }), { status: 200 }),
    new Response(JSON.stringify({ id: "comment-a" }), { status: 200 }),
    new Response(JSON.stringify({ state: {} }), { status: 200 }),
  ];
  context.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), init }); return responses.shift()!; });
  await handoffApi.reviewRun("company-a", production, { verdict: "rewritten", revisedOutput: "Correct output", reason: "Wrong total" });
  assert.equal(new URL(calls[0].url).pathname, "/api/plugins/handoff-pipeline/api/runs/production-run/review/prepare");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { revisedOutput: "Correct output", reason: "Wrong total" });
  assert.equal(new URL(calls[1].url).pathname, "/api/issues/issue-a/comments");
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { intent: "correction", idempotencyKey: "handoff.review:production-run", expectedAssigneeAgentId: "agent-a", allowPriorAssigneeTarget: true, body: "Hand-off review correction for run production-run\n\nWrong total\n\nCorrected output:\nCorrect output" });
  assert.equal(new URL(calls[2].url).pathname, "/api/plugins/handoff-pipeline/api/runs/production-run/review");
  assert.deepEqual(JSON.parse(String(calls[2].init?.body)), { verdict: "rewritten", revisedOutput: "Correct output", reason: "Wrong total", correctionCommentId: "comment-a" });
});

test("a stored correction with blocked delivery completes review and retries delivery without another review", async (context) => {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "https://paperclip.example" } } });
  context.after(() => { if (priorWindow) Object.defineProperty(globalThis, "window", priorWindow); else Reflect.deleteProperty(globalThis, "window"); });
  const calls: { url: string; init?: RequestInit }[] = [];
  const production = run("production-run", "", { mode: "production", exampleId: null, sourceIssueId: "issue-a", hostAgentId: "agent-a", hostRunId: "host-a", review: null });
  const pending = { status: "pending", pending: [{ agentId: "agent-a", reason: "Agent is paused." }] };
  const responses = [
    { state: {} }, { id: "comment-a", correctionDelivery: pending }, { state: {} },
    { id: "comment-a", correctionDelivery: { status: "accepted", pending: [] } },
    { state: {} },
  ];
  context.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init }); return new Response(JSON.stringify(responses.shift()), { status: 200 });
  });
  await handoffApi.reviewRun("company-a", production, { verdict: "rewritten", revisedOutput: "Correct output", reason: "Wrong total" });
  assert.equal(calls.length, 3);
  assert.equal(JSON.parse(String(calls[2].init?.body)).correctionCommentId, "comment-a");
  assert.equal(JSON.parse(String(calls[2].init?.body)).correctionDelivery, undefined);
  const reloadedRun = JSON.parse(JSON.stringify({ ...production, review: { verdict: "rewritten", correctionCommentId: "comment-a", revisedOutput: "Correct output", reason: "Wrong total" }, correctionDelivery: pending }));
  await handoffApi.retryCorrectionDelivery("company-a", reloadedRun);
  assert.equal(calls.length, 5);
  assert.equal(calls[3].url, calls[1].url);
  assert.equal(calls[3].init?.body, calls[1].init?.body);
  assert.equal(new URL(calls[4].url).pathname, "/api/plugins/handoff-pipeline/api/runs/production-run/correction-delivery");
  assert.deepEqual(JSON.parse(String(calls[4].init?.body)), { correctionCommentId: "comment-a" });
});

test("unexpected correction retry failures do not claim or save accepted delivery", async (context) => {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "https://paperclip.example" } } });
  context.after(() => { if (priorWindow) Object.defineProperty(globalThis, "window", priorWindow); else Reflect.deleteProperty(globalThis, "window"); });
  let calls = 0;
  context.mock.method(globalThis, "fetch", async () => { calls += 1; return new Response(JSON.stringify({ error: "Wake queue offline" }), { status: 500 }); });
  const production = run("production-run", "", { mode: "production", sourceIssueId: "issue-a", hostAgentId: "agent-a", review: { verdict: "rewritten", reviewerId: "human", reviewedAt: "now", revisedOutput: "Correct output", reason: "Wrong total", correctionCommentId: "comment-a" }, correctionDelivery: { status: "pending", pending: [{ agentId: "agent-a", reason: "Paused" }], updatedAt: "now" } });
  await assert.rejects(handoffApi.retryCorrectionDelivery("company-a", production), /Wake queue offline/);
  assert.equal(calls, 1);
  assert.equal(production.correctionDelivery!.status, "pending");
});

test("rewritten production review leaves its prepared correction retryable when comment creation fails", async (context) => {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "https://paperclip.example" } } });
  context.after(() => { if (priorWindow) Object.defineProperty(globalThis, "window", priorWindow); else Reflect.deleteProperty(globalThis, "window"); });
  let calls = 0;
  context.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    if (calls === 1) return new Response(JSON.stringify({ state: {} }), { status: 200 });
    return new Response(JSON.stringify({ error: "The source issue is no longer assigned to the expected agent" }), { status: 409 });
  });
  const production = run("production-run", "", { mode: "production", exampleId: null, sourceIssueId: "issue-a", hostAgentId: "agent-a", hostRunId: "host-a", review: null });
  await assert.rejects(handoffApi.reviewRun("company-a", production, { verdict: "rewritten", revisedOutput: "Correct output", reason: "Wrong total" }), /no longer assigned/);
  assert.equal(calls, 2);
});
