import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PipelineState } from "../contracts.js";
import { actionFormValue, CorrectionDeliveryNotice, PipelineTab } from "./HandOffPage.js";

function fixture(): PipelineState {
  return { companyId: "company-a", version: 1, audits: [], events: [], jobs: [{
    id: "job-a", companyId: "company-a", auditId: "audit-a", title: "Check invoices", evidenceRefs: ["mail-a"], occurrencesPerMonth: 10, manualMinutes: 30, agentMinutes: 6, monthlyHoursSaved: 4, skillKey: "invoice-check", companySkillId: "skill-a", routineId: "routine-a", currentRevisionId: "revision-a", revisions: [{ id: "revision-a", hash: "hash-a", content: "Check the invoices", createdAt: "2026-10-15T00:00:00Z", promotedAt: null }], stage: "draft", cleanStreak: 0, rewrittenStreak: 1, runsBlockedAt: null, createdAt: "2026-10-15T00:00:00Z", updatedAt: "2026-10-15T00:00:00Z",
    examples: [{ id: "example-a", sourceRef: "mail-a", input: "Original invoice", actualOutcome: "Human paid invoice", createdAt: "2026-10-15T00:00:00Z" }],
    runs: [
      { id: "reviewed-run", idempotencyKey: "reviewed", mode: "historical", revisionId: "revision-a", revisionHash: "hash-a", exampleId: "example-a", sourceRef: "mail-a", actualMinutes: 2, originalOutput: "Original <unsafe> output", startedAt: "2026-10-15T00:00:00Z", createdAt: "2026-10-15T00:05:00Z", reviewRequired: true, review: { verdict: "rewritten", reviewerId: "human-a", reviewedAt: "2026-10-15T01:00:00Z", revisedOutput: "Corrected invoice output", reason: "Missing tax" } },
      { id: "pending-run", idempotencyKey: "pending", mode: "historical", revisionId: "revision-old", revisionHash: "hash-old", exampleId: "example-a", sourceRef: "mail-a", actualMinutes: null, originalOutput: "Pending original output", startedAt: "2026-10-14T00:00:00Z", createdAt: "2026-10-14T00:05:00Z", reviewRequired: true, review: null },
    ],
  }] };
}

function render(tab: "Audit" | "Jobs" | "Review" | "Run log", state = fixture()) {
  return renderToStaticMarkup(createElement(PipelineTab, { tab, state, companyId: state.companyId, refresh: async () => {} }));
}

test("pending correction delivery is reported separately from the saved human review", () => {
  const html = renderToStaticMarkup(createElement(CorrectionDeliveryNotice, { pending: {
    run: fixture().jobs[0].runs[0], revisedOutput: "Corrected", reason: "Missing total",
    delivery: { status: "pending", pending: [{ agentId: "agent-a", reason: "Agent is paused." }] },
  }, companyId: "company-a", refresh: async () => {} }));
  assert.match(html, /Human review saved/);
  assert.match(html, /Correction delivery is pending/);
  assert.match(html, /Agent is paused/);
  assert.match(html, /Retry correction delivery/);
});

test("reloaded run log restores saved delivery warnings and retry controls after review is complete", () => {
  const state = fixture();
  const run = state.jobs[0].runs[0];
  run.mode = "production"; run.sourceIssueId = "issue-a"; run.hostAgentId = "agent-a";
  run.review!.correctionCommentId = "comment-a";
  run.correctionDelivery = { status: "pending", pending: [{ agentId: "agent-a", reason: "Agent is paused by its budget." }], updatedAt: "2026-10-15T01:00:00Z" };
  const reloaded = JSON.parse(JSON.stringify(state));
  const html = render("Run log", reloaded);
  assert.match(html, /Human verdict: Rewritten/);
  assert.match(html, /Correction delivery is pending/);
  assert.match(html, /paused by its budget/);
  assert.match(html, /Retry correction delivery/);
  reloaded.jobs[0].runs[0].correctionDelivery = { status: "accepted", pending: [], updatedAt: "2026-10-15T02:00:00Z" };
  const accepted = render("Run log", reloaded);
  assert.match(accepted, /Correction delivery accepted by the host/);
  assert.doesNotMatch(accepted, /Retry correction delivery/);
});

test("forms preserve textarea content while trimming single-line fields", () => {
  assert.equal(actionFormValue("Instructions\n", "textarea"), "Instructions\n");
  assert.equal(actionFormValue("  title  ", "text"), "title");
});

test("audit end date cannot be selected after today", () => {
  const today = new Date().toISOString().slice(0, 10);
  assert.match(render("Audit"), new RegExp(`max="${today}"[^>]*name="end"`));
});

