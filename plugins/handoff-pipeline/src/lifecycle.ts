import { createHash } from "node:crypto";
import { AUDIT_SOURCES, type CommandMeta, type CorrectionDelivery, type PipelineCommand, type PipelineState, type RecurringJob, type SkillRevision } from "./contracts.js";

export const PIPELINE_LIMITS = {
  text: 250_000, shortText: 300, reference: 2_048, reason: 4_000,
  audits: 100, jobs: 500, examplesPerJob: 500, runsPerJob: 2_000,
  revisionsPerJob: 100, events: 20_000, evidencePerSource: 500,
  stateBytes: 16 * 1024 * 1024,
} as const;

export class PipelineError extends Error {
  constructor(public readonly code: "invalid_input" | "not_found" | "conflict" | "blocked", message: string) {
    super(message); this.name = "PipelineError";
  }
}
function requireThat(value: unknown, message: string): asserts value {
  if (!value) throw new PipelineError("invalid_input", message);
}
function text(value: unknown, label: string, max: number = PIPELINE_LIMITS.text): asserts value is string {
  requireThat(typeof value === "string" && value.trim().length > 0, `${label} is required`);
  requireThat(value.length <= max, `${label} exceeds ${max} characters`);
}
function artifactId(value: unknown, label: string): asserts value is string {
  text(value, label, PIPELINE_LIMITS.shortText);
  requireThat(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value), `${label} must be a UUID`);
}
function companySkillKey(value: unknown, companyId: string): asserts value is string {
  text(value, "Skill key", PIPELINE_LIMITS.shortText);
  const prefix = `company/${companyId}/`;
  requireThat(value.startsWith(prefix) && /^[a-z0-9][a-z0-9-]*$/.test(value.slice(prefix.length)), "Skill key must be the returned key for this company's skill");
}
function capacity(used: number, limit: number, label: string): void {
  if (used >= limit) throw new PipelineError("blocked", `${label} history limit reached; export this company before adding more`);
}
function correctionDelivery(value: CorrectionDelivery): CorrectionDelivery {
  requireThat(value && (value.status === "accepted" || value.status === "pending"), "Correction delivery status must be accepted or pending");
  requireThat(Array.isArray(value.pending) && value.pending.length <= PIPELINE_LIMITS.evidencePerSource, "Correction delivery requires a bounded pending list");
  requireThat((value.status === "pending") === (value.pending.length > 0), "Pending delivery details must match the delivery status");
  const pending = value.pending.map(item => {
    requireThat(item && typeof item === "object", "Pending delivery details are required");
    text(item.agentId, "Delivery agent", PIPELINE_LIMITS.shortText); text(item.reason, "Delivery reason", PIPELINE_LIMITS.reason);
    return { agentId: item.agentId, reason: item.reason };
  });
  return { status: value.status, pending };
}
function timestamp(value: string, label: string): number {
  text(value, label);
  const result = Date.parse(value);
  requireThat(Number.isFinite(result) && /^\d{4}-\d{2}-\d{2}T/.test(value), `${label} must be an ISO timestamp`);
  return result;
}
function revision(content: string, meta: CommandMeta): SkillRevision {
  text(content, "Skill content");
  const normalized = content.replace(/\r\n/g, "\n");
  return { id: meta.id, hash: createHash("sha256").update(normalized).digest("hex"), content: normalized, createdAt: meta.now, promotedAt: null };
}
export function createState(companyId: string): PipelineState {
  text(companyId, "Company", PIPELINE_LIMITS.shortText);
  return { companyId, version: 0, audits: [], jobs: [], events: [] };
}
export function calculateMonthlyHoursSaved(occurrences: number, manualMinutes: number, agentMinutes: number): number {
  requireThat([occurrences, manualMinutes, agentMinutes].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0), "Time estimates must be finite nonnegative numbers");
  requireThat(occurrences > 0 && manualMinutes > 0, "Frequency and manual minutes must be positive");
  const hours = occurrences * Math.max(0, manualMinutes - agentMinutes) / 60;
  requireThat(Number.isFinite(hours), "Monthly hours saved is too large");
  return hours;
}
export function cleanHistoricalExampleCount(job: RecurringJob, revisionId = job.currentRevisionId, completedBy?: string): number {
  const cutoff = completedBy === undefined ? Number.POSITIVE_INFINITY : timestamp(completedBy, "Qualification cutoff");
  return new Set(job.runs.filter(run => run.mode === "historical" && run.revisionId === revisionId && run.review?.verdict === "clean" && Date.parse(run.review.reviewedAt) <= cutoff).map(run => run.exampleId)).size;
}
export function canRunProduction(job: RecurringJob): boolean {
  return (job.stage === "draft" || job.stage === "run") && cleanHistoricalExampleCount(job) >= 3;
}
export function rankJobs(jobs: RecurringJob[]): RecurringJob[] {
  return [...jobs].sort((a, b) => b.monthlyHoursSaved - a.monthlyHoursSaved || a.id.localeCompare(b.id));
}

