import assert from "node:assert/strict";
import { test } from "node:test";
import { AUDIT_SOURCES, type PipelineCommand, type SourceCoverage } from "./contracts.js";
import { applyCommand, calculateMonthlyHoursSaved, canRunProduction, cleanHistoricalExampleCount, createState, PIPELINE_LIMITS, rankJobs } from "./lifecycle.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const companySkillId = "22222222-2222-4222-8222-222222222222";
const skillKey = (slug: string) => `company/${companyId}/${slug}`;
const sources = (): SourceCoverage[] => AUDIT_SOURCES.map(source => ({ source, status: "reviewed", evidence: [{ ref: `evidence:${source}`, summary: `Observed ${source} records` }] }));
const audit = () => ({ type: "create_audit" as const, startAt: "2026-08-01T00:00:00Z", endAt: "2026-08-31T00:00:00Z", sources: sources() });
const draft = () => ({ type: "create_job" as const, auditId: "audit", title: "Weekly reporting", evidenceRefs: ["evidence:calendar"], occurrencesPerMonth: 4, manualMinutes: 60, agentMinutes: 15, initialDisposition: "draft" as const, skillKey: skillKey("weekly-report"), skillContent: "Read evidence and prepare report.", companySkillId });
function fixture() {
  let state = createState(companyId); let sequence = 0;
  const send = (command: PipelineCommand, id = `command-${++sequence}`, now = "2026-10-15T18:00:00Z") => {
    state = applyCommand(state, command, { id, now }); return state;
  };
  send(audit(), "audit"); send(draft(), "job");
  const run = (mode: "historical" | "production", extra: Partial<Extract<PipelineCommand, { type: "log_run" }>> = {}, now = "2026-10-15T18:00:00Z") => {
    const id = `run-${++sequence}`;
    send({ type: "log_run", jobId: "job", mode, revisionId: state.jobs[0].currentRevisionId!, idempotencyKey: id, originalOutput: `Output ${id}`, startedAt: "2026-10-15T18:00:00Z", ...(mode === "production" ? { sourceRef: `host-run:${id}`, hostRunId: `host-${id}`, hostAgentId: "agent-1", sourceIssueId: `issue-${id}` } : {}), ...extra }, id, now);
    return id;
  };
  const review = (runId: string, verdict: "clean" | "rewritten" = "clean", now = "2026-10-15T18:00:00Z") => {
    const production = state.jobs[0].runs.find((run) => run.id === runId)?.mode === "production";
    if (verdict === "rewritten" && production) send({ type: "prepare_rewrite", jobId: "job", runId, reviewerId: "human-1", revisedOutput: `Corrected ${runId}`, reason: "Missing detail" }, undefined, now);
    return send({ type: "review_run", jobId: "job", runId, reviewerId: "human-1", verdict, ...(verdict === "rewritten" ? { revisedOutput: `Corrected ${runId}`, reason: "Missing detail", ...(production ? { correctionCommentId: `comment-${runId}` } : {}) } : {}) }, undefined, now);
  };
  const qualify = () => {
    for (let index = 0; index < 3; index++) {
      const exampleId = `example-${++sequence}`;
      send({ type: "add_example", jobId: "job", sourceRef: `case:${exampleId}`, input: `Request ${index}`, actualOutcome: `Actual ${index}` }, exampleId);
      review(run("historical", { exampleId }));
    }
  };
  return { get state() { return state; }, send, run, review, qualify };
}