test("run log preserves original output, human correction and reason without interpreting output as HTML", () => {
  const html = render("Run log");
  assert.match(html, /Original &lt;unsafe&gt; output/);
  assert.match(html, /Corrected invoice output/);
  assert.match(html, /Missing tax/);
  assert.match(html, /human-a/);
  assert.match(html, /revision-old/);
  assert.doesNotMatch(html, /<unsafe>/);
});

test("review shows pending original and historical outcome, with earlier revision warning", () => {
  const html = render("Review");
  assert.match(html, /pending-run/);
  assert.match(html, /Pending original output/);
  assert.match(html, /Original invoice/);
  assert.match(html, /Human paid invoice/);
  assert.match(html, /earlier revision/);
  assert.doesNotMatch(html, /reviewed-run/);
  assert.doesNotMatch(html, /No runs are waiting/);
});

test("jobs show linked company artifacts and block production until current revision qualifies", () => {
  const html = render("Jobs");
  for (const value of ["4.0 estimated hours", "invoice-check", "skill-a", "routine-a", "revision-a", "0/3 clean historical", "Three clean historical examples are required first"]) assert.ok(html.includes(value), value);
  const state = fixture();
  state.jobs[0].stage = "rebuild_required";
  assert.match(render("Jobs", state), /Three consecutive rewrites blocked new runs/);
  assert.doesNotMatch(render("Jobs", state), /Add run for review/);
});

test("Run production results stay in the log without entering required review", () => {
  const state = fixture();
  state.jobs[0].stage = "run";
  state.jobs[0].revisions[0].promotedAt = "2026-10-15T02:00:00Z";
  state.jobs[0].runs.push({ id: "run-output", idempotencyKey: "run-output", mode: "production", revisionId: "revision-a", revisionHash: "hash-a", exampleId: null, sourceRef: "invoice:42", actualMinutes: 1, originalOutput: "Completed invoice check", startedAt: "2026-10-15T03:00:00Z", createdAt: "2026-10-15T03:05:00Z", reviewRequired: false, review: null });
  const reviewHtml = render("Review", state);
  const logHtml = render("Run log", state);
  const jobsHtml = render("Jobs", state);
  assert.doesNotMatch(reviewHtml, /run-output/);
  assert.match(logHtml, /Human review is not required in Run/);
  assert.match(jobsHtml, /New production runs no longer require human review/);
});

test("review enables production runs in execution order when they are recorded out of order", () => {
  const state = fixture();
  state.jobs[0].runs.push(
    { id: "later-run", idempotencyKey: "later-run", mode: "production", revisionId: "revision-a", revisionHash: "hash-a", exampleId: null, sourceRef: "invoice:later", actualMinutes: 1, originalOutput: "Later output", startedAt: "2026-10-15T03:00:00Z", createdAt: "2026-10-15T03:01:00Z", reviewRequired: true, review: null },
    { id: "earlier-run", idempotencyKey: "earlier-run", mode: "production", revisionId: "revision-a", revisionHash: "hash-a", exampleId: null, sourceRef: "invoice:earlier", actualMinutes: 1, originalOutput: "Earlier output", startedAt: "2026-10-15T02:00:00Z", createdAt: "2026-10-15T03:02:00Z", reviewRequired: true, review: null },
  );
  const html = render("Review", state);
  const earlierCard = html.match(/Run: earlier-run[\s\S]*?<\/article>/)![0];
  const laterCard = html.match(/Run: later-run[\s\S]*?<\/article>/)![0];
  assert.doesNotMatch(earlierCard, /disabled=""/);
  assert.match(laterCard, /Review the oldest pending production run/);
  assert.match(laterCard, /disabled=""/);
});

test("review restores a prepared production correction after an interrupted save", () => {
  const state = fixture();
  state.jobs[0].runs.push({
    id: "prepared-run", idempotencyKey: "prepared-run", mode: "production", revisionId: "revision-a", revisionHash: "hash-a", exampleId: null,
    sourceRef: "invoice:prepared", actualMinutes: 1, originalOutput: "Wrong output", startedAt: "2026-10-15T02:00:00Z", createdAt: "2026-10-15T02:01:00Z",
    hostRunId: "host-a", hostAgentId: "agent-a", sourceIssueId: "issue-a", reviewRequired: true, review: null,
    pendingRewrite: { reviewerId: "human-a", preparedAt: "2026-10-15T03:00:00Z", revisedOutput: "Correct output", reason: "Wrong total" },
  });
  const html = render("Review", state);
  assert.match(html, /prepared but not fully saved/);
  assert.match(html, /Correct output/);
  assert.match(html, /Wrong total/);
  assert.match(html, /value="rewritten" selected=""/);
});