function reviewedProductionCleanStreak(job: RecurringJob, revisionId: string): number {
  const reviewed = job.runs
    .filter(run => run.mode === "production" && run.revisionId === revisionId && run.review)
    .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt) || Date.parse(left.createdAt) - Date.parse(right.createdAt));
  let clean = 0;
  for (const run of reviewed) {
    if (run.review!.verdict === "clean") clean += 1;
    else clean = 0;
  }
  return clean;
}

function revisionWasRunningAt(state: PipelineState, job: RecurringJob, revisionId: string, startedAt: string): boolean {
  const start = timestamp(startedAt, "Run start");
  let running = false;
  for (const event of state.events) {
    if (event.jobId !== job.id || (event.type !== "review_run" && event.type !== "log_run") || timestamp(event.at, "Stage event time") > start) continue;
    const eventRun = job.runs.find(run => run.id === event.detail.runId);
    if (eventRun?.revisionId !== revisionId) continue;
    if (event.detail.stage === "run") running = true;
    if (event.detail.stage === "draft" || event.detail.stage === "rebuild_required") running = false;
  }
  return running;
}

/** Pure state transition. The store commits the result and its event together. */
export function applyCommand(previous: PipelineState, command: PipelineCommand, meta: CommandMeta): PipelineState {
  text(meta.id, "Command id", PIPELINE_LIMITS.shortText); timestamp(meta.now, "Command time");
  const state = structuredClone(previous);
  let job: RecurringJob | undefined;
  if ("jobId" in command) {
    job = state.jobs.find(value => value.id === command.jobId && value.companyId === state.companyId);
    if (!job) throw new PipelineError("not_found", "Job not found in this company");
  }
  let detail: Record<string, unknown> = {};
  switch (command.type) {
    case "create_audit": {
      capacity(state.audits.length, PIPELINE_LIMITS.audits, "Audit");
      const auditEnd = timestamp(command.endAt, "Audit end");
      const duration = (auditEnd - timestamp(command.startAt, "Audit start")) / 86_400_000;
      requireThat(duration >= 30 && duration <= 90, "Audit period must be between 30 and 90 days");
      requireThat(auditEnd <= timestamp(meta.now, "Command time"), "Audit period cannot end in the future");
      requireThat(Array.isArray(command.sources) && command.sources.length === AUDIT_SOURCES.length && AUDIT_SOURCES.every(source => command.sources.filter(item => item.source === source).length === 1), "Audit must cover calendar, sent_mail, property_management, and accounting exactly once");
      for (const source of command.sources) {
        requireThat(["reviewed", "no_data", "unavailable"].includes(source.status), "Invalid source status");
        requireThat(Array.isArray(source.evidence), "Source evidence must be a list");
        requireThat(source.evidence.length <= PIPELINE_LIMITS.evidencePerSource, "Too many evidence references");
        for (const evidence of source.evidence) { text(evidence.ref, "Evidence reference", PIPELINE_LIMITS.reference); text(evidence.summary, "Evidence summary", PIPELINE_LIMITS.reason); }
        if (source.status === "reviewed") requireThat(source.evidence.length > 0, "Reviewed sources require evidence");
        else text(source.reason, "Missing source reason", PIPELINE_LIMITS.reason);
      }
      state.audits.push({ id: meta.id, companyId: state.companyId, startAt: command.startAt, endAt: command.endAt, sources: structuredClone(command.sources), createdAt: meta.now });
      detail = { auditId: meta.id }; break;
    }
    case "create_job": {
      capacity(state.jobs.length, PIPELINE_LIMITS.jobs, "Job");
      const audit = state.audits.find(value => value.id === command.auditId && value.companyId === state.companyId);
      if (!audit) throw new PipelineError("not_found", "Audit not found in this company");
      text(command.title, "Job title", PIPELINE_LIMITS.shortText);
      requireThat(command.initialDisposition === "keep" || command.initialDisposition === "draft", "Initial disposition must be keep or draft");
      if (command.initialDisposition === "draft") {
        companySkillKey(command.skillKey, state.companyId); text(command.skillContent, "Skill content"); artifactId(command.companySkillId, "Company skill id");
        requireThat(!state.jobs.some(value => value.skillKey === command.skillKey), "Each job must have its own skill key");
        requireThat(!state.jobs.some(value => value.companySkillId === command.companySkillId), "Each job must have its own company skill");
      } else requireThat(command.skillKey === undefined && command.skillContent === undefined && command.companySkillId === undefined, "Keep jobs acquire a skill when activated");
      if (command.routineId !== undefined) artifactId(command.routineId, "Routine id");
      const available = new Set(audit.sources.flatMap(source => source.evidence.map(evidence => evidence.ref)));
      requireThat(Array.isArray(command.evidenceRefs) && command.evidenceRefs.length > 0 && command.evidenceRefs.length <= PIPELINE_LIMITS.evidencePerSource * AUDIT_SOURCES.length && command.evidenceRefs.every(ref => available.has(ref)), "Job evidence must reference its audit");
      const skill = command.initialDisposition === "draft" ? revision(command.skillContent!, meta) : null;
      state.jobs.push({ id: meta.id, companyId: state.companyId, auditId: audit.id, title: command.title, evidenceRefs: [...new Set(command.evidenceRefs)], occurrencesPerMonth: command.occurrencesPerMonth, manualMinutes: command.manualMinutes, agentMinutes: command.agentMinutes, monthlyHoursSaved: calculateMonthlyHoursSaved(command.occurrencesPerMonth, command.manualMinutes, command.agentMinutes), skillKey: command.skillKey ?? null, companySkillId: command.companySkillId ?? null, routineId: command.routineId ?? null, currentRevisionId: skill?.id ?? null, revisions: skill ? [skill] : [], stage: command.initialDisposition, cleanStreak: 0, rewrittenStreak: 0, runsBlockedAt: null, examples: [], runs: [], createdAt: meta.now, updatedAt: meta.now });
      detail = { revisionId: skill?.id ?? null, revisionHash: skill?.hash ?? null }; break;
    }
    case "revise_skill":
    case "rebuild": {
      if (job!.stage === "retired") throw new PipelineError("blocked", "Retired jobs cannot change skills");
      capacity(job!.revisions.length, PIPELINE_LIMITS.revisionsPerJob, "Skill revision");
      text(command.skillContent, "Skill content");
      if (command.type === "rebuild") { text(command.reason, "Rebuild reason", PIPELINE_LIMITS.reason); text(command.requestId, "Rebuild request id", PIPELINE_LIMITS.shortText); requireThat(command.requestId === meta.id, "Rebuild request id must match its command id"); }
      if (command.type === "revise_skill" && job!.skillKey !== null) throw new PipelineError("conflict", "Existing Draft and Run skills must use rebuild with a reason");
      if (job!.skillKey === null) {
        const skillKey = command.type === "revise_skill" ? command.skillKey : undefined;
        companySkillKey(skillKey, state.companyId);
        const companySkillId = command.type === "revise_skill" ? command.companySkillId : undefined;
        artifactId(companySkillId, "Company skill id"); job!.companySkillId = companySkillId;
        requireThat(!state.jobs.some(value => value.id !== job!.id && value.companySkillId === companySkillId), "Each job must have its own company skill");
        requireThat(!state.jobs.some(value => value.skillKey === skillKey), "Each job must have its own skill key");
        job!.skillKey = skillKey;
      } else if (command.type === "revise_skill" && command.skillKey !== undefined) requireThat(command.skillKey === job!.skillKey, "A job keeps its skill key across revisions");
      if (command.type === "revise_skill") {
        if (command.companySkillId !== undefined) { artifactId(command.companySkillId, "Company skill id"); requireThat(command.companySkillId === job!.companySkillId, "A job keeps its company skill across revisions"); }
        if (command.routineId !== undefined) { artifactId(command.routineId, "Routine id"); job!.routineId = command.routineId; }
      }
      const skill = revision(command.skillContent, meta);
      requireThat(!job!.revisions.some(value => value.hash === skill.hash), "A new skill revision must change the content");
      job!.revisions.push(skill); job!.currentRevisionId = skill.id;
      job!.stage = "draft"; job!.cleanStreak = 0; job!.rewrittenStreak = 0; job!.runsBlockedAt = null;
      detail = { revisionId: skill.id, revisionHash: skill.hash, ...(command.type === "rebuild" ? { reason: command.reason } : {}) }; break;
    }
    case "add_example": {
      capacity(job!.examples.length, PIPELINE_LIMITS.examplesPerJob, "Historical example");
      if (job!.stage === "retired") throw new PipelineError("blocked", "Retired jobs cannot add examples");
      text(command.sourceRef, "Historical source reference", PIPELINE_LIMITS.reference); text(command.input, "Historical input"); text(command.actualOutcome, "Historical actual outcome");
      requireThat(!job!.examples.some(example => example.sourceRef === command.sourceRef), "Historical source references must be distinct");
      job!.examples.push({ id: meta.id, sourceRef: command.sourceRef, input: command.input, actualOutcome: command.actualOutcome, createdAt: meta.now });
      detail = { exampleId: meta.id, sourceRef: command.sourceRef }; break;
    }
    case "log_run": {
      text(command.idempotencyKey, "Run idempotency key", PIPELINE_LIMITS.shortText); text(command.originalOutput, "Original output");
      requireThat(command.mode === "historical" || command.mode === "production", "Invalid run mode");
      const startedAt = timestamp(command.startedAt, "Run start");
      const recordedAt = timestamp(meta.now, "Command time");
      requireThat(startedAt <= recordedAt, "Run start cannot be after its record time");
      const existing = job!.runs.find(run => run.idempotencyKey === command.idempotencyKey);
      if (existing) {
        if (existing.mode !== command.mode || existing.revisionId !== command.revisionId || existing.originalOutput !== command.originalOutput || existing.startedAt !== command.startedAt || existing.exampleId !== (command.exampleId ?? null) || (command.sourceRef !== undefined && existing.sourceRef !== command.sourceRef) || existing.actualMinutes !== (command.actualMinutes ?? null) || (existing.hostRunId ?? null) !== (command.hostRunId ?? null) || (existing.hostAgentId ?? null) !== (command.hostAgentId ?? null) || (existing.sourceIssueId ?? null) !== (command.sourceIssueId ?? null)) throw new PipelineError("conflict", "Idempotency key already records different output");
        return previous;
      }
      const revisionIndex = job!.revisions.findIndex(value => value.id === command.revisionId);
      if (revisionIndex < 0) throw new PipelineError("conflict", "Run must use a known skill revision");
      requireThat(command.revisionId === job!.currentRevisionId, "Outstanding runs must be recorded before rebuilding the skill");
      capacity(job!.runs.length, PIPELINE_LIMITS.runsPerJob, "Run");
      const skill = job!.revisions[revisionIndex];
      requireThat(startedAt >= timestamp(skill.createdAt, "Revision time"), "Run cannot start before its skill revision exists");
      const nextRevision = job!.revisions[revisionIndex + 1];
      if (nextRevision && startedAt >= timestamp(nextRevision.createdAt, "Next revision time")) throw new PipelineError("conflict", "Run started at or after its skill revision was replaced");
      const earlierBlock = state.events.find(event => {
        if (event.jobId !== job!.id || event.type !== "review_run" || event.detail.stage !== "rebuild_required") return false;
        const blockingRun = job!.runs.find(run => run.id === event.detail.runId);
        return blockingRun?.revisionId === skill.id;
      });
      const unresolvedEarlierBlock = earlierBlock && (skill.id !== job!.currentRevisionId || job!.stage === "rebuild_required");
      if (unresolvedEarlierBlock && startedAt >= timestamp(earlierBlock.at, "Run block time")) throw new PipelineError("blocked", "This job blocks new runs started at or after its cutoff");
      if (job!.stage === "keep") throw new PipelineError("blocked", "This job blocks new runs");
      if (job!.runsBlockedAt && startedAt >= timestamp(job!.runsBlockedAt, "Run block time")) throw new PipelineError("blocked", "This job blocks new runs started at or after its cutoff");
      if (command.mode === "production" && cleanHistoricalExampleCount(job!, skill.id, command.startedAt) < 3) throw new PipelineError("blocked", "Three clean historical examples on this revision completed before the run started are required");
      if (command.mode === "historical") {
        text(command.exampleId, "Historical example id");
        requireThat(job!.examples.some(example => example.id === command.exampleId), "Historical example must belong to this job");
        requireThat(command.sourceRef === undefined, "Historical runs use the example source reference");
        requireThat(command.hostRunId === undefined && command.hostAgentId === undefined && command.sourceIssueId === undefined, "Historical rehearsals cannot claim production run provenance");
        requireThat(!job!.runs.some(run => run.mode === "historical" && run.revisionId === skill.id && run.exampleId === command.exampleId), "Historical examples must be distinct on this revision");
      } else {
        requireThat(command.exampleId === undefined, "Production runs cannot be historical examples"); text(command.sourceRef, "Production source reference", PIPELINE_LIMITS.reference);
        text(command.hostRunId, "Host run id", PIPELINE_LIMITS.shortText); text(command.hostAgentId, "Host agent id", PIPELINE_LIMITS.shortText); text(command.sourceIssueId, "Source issue id", PIPELINE_LIMITS.shortText);
        requireThat(!state.jobs.some(candidate => candidate.runs.some(run => run.hostRunId === command.hostRunId)), "A host run can be recorded only once in this company pipeline");
        requireThat(!job!.runs.some(run => run.mode === "production" && run.sourceRef === command.sourceRef), "Production execution references must be distinct");
      }
      if (command.actualMinutes !== undefined) requireThat(typeof command.actualMinutes === "number" && Number.isFinite(command.actualMinutes) && command.actualMinutes >= 0, "Actual minutes must be a finite nonnegative number");
      const sourceRef = command.mode === "historical" ? job!.examples.find(example => example.id === command.exampleId)!.sourceRef : command.sourceRef!;
      const reviewRequired = command.mode === "historical" || !revisionWasRunningAt(state, job!, skill.id, command.startedAt);
      job!.runs.push({ id: meta.id, idempotencyKey: command.idempotencyKey, mode: command.mode, revisionId: skill.id, revisionHash: skill.hash, exampleId: command.exampleId ?? null, sourceRef, actualMinutes: command.actualMinutes ?? null, originalOutput: command.originalOutput, startedAt: command.startedAt, createdAt: meta.now, hostRunId: command.hostRunId ?? null, hostAgentId: command.hostAgentId ?? null, sourceIssueId: command.sourceIssueId ?? null, reviewRequired, review: null, pendingRewrite: null });
      if (reviewRequired && job!.stage === "run") {
        job!.stage = "draft";
        job!.runsBlockedAt = null;
        skill.promotedAt = null;
      }
      detail = { runId: meta.id, mode: command.mode, revisionId: skill.id, startedAt: command.startedAt, reviewRequired, stage: job!.stage }; break;
    }
    case "prepare_rewrite": {
      text(command.reviewerId, "Human reviewer", PIPELINE_LIMITS.shortText);
      text(command.revisedOutput, "Rewritten output");
      text(command.reason, "Rewrite reason", PIPELINE_LIMITS.reason);
      const run = job!.runs.find(value => value.id === command.runId);
      if (!run) throw new PipelineError("not_found", "Run not found in this job");
      if (run.mode !== "production" || !run.reviewRequired) throw new PipelineError("conflict", "Only a required production review can prepare a correction");
      if (run.review) {
        if (run.review.verdict === "rewritten" && run.review.reviewerId === command.reviewerId && run.review.revisedOutput === command.revisedOutput && run.review.reason === command.reason) return previous;
        throw new PipelineError("conflict", "Run already has an immutable human review");
      }
      requireThat(command.revisedOutput !== run.originalOutput, "Rewritten output must differ from the original");
      if (run.pendingRewrite) {
        if (run.pendingRewrite.reviewerId === command.reviewerId && run.pendingRewrite.revisedOutput === command.revisedOutput && run.pendingRewrite.reason === command.reason) return previous;
        throw new PipelineError("conflict", "A different correction is already prepared for this run");
      }
      const oldestPending = job!.runs
        .filter(value => value.mode === "production" && value.revisionId === run.revisionId && value.reviewRequired && !value.review)
        .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt))[0];
      if (oldestPending?.id !== run.id) throw new PipelineError("conflict", "Review production runs in execution order, oldest pending first");
      run.pendingRewrite = { reviewerId: command.reviewerId, preparedAt: meta.now, revisedOutput: command.revisedOutput, reason: command.reason };
      detail = { runId: run.id, revisionId: run.revisionId, reviewerId: command.reviewerId };
      break;
    }
    case "review_run": {
      text(command.reviewerId, "Human reviewer", PIPELINE_LIMITS.shortText);
      requireThat(command.verdict === "clean" || command.verdict === "rewritten", "Review must be clean or rewritten");
      const run = job!.runs.find(value => value.id === command.runId);
      if (!run) throw new PipelineError("not_found", "Run not found in this job");
      if (!run.reviewRequired) throw new PipelineError("conflict", "This run does not require human review");
      if (run.review) {
        if (run.review.verdict === command.verdict && run.review.reviewerId === command.reviewerId && run.review.revisedOutput === (command.revisedOutput ?? null) && run.review.reason === (command.reason ?? null) && (run.review.correctionCommentId ?? null) === (command.correctionCommentId ?? null)) return previous;
        throw new PipelineError("conflict", "Run already has an immutable human review");
      }
      if (run.mode === "production") {
        const oldestPending = job!.runs
          .filter(value => value.mode === "production" && value.revisionId === run.revisionId && value.reviewRequired && !value.review)
          .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt))[0];
        if (oldestPending?.id !== run.id) throw new PipelineError("conflict", "Review production runs in execution order, oldest pending first");
      }
      if (command.verdict === "rewritten") {
        text(command.revisedOutput, "Rewritten output");
        text(command.reason, "Rewrite reason", PIPELINE_LIMITS.reason);
        requireThat(command.revisedOutput !== run.originalOutput, "Rewritten output must differ from the original");
        if (run.mode === "production") {
          text(command.correctionCommentId, "Correction comment id", PIPELINE_LIMITS.shortText);
          requireThat(run.pendingRewrite?.reviewerId === command.reviewerId && run.pendingRewrite.revisedOutput === command.revisedOutput && run.pendingRewrite.reason === command.reason, "Rewritten production review must match its prepared correction");
        }
        else requireThat(command.correctionCommentId === undefined, "Historical reviews do not create issue correction comments");
      } else {
        requireThat(!run.pendingRewrite, "A prepared correction must be completed before another review can be saved");
        requireThat(command.revisedOutput === undefined, "Clean reviews preserve the original output");
        requireThat(command.correctionCommentId === undefined, "Clean reviews do not use correction comments");
      }
      if (command.reason !== undefined) text(command.reason, "Review reason", PIPELINE_LIMITS.reason);
      if (command.correctionDelivery !== undefined) requireThat(run.mode === "production" && command.verdict === "rewritten", "Only rewritten production reviews have correction delivery");
      if (run.mode === "production" && command.verdict === "rewritten") {
        run.correctionDelivery = { ...correctionDelivery(command.correctionDelivery ?? { status: "pending", pending: [{ agentId: run.hostAgentId!, reason: "Agent delivery has not been confirmed. Retry correction delivery." }] }), updatedAt: meta.now };
      }
      run.review = { verdict: command.verdict, reviewerId: command.reviewerId, reviewedAt: meta.now, revisedOutput: command.revisedOutput ?? null, reason: command.reason ?? null, correctionCommentId: command.correctionCommentId ?? null };
      run.pendingRewrite = null;
      if (run.revisionId === job!.currentRevisionId && job!.stage !== "retired" && job!.stage !== "rebuild_required") {
        job!.cleanStreak = reviewedProductionCleanStreak(job!, run.revisionId);
        job!.rewrittenStreak = command.verdict === "rewritten" ? job!.rewrittenStreak + 1 : 0;
        const pendingProductionReview = job!.runs.some(value => value.mode === "production" && value.revisionId === job!.currentRevisionId && value.reviewRequired && !value.review);
        const currentRevision = job!.revisions.find(value => value.id === job!.currentRevisionId)!;
        if (job!.rewrittenStreak >= 3) {
          job!.stage = "rebuild_required"; job!.runsBlockedAt = meta.now; currentRevision.promotedAt = null;
        } else if (job!.cleanStreak >= 5 && job!.rewrittenStreak === 0 && !pendingProductionReview) {
          if (job!.stage !== "run") currentRevision.promotedAt = meta.now;
          job!.stage = "run"; job!.runsBlockedAt = null;
        } else if (job!.stage === "run") {
          job!.stage = "draft"; job!.runsBlockedAt = null; currentRevision.promotedAt = null;
        }
      }
      detail = { runId: run.id, revisionId: run.revisionId, verdict: command.verdict, reviewerId: command.reviewerId, ...(command.correctionCommentId ? { correctionCommentId: command.correctionCommentId } : {}), stage: job!.stage }; break;
    }
    case "record_correction_delivery": {
      const run = job!.runs.find(value => value.id === command.runId);
      if (!run) throw new PipelineError("not_found", "Run not found in this job");
      requireThat(run.mode === "production" && run.review?.verdict === "rewritten", "Only reviewed production corrections have delivery state");
      requireThat(run.review.reviewerId === command.reviewerId, "Only the original reviewer can record correction delivery");
      requireThat(run.review.correctionCommentId === command.correctionCommentId, "Delivery must reference the saved correction comment");
      const delivery = correctionDelivery(command.delivery);
      if (run.correctionDelivery?.status === "accepted") return previous;
      if (run.correctionDelivery?.status === delivery.status && JSON.stringify(run.correctionDelivery.pending) === JSON.stringify(delivery.pending)) return previous;
      run.correctionDelivery = { ...delivery, updatedAt: meta.now };
      detail = { runId: run.id, correctionCommentId: command.correctionCommentId, reviewerId: command.reviewerId, delivery };
      break;
    }
    case "retire":
      text(command.reason, "Retirement reason", PIPELINE_LIMITS.reason);
      if (job!.stage === "retired") throw new PipelineError("conflict", "Job is already retired");
      job!.stage = "retired"; job!.runsBlockedAt ??= meta.now; detail = { reason: command.reason }; break;
    default: throw new PipelineError("invalid_input", "Unknown pipeline command");
  }
  if (job) job.updatedAt = meta.now;
  requireThat(!previous.events.some(event => event.id === meta.id), "Command id was already used");
  capacity(state.events.length, PIPELINE_LIMITS.events, "Event");
  state.version += 1;
  state.events.push({ id: meta.id, companyId: state.companyId, type: command.type, jobId: "jobId" in command ? command.jobId : command.type === "create_job" ? meta.id : null, at: meta.now, detail });
  if (Buffer.byteLength(JSON.stringify(state), "utf8") > PIPELINE_LIMITS.stateBytes) throw new PipelineError("blocked", "Company history exceeds the storage limit; export history before adding more");
  return state;
}