test("audit accepts inclusive 30 and 90 day boundaries and exactly four evidence sources", () => {
  const f = fixture(); assert.equal(f.state.audits[0].sources.length, 4);
  f.send({ ...audit(), startAt: "2026-07-17T00:00:00Z", endAt: "2026-10-15T00:00:00Z" });
  for (const endAt of ["2026-08-30T00:00:00Z", "2026-10-31T00:00:00Z", "invalid"]) assert.throws(() => f.send({ ...audit(), endAt }), /Audit|ISO/);
  assert.throws(() => f.send({ ...audit(), startAt: "2026-08-17T00:00:00Z", endAt: "2026-10-16T00:00:00Z" }), /future/);
  for (const bad of [sources().slice(1), [...sources().slice(1), sources()[1]]]) assert.throws(() => f.send({ ...audit(), sources: bad }), /exactly once/);
});
test("missing source coverage is explicit and reviewed sources need evidence", () => {
  const f = fixture(); const coverage = sources(); coverage[0] = { source: "calendar", status: "unavailable", evidence: [], reason: "No access supplied" };
  f.send({ ...audit(), sources: coverage });
  assert.throws(() => f.send({ ...audit(), sources: sources().map(item => ({ ...item, evidence: [] })) }), /require evidence/);
  assert.throws(() => f.send({ ...audit(), sources: coverage.map(item => ({ ...item, reason: undefined })) }), /reason/);
});
test("jobs calculate monthly savings, rank stably, and validate estimates", () => {
  const f = fixture(); assert.equal(f.state.jobs[0].monthlyHoursSaved, 3);
  f.send({ ...draft(), initialDisposition: "keep", skillKey: undefined, skillContent: undefined, companySkillId: undefined, occurrencesPerMonth: 12 }, "other-job");
  assert.deepEqual(rankJobs(f.state.jobs).map(job => job.id), ["other-job", "job"]);
  assert.deepEqual(f.state.jobs.map(job => job.id), ["job", "other-job"]);
  assert.equal(calculateMonthlyHoursSaved(4, 10, 20), 0);
  for (const invalid of [-1, Infinity, NaN, "10"]) assert.throws(() => calculateMonthlyHoursSaved(invalid as number, 60, 10), /finite/);
  assert.throws(() => calculateMonthlyHoursSaved(0, 60, 10), /positive/);
  assert.throws(() => calculateMonthlyHoursSaved(Number.MAX_VALUE, Number.MAX_VALUE, 0), /too large/);
});
test("jobs require their audit evidence, one unique skill and a real company skill link", () => {
  const f = fixture();
  assert.throws(() => f.send({ ...draft(), auditId: "foreign-audit" }), /not found/);
  assert.throws(() => f.send({ ...draft(), evidenceRefs: ["invented"], skillKey: skillKey("other"), companySkillId: "33333333-3333-4333-8333-333333333333" }), /reference its audit/);
  assert.throws(() => f.send(draft()), /own skill key/);
  assert.throws(() => f.send({ ...draft(), skillKey: skillKey("duplicate-artifact") }), /own company skill/);
  assert.throws(() => f.send({ ...draft(), skillKey: "company/99999999-9999-4999-8999-999999999999/weekly-report" }), /this company's skill/);
  assert.throws(() => f.send({ ...draft(), companySkillId: "fake", skillKey: skillKey("other") }), /UUID/);
  assert.throws(() => f.send({ ...draft(), companySkillId: undefined, skillKey: skillKey("other") }), /required/);
});
test("Keep records need no skill, block runs, and activate through a linked skill revision", () => {
  const f = fixture();
  f.send({ ...draft(), initialDisposition: "keep", skillKey: undefined, skillContent: undefined, companySkillId: undefined }, "kept-job");
  const kept = f.state.jobs[1]; assert.equal(kept.stage, "keep"); assert.equal(kept.currentRevisionId, null);
  assert.throws(() => f.send({ type: "log_run", jobId: kept.id, revisionId: "invented", mode: "production", idempotencyKey: "keep", sourceRef: "source", originalOutput: "x", startedAt: "2026-10-15T18:00:00Z" }), /known skill|blocks/);
  assert.throws(() => f.send({ type: "revise_skill", jobId: kept.id, skillContent: "Skill", skillKey: skillKey("second") }), /Company skill id/);
  f.send({ type: "revise_skill", jobId: kept.id, skillContent: "Skill", skillKey: skillKey("second"), companySkillId: "44444444-4444-4444-8444-444444444444", routineId: "33333333-3333-4333-8333-333333333333" });
  assert.equal(f.state.jobs[1].stage, "draft"); assert.equal(f.state.jobs[1].revisions.length, 1);
});
test("production requires three distinct human-reviewed historical examples on current revision", () => {
  const f = fixture(); assert.equal(canRunProduction(f.state.jobs[0]), false);
  assert.throws(() => f.run("production"), /Three clean/);
  f.qualify(); assert.equal(cleanHistoricalExampleCount(f.state.jobs[0]), 3); assert.equal(canRunProduction(f.state.jobs[0]), true);
  assert.equal(f.state.jobs[0].cleanStreak, 0); assert.equal(f.state.jobs[0].stage, "draft");
  f.run("production", { actualMinutes: 3 }); assert.equal(f.state.jobs[0].runs.at(-1)!.actualMinutes, 3);
});
test("historical cases preserve actual outcomes and cannot reuse the same source or example", () => {
  const f = fixture(); f.send({ type: "add_example", jobId: "job", sourceRef: "case:1", input: "Original input", actualOutcome: "Historical result" }, "example");
  assert.throws(() => f.send({ type: "add_example", jobId: "job", sourceRef: "case:1", input: "Other", actualOutcome: "Other" }), /distinct/);
  assert.throws(() => f.run("historical", { exampleId: "foreign" }), /belong to this job/);
  const runId = f.run("historical", { exampleId: "example" });
  assert.equal(cleanHistoricalExampleCount(f.state.jobs[0]), 0);
  f.review(runId, "rewritten"); assert.equal(cleanHistoricalExampleCount(f.state.jobs[0]), 0);
  assert.throws(() => f.run("historical", { exampleId: "example" }), /distinct/);
  assert.equal(f.state.jobs[0].examples[0].actualOutcome, "Historical result");
});
test("five consecutive clean production reviews promote Draft to Run", () => {
  const f = fixture(); f.qualify();
  for (let index = 0; index < 5; index++) { f.review(f.run("production")); assert.equal(f.state.jobs[0].stage, index === 4 ? "run" : "draft"); }
  assert.equal(f.state.jobs[0].cleanStreak, 5); assert.equal(f.state.jobs[0].rewrittenStreak, 0);
  assert.equal(f.state.jobs[0].revisions[0].promotedAt, "2026-10-15T18:00:00Z");
  const unattended = f.run("production");
  assert.equal(f.state.jobs[0].runs.at(-1)!.reviewRequired, false);
  assert.throws(() => f.review(unattended), /does not require human review/);
});
test("production review need follows the stage when execution started", () => {
  const f = fixture(); f.qualify();
  const qualifyingRuns = Array.from({ length: 5 }, (_, index) => f.run("production", { startedAt: `2026-10-15T18:0${index + 1}:00Z` }, `2026-10-15T18:0${index + 1}:30Z`));
  for (const runId of qualifyingRuns) f.review(runId, "clean", "2026-10-15T18:10:00Z");
  assert.equal(f.state.jobs[0].revisions[0].promotedAt, "2026-10-15T18:10:00Z");
  const runExecution = f.run("production", { startedAt: "2026-10-15T18:10:00Z" }, "2026-10-15T18:11:00Z");
  assert.equal(f.state.jobs[0].runs.find(run => run.id === runExecution)!.reviewRequired, false);
  const draftExecution = f.run("production", { startedAt: "2026-10-15T18:09:00Z" }, "2026-10-15T18:11:00Z");
  assert.equal(f.state.jobs[0].runs.find(run => run.id === draftExecution)!.reviewRequired, true);
  assert.equal(f.state.jobs[0].stage, "draft");
  const pendingWindowExecution = f.run("production", { startedAt: "2026-10-15T18:11:30Z" }, "2026-10-15T18:12:00Z");
  assert.equal(f.state.jobs[0].runs.find(run => run.id === pendingWindowExecution)!.reviewRequired, true);
  f.review(draftExecution, "clean", "2026-10-15T18:12:00Z");
});
test("rewrites reset clean streak, cleans reset rewrite streak, and three rewrites block runs", () => {
  const f = fixture(); f.qualify();
  f.review(f.run("production")); f.review(f.run("production"), "rewritten");
  assert.equal(f.state.jobs[0].cleanStreak, 0); f.review(f.run("production")); assert.equal(f.state.jobs[0].rewrittenStreak, 0);
  for (let index = 0; index < 3; index++) f.review(f.run("production"), "rewritten");
  assert.equal(f.state.jobs[0].stage, "rebuild_required"); assert.equal(canRunProduction(f.state.jobs[0]), false);
  assert.equal(f.state.jobs[0].runsBlockedAt, "2026-10-15T18:00:00Z");
  assert.throws(() => f.send({ type: "log_run", jobId: "job", revisionId: "job", mode: "production", idempotencyKey: "at-block", sourceRef: "host-run:at-block", originalOutput: "x", startedAt: "2026-10-15T18:00:00Z" }, "at-block", "2026-10-15T18:00:01Z"), /at or after its cutoff/);
  assert.throws(() => f.send({ type: "log_run", jobId: "job", revisionId: "job", mode: "production", idempotencyKey: "after-block", sourceRef: "host-run:after-block", originalOutput: "x", startedAt: "2026-10-15T18:00:01Z" }, "after-block", "2026-10-15T18:00:01Z"), /blocks new runs/);
  assert.throws(() => f.send({ type: "log_run", jobId: "job", revisionId: "job", mode: "historical", idempotencyKey: "historical-after-block", exampleId: f.state.jobs[0].examples[0].id, originalOutput: "x", startedAt: "2026-10-15T18:00:01Z" }, "historical-after-block", "2026-10-15T18:00:01Z"), /blocks new runs/);
  f.send({ type: "retire", jobId: "job", reason: "Retire after block" }, "retire-after-block", "2026-10-15T18:10:00Z");
  assert.equal(f.state.jobs[0].runsBlockedAt, "2026-10-15T18:00:00Z");
});
test("three consecutive rewritten historical rehearsals require a rebuild", () => {
  const f = fixture();
  for (let index = 0; index < 3; index++) {
    const exampleId = `rewritten-example-${index}`;
    f.send({ type: "add_example", jobId: "job", sourceRef: `case:rewrite:${index}`, input: `Request ${index}`, actualOutcome: `Actual ${index}` }, exampleId);
    f.review(f.run("historical", { exampleId }), "rewritten");
  }
  assert.equal(f.state.jobs[0].rewrittenStreak, 3);
  assert.equal(f.state.jobs[0].stage, "rebuild_required");
});
test("pending clean reviews cannot undo a rebuild requirement", () => {
  const f = fixture(); f.qualify(); const pending = Array.from({ length: 5 }, () => f.run("production"));
  for (const runId of pending.slice(0, 3)) f.review(runId, "rewritten");
  for (const runId of pending.slice(3)) f.review(runId);
  assert.equal(f.state.jobs[0].stage, "rebuild_required"); assert.equal(f.state.jobs[0].rewrittenStreak, 3);
});
test("production reviews must follow execution order", () => {
  const f = fixture(); f.qualify(); const first = f.run("production"); const second = f.run("production");
  assert.throws(() => f.review(second), /oldest pending first/);
  f.review(first, "rewritten"); f.review(second); assert.equal(f.state.jobs[0].cleanStreak, 1);
});
test("production review order follows start time even when records arrive late", () => {
  const f = fixture(); f.qualify();
  const later = f.run("production", { startedAt: "2026-10-15T18:02:00Z" }, "2026-10-15T18:03:00Z");
  const earlier = f.run("production", { startedAt: "2026-10-15T18:01:00Z" }, "2026-10-15T18:04:00Z");
  assert.throws(() => f.review(later, "clean", "2026-10-15T18:05:00Z"), /oldest pending first/);
  f.review(earlier, "clean", "2026-10-15T18:05:00Z");
  f.review(later, "clean", "2026-10-15T18:05:00Z");
});
test("late production results revoke promotion and rewrites follow actual review order", () => {
  const f = fixture(); f.qualify();
  const cleanRuns = [2, 4, 6, 8, 10].map(minute => f.run("production", { startedAt: `2026-10-15T18:${String(minute).padStart(2, "0")}:00Z` }, "2026-10-15T18:11:00Z"));
  for (const runId of cleanRuns) f.review(runId, "clean", "2026-10-15T18:12:00Z");
  assert.equal(f.state.jobs[0].stage, "run");
  for (const minute of [1, 3, 5]) {
    const runId = f.run("production", { startedAt: `2026-10-15T18:${String(minute).padStart(2, "0")}:00Z` }, "2026-10-15T18:13:00Z");
    f.review(runId, "rewritten", `2026-10-15T18:${minute + 13}:00Z`);
    if (minute === 1) assert.equal(f.state.jobs[0].stage, "draft");
  }
  assert.equal(f.state.jobs[0].stage, "rebuild_required");
  assert.equal(f.state.jobs[0].cleanStreak, 3);
  assert.equal(f.state.jobs[0].rewrittenStreak, 3);
  assert.equal(f.state.jobs[0].revisions[0].promotedAt, null);
});
test("all required current revision production reviews must finish before promotion resumes", () => {
  const f = fixture(); f.qualify();
  for (const minute of [2, 4, 6, 8, 10]) {
    f.review(f.run("production", { startedAt: `2026-10-15T18:${String(minute).padStart(2, "0")}:00Z` }, "2026-10-15T18:11:00Z"), "clean", "2026-10-15T18:12:00Z");
  }
  assert.equal(f.state.jobs[0].stage, "run");
  const later = f.run("production", { startedAt: "2026-10-15T18:03:00Z" }, "2026-10-15T18:13:00Z");
  const earlier = f.run("production", { startedAt: "2026-10-15T18:01:00Z" }, "2026-10-15T18:14:00Z");
  assert.throws(() => f.review(later, "clean", "2026-10-15T18:15:00Z"), /oldest pending first/);
  f.review(earlier, "clean", "2026-10-15T18:15:00Z");
  assert.equal(f.state.jobs[0].stage, "draft");
  assert.equal(f.state.jobs[0].revisions[0].promotedAt, null);
  const supervised = f.run("production", { startedAt: "2026-10-15T18:16:00Z" }, "2026-10-15T18:17:00Z");
  assert.equal(f.state.jobs[0].runs.find(run => run.id === supervised)!.reviewRequired, true);
  f.review(later, "clean", "2026-10-15T18:18:00Z");
  assert.equal(f.state.jobs[0].stage, "draft");
  assert.equal(f.state.jobs[0].revisions[0].promotedAt, null);
  f.review(supervised, "clean", "2026-10-15T18:19:00Z");
  assert.equal(f.state.jobs[0].stage, "run");
  assert.equal(f.state.jobs[0].cleanStreak, 8);
  assert.equal(f.state.jobs[0].revisions[0].promotedAt, "2026-10-15T18:19:00Z");
  const unattended = f.run("production", { startedAt: "2026-10-15T18:20:00Z" }, "2026-10-15T18:21:00Z");
  assert.equal(f.state.jobs[0].runs.find(run => run.id === unattended)!.reviewRequired, false);
});
test("pending required reviews on an old revision do not prevent current revision promotion", () => {
  const f = fixture(); f.qualify();
  const oldRun = f.run("production");
  f.send({ type: "rebuild", jobId: "job", skillContent: "New instructions", reason: "Improve procedure", requestId: "revision-2" }, "revision-2");
  f.qualify();
  for (let index = 0; index < 5; index++) f.review(f.run("production"));
  assert.equal(f.state.jobs[0].stage, "run");
  assert.equal(f.state.jobs[0].runs.find(run => run.id === oldRun)!.review, null);
  f.review(oldRun, "rewritten");
  assert.equal(f.state.jobs[0].stage, "run");
  assert.equal(f.state.jobs[0].cleanStreak, 5);
  assert.equal(f.state.jobs[0].rewrittenStreak, 0);
});
test("reviews preserve both outputs, human identity and rewrite reasons immutably", () => {
  const f = fixture(); f.qualify(); const runId = f.run("production"); const original = f.state.jobs[0].runs.at(-1)!.originalOutput;
  assert.throws(() => f.send({ type: "review_run", jobId: "job", runId, reviewerId: "", verdict: "clean" }), /Human reviewer/);
  assert.throws(() => f.send({ type: "review_run", jobId: "job", runId, reviewerId: "human", verdict: "rewritten", revisedOutput: "New" }), /Rewrite reason/);
  assert.throws(() => f.send({ type: "review_run", jobId: "job", runId, reviewerId: "human", verdict: "rewritten", revisedOutput: original, reason: "x", correctionCommentId: "comment" }), /differ/);
  f.review(runId, "rewritten"); const reviewed = f.state.jobs[0].runs.at(-1)!;
  assert.equal(reviewed.originalOutput, original); assert.equal(reviewed.review?.revisedOutput, `Corrected ${runId}`); assert.equal(reviewed.review?.reason, "Missing detail");
  assert.throws(() => f.review(runId), /immutable human review/);
});
test("prepared production rewrites are immutable, retryable, and block a competing clean review", () => {
  const f = fixture(); f.qualify(); const runId = f.run("production");
  const prepare: PipelineCommand = { type: "prepare_rewrite", jobId: "job", runId, reviewerId: "human-1", revisedOutput: "Corrected", reason: "Wrong total" };
  f.send(prepare, "prepare-one");
  const prepared = f.state;
  f.send(prepare, "prepare-retry");
  assert.equal(f.state, prepared);
  assert.throws(() => f.send({ ...prepare, reason: "Different reason" }), /different correction/);
  assert.throws(() => f.send({ type: "review_run", jobId: "job", runId, reviewerId: "human-1", verdict: "clean" }), /prepared correction/);
  assert.throws(() => f.send({ type: "review_run", jobId: "job", runId, reviewerId: "human-1", verdict: "rewritten", revisedOutput: "Other", reason: "Wrong total", correctionCommentId: "comment" }), /match its prepared/);
  f.send({ type: "review_run", jobId: "job", runId, reviewerId: "human-1", verdict: "rewritten", revisedOutput: "Corrected", reason: "Wrong total", correctionCommentId: "comment" });
  assert.equal(f.state.jobs[0].runs.find(run => run.id === runId)?.pendingRewrite, null);
  const reviewed = f.state;
  f.send(prepare);
  f.send({ type: "review_run", jobId: "job", runId, reviewerId: "human-1", verdict: "rewritten", revisedOutput: "Corrected", reason: "Wrong total", correctionCommentId: "comment" });
  assert.equal(f.state, reviewed);
});
test("correction delivery updates preserve immutable reviews and accepted receipts cannot regress", () => {
  const f = fixture(); f.qualify(); const runId = f.run("production"); f.review(runId, "rewritten");
  const reviewed = structuredClone(f.state.jobs[0].runs.at(-1)!.review);
  assert.equal(f.state.jobs[0].runs.at(-1)!.correctionDelivery?.status, "pending");
  const command: Extract<PipelineCommand, { type: "record_correction_delivery" }> = { type: "record_correction_delivery", jobId: "job", runId, reviewerId: "human-1", correctionCommentId: `comment-${runId}`, delivery: { status: "accepted", pending: [] } };
  assert.throws(() => f.send({ ...command, reviewerId: "another-reviewer" }), /original reviewer/);
  assert.throws(() => f.send({ ...command, correctionCommentId: "another-comment" }), /saved correction/);
  assert.throws(() => f.send({ ...command, delivery: { status: "pending", pending: [] } }), /match the delivery status/);
  f.send(command);
  const accepted = f.state;
  f.send(command);
  assert.equal(f.state, accepted);
  f.send({ ...command, delivery: { status: "pending", pending: [{ agentId: "agent-1", reason: "An older retry observed a pause" }] } });
  assert.equal(f.state, accepted);
  assert.deepEqual(f.state.jobs[0].runs.at(-1)!.review, reviewed);
  assert.equal(f.state.jobs[0].rewrittenStreak, 1);
});

test("runs are idempotent, reject conflicting replays, and retain immutable revision hashes", () => {
  const f = fixture(); f.qualify(); const id = f.run("production"); const before = f.state;
  const command: PipelineCommand = { type: "log_run", jobId: "job", revisionId: "job", idempotencyKey: id, mode: "production", originalOutput: `Output ${id}`, sourceRef: `host-run:${id}`, startedAt: "2026-10-15T18:00:00Z", hostRunId: `host-${id}`, hostAgentId: "agent-1", sourceIssueId: `issue-${id}` };
  f.send(command); assert.equal(f.state, before);
  f.send(command, id); assert.equal(f.state, before);
  assert.throws(() => f.send({ ...command, originalOutput: "Changed" }), /different output/);
  assert.throws(() => f.send({ ...command, startedAt: "2026-10-15T17:59:59Z" }), /different output/);
  assert.throws(() => f.send({ ...command, idempotencyKey: "new", revisionId: "stale" }), /known skill revision/);
  assert.equal(f.state.jobs[0].runs.at(-1)!.revisionHash.length, 64);
  assert.equal(f.state.jobs[0].runs.at(-1)!.startedAt, command.startedAt);
  assert.equal(f.state.jobs[0].runs.at(-1)!.createdAt, "2026-10-15T18:00:00Z");
});
test("run start is a valid execution timestamp at or before record time", () => {
  const f = fixture();
  assert.throws(() => f.run("historical", { exampleId: "unused", startedAt: "not-a-time" }), /ISO timestamp/);
  assert.throws(() => f.run("historical", { exampleId: "unused", startedAt: "2026-10-15T18:00:01Z" }), /after its record time/);
  assert.throws(() => f.run("historical", { exampleId: "unused", startedAt: "2026-10-15T17:59:59Z" }), /before its skill revision/);
});
test("new run records reject old revisions and honor exact job cutoffs", () => {
  const f = fixture(); f.qualify();
  f.send({ type: "add_example", jobId: "job", sourceRef: "case:late", input: "Late input", actualOutcome: "Late outcome" }, "late-example", "2026-10-15T18:05:00Z");
  f.send({ type: "rebuild", jobId: "job", skillContent: "Second revision", reason: "Improve procedure", requestId: "revision-2" }, "revision-2", "2026-10-15T18:10:00Z");
  f.send({ type: "retire", jobId: "job", reason: "Stopped" }, "retire", "2026-10-15T18:30:00Z");
  assert.throws(() => f.send({ type: "log_run", jobId: "job", revisionId: "job", mode: "historical", exampleId: "late-example", idempotencyKey: "late-old", originalOutput: "Late old output", startedAt: "2026-10-15T18:09:00Z" }, "late-old", "2026-10-15T18:40:00Z"), /Outstanding runs/);
  assert.throws(() => f.send({ type: "log_run", jobId: "job", revisionId: "revision-2", mode: "production", idempotencyKey: "at-retire", sourceRef: "host-run:at-retire", originalOutput: "x", startedAt: "2026-10-15T18:30:00Z" }, "at-retire", "2026-10-15T18:40:00Z"), /at or after its cutoff/);
  assert.throws(() => f.send({ type: "log_run", jobId: "job", revisionId: "revision-2", mode: "production", idempotencyKey: "after-retire", sourceRef: "host-run:after-retire", originalOutput: "x", startedAt: "2026-10-15T18:31:00Z" }, "after-retire", "2026-10-15T18:40:00Z"), /after its cutoff/);
});
test("production qualification must exist on the selected revision before execution starts", () => {
  const f = fixture(); f.qualify();
  assert.throws(() => f.run("production", { startedAt: "2026-10-15T17:59:59Z" }), /before its skill revision|Three clean/);
  f.send({ type: "rebuild", jobId: "job", skillContent: "Second revision", reason: "Improve procedure", requestId: "revision-2" }, "revision-2", "2026-10-15T18:10:00Z");
  assert.throws(() => f.send({ type: "log_run", jobId: "job", revisionId: "revision-2", mode: "production", idempotencyKey: "unqualified", sourceRef: "host-run:unqualified", originalOutput: "x", startedAt: "2026-10-15T18:10:00Z" }, "unqualified", "2026-10-15T18:20:00Z"), /Three clean historical examples/);
});
test("revision changes reset qualification and streaks while preserving all prior evidence", () => {
  const f = fixture(); f.qualify(); f.review(f.run("production")); const historical = structuredClone(f.state.jobs[0].runs);
  f.send({ type: "rebuild", jobId: "job", skillContent: "Improved current skill", reason: "Improve procedure", requestId: "revision-2" }, "revision-2");
  assert.equal(f.state.jobs[0].stage, "draft"); assert.equal(f.state.jobs[0].cleanStreak, 0); assert.equal(cleanHistoricalExampleCount(f.state.jobs[0]), 0);
  assert.equal(f.state.jobs[0].revisions.at(-1)!.promotedAt, null);
  assert.deepEqual(f.state.jobs[0].runs, historical); assert.equal(f.state.jobs[0].revisions.length, 2);
  assert.throws(() => f.send({ type: "rebuild", jobId: "job", skillContent: "Improved current skill", reason: "Retry", requestId: "duplicate" }, "duplicate"), /change the content/);
  assert.throws(() => f.send({ type: "revise_skill", jobId: "job", skillContent: "Another change" }), /must use rebuild/);
  assert.throws(() => f.run("production"), /Three clean/);
});
test("old revision reviews do not alter current streaks or qualification", () => {
  const f = fixture(); f.qualify(); const runId = f.run("production");
  f.send({ type: "rebuild", jobId: "job", skillContent: "New content", reason: "Improve procedure", requestId: "revision-2" }, "revision-2"); f.review(runId);
  assert.equal(f.state.jobs[0].cleanStreak, 0); assert.equal(cleanHistoricalExampleCount(f.state.jobs[0]), 0);
});
test("rebuild restarts qualification and retirement preserves all history permanently", () => {
  const f = fixture(); f.qualify(); for (let i = 0; i < 3; i++) f.review(f.run("production"), "rewritten");
  const previousRuns = structuredClone(f.state.jobs[0].runs);
  f.send({ type: "rebuild", jobId: "job", skillContent: "Rebuilt instructions", reason: "Three misses", requestId: "rebuilt" }, "rebuilt", "2026-10-15T18:10:00Z");
  assert.equal(f.state.jobs[0].stage, "draft"); assert.equal(f.state.jobs[0].runsBlockedAt, null); assert.deepEqual(f.state.jobs[0].runs, previousRuns); assert.equal(cleanHistoricalExampleCount(f.state.jobs[0]), 0);
  assert.throws(() => f.send({ type: "log_run", jobId: "job", revisionId: "job", mode: "production", idempotencyKey: "during-block", sourceRef: "host-run:during-block", originalOutput: "x", startedAt: "2026-10-15T18:05:00Z" }, "during-block", "2026-10-15T18:11:00Z"), /Outstanding runs/);
  f.send({ type: "retire", jobId: "job", reason: "No longer recurring" }, "retired", "2026-10-15T18:20:00Z");
  assert.deepEqual(f.state.jobs[0].runs, previousRuns); assert.equal(f.state.jobs[0].runsBlockedAt, "2026-10-15T18:20:00Z");
  assert.throws(() => f.send({ type: "log_run", jobId: "job", revisionId: f.state.jobs[0].currentRevisionId!, mode: "production", idempotencyKey: "after-retirement", sourceRef: "host-run:after-retirement", originalOutput: "x", startedAt: "2026-10-15T18:20:01Z" }, "after-retirement", "2026-10-15T18:20:01Z"), /blocks/);
  assert.throws(() => f.send({ type: "revise_skill", jobId: "job", skillContent: "Cannot revive" }), /Retired/);
});
test("skill revisions normalize line endings before hashing and storage", () => {
  const f = fixture();
  f.send({ type: "rebuild", jobId: "job", skillContent: "Changed\r\nInstructions\r\n", reason: "Improve procedure", requestId: "crlf" }, "crlf");
  assert.equal(f.state.jobs[0].revisions.at(-1)!.content, "Changed\nInstructions\n");
  assert.throws(() => f.send({ type: "rebuild", jobId: "job", skillContent: "Changed\nInstructions\n", reason: "Retry", requestId: "lf" }, "lf"), /change the content/);
});
test("reducers leave previous state untouched and append exactly one company-scoped event", () => {
  const before = createState(companyId); const after = applyCommand(before, audit(), { id: "audit", now: "2026-10-15T18:00:00Z" });
  assert.deepEqual(before, createState(companyId)); assert.equal(after.events.length, 1); assert.equal(after.version, 1);
  assert.equal(after.events[0].companyId, companyId);
  assert.throws(() => applyCommand(after, audit(), { id: "audit", now: "2026-10-15T18:00:00Z" }), /already used/);
});
test("company boundaries reject another company's job or audit", () => {
  const f = fixture(); const other = createState("other-company");
  assert.throws(() => applyCommand(other, { type: "retire", jobId: "job", reason: "No" }, { id: "x", now: "2026-10-15T18:00:00Z" }), /not found in this company/);
  const corrupted = structuredClone(f.state); corrupted.jobs[0].companyId = "other-company";
  assert.throws(() => applyCommand(corrupted, { type: "retire", jobId: "job", reason: "No" }, { id: "x", now: "2026-10-15T18:00:00Z" }), /not found in this company/);
});
test("text, count and aggregate storage limits fail explicitly without truncating history", () => {
  const f = fixture();
  assert.throws(() => f.send({ ...draft(), title: "x".repeat(PIPELINE_LIMITS.shortText + 1), skillKey: skillKey("new") }), /exceeds/);
  assert.throws(() => f.send({ type: "revise_skill", jobId: "job", skillContent: "x".repeat(PIPELINE_LIMITS.text + 1) }), /exceeds/);
  const full = structuredClone(f.state); full.jobs[0].runs = Array(PIPELINE_LIMITS.runsPerJob).fill({ idempotencyKey: "existing" });
  assert.throws(() => applyCommand(full, { type: "log_run", jobId: "job", mode: "historical", revisionId: "job", idempotencyKey: "new", originalOutput: "x", exampleId: "no", startedAt: "2026-10-15T18:00:00Z" }, { id: "cap", now: "2026-10-15T18:00:00Z" }), /Run history limit/);
  const huge = structuredClone(f.state); huge.jobs[0].revisions[0].content = "x".repeat(PIPELINE_LIMITS.stateBytes);
  assert.throws(() => applyCommand(huge, { type: "retire", jobId: "job", reason: "Retire" }, { id: "large", now: "2026-10-15T18:00:00Z" }), /storage limit/);
});
test("production references and measured minutes are validated", () => {
  const f = fixture(); f.qualify();
  assert.throws(() => f.run("production", { sourceRef: undefined }), /Production source/);
  assert.throws(() => f.run("production", { actualMinutes: -1 }), /Actual minutes/);
  assert.throws(() => f.run("production", { exampleId: "historical" }), /cannot be historical/);
  f.run("production", { sourceRef: "host-run:one" });
  assert.throws(() => f.run("production", { sourceRef: "host-run:one" }), /references must be distinct/);
});
test("a host run cannot be recorded twice", () => {
  const f = fixture(); f.qualify();
  f.run("production", { hostRunId: "host-once" });
  assert.throws(() => f.run("production", { hostRunId: "host-once" }), /only once/);
});
