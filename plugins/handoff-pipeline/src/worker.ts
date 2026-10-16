import { createHash, randomUUID } from "node:crypto";
import {
  definePlugin,
  runWorker,
  type PluginApiRequestInput,
  type PluginApiResponse,
  type PluginContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { correctionCommentBody, type CorrectionDelivery, type JobRun, type PipelineCommand, type PipelineState, type RecurringJob, type RunCounts, type SourceCoverage } from "./contracts.js";
import { isCompanyAllowed, type HandOffConfig } from "./company-access.js";
import { storedCorrectionBodyMatches } from "./host-correction.js";
import { applyCommand, PipelineError, rankJobs } from "./lifecycle.js";
import manifest from "./manifest.js";
import { PipelineStore } from "./store.js";
import { normalizedSkillContent, readCompanySkill, verifyCompanySkill } from "./skill-verifier.js";

type JsonObject = Record<string, unknown>;

let workerContext: PluginContext | null = null;
let stopActivityRetryLoop: (() => void) | null = null;

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function commandMeta(id?: string) {
  return { id: id ?? randomUUID(), now: new Date().toISOString() };
}

function errorResponse(error: unknown): PluginApiResponse {
  if (error instanceof PipelineError) {
    const status = { invalid_input: 400, not_found: 404, conflict: 409, blocked: 422 }[error.code];
    return { status, body: { error: error.message, code: error.code } };
  }
  return { status: 500, body: { error: error instanceof Error ? error.message : String(error) } };
}

function toolError(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { error: message, data: { error: message } };
}

function createStore(ctx: PluginContext): PipelineStore {
  if (!ctx.db.namespace) throw new Error("Hand-off database is not ready");
  return new PipelineStore(ctx.db);
}

async function allowed(ctx: PluginContext, companyId: string): Promise<boolean> {
  const config = (await ctx.config.get()) as HandOffConfig;
  return isCompanyAllowed(config.allowedCompanies, companyId);
}

function activityId(companyId: string, eventId: string): string {
  const hex = createHash("sha256").update(`${manifest.id}\u0000${companyId}\u0000${eventId}`).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

async function recordActivity(
  ctx: PluginContext,
  event: PipelineState["events"][number],
): Promise<boolean> {
  try {
    await ctx.activity.log({
      idempotencyKey: activityId(event.companyId, event.id),
      companyId: event.companyId,
      message: `handoff.${event.type}`,
      entityType: "handoff_job",
      entityId: event.jobId ?? undefined,
      metadata: { eventId: event.id },
    });
    return true;
  } catch (error) {
    ctx.logger.warn("Hand-off state was saved but its host activity entry failed", {
      companyId: event.companyId,
      command: event.type,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function deliverPendingActivities(ctx: PluginContext, companyId?: string): Promise<void> {
  const store = createStore(ctx);
  for (let batch = 0; batch < 20; batch++) {
    const pending = await store.pendingActivities(companyId);
    let acknowledged = 0;
    for (const event of pending) {
      if (!await recordActivity(ctx, event)) continue;
      try {
        await store.acknowledgeActivity(event.companyId, event.id);
        acknowledged += 1;
      } catch (error) {
        ctx.logger.warn("Hand-off host activity was logged but its delivery receipt could not be saved", {
          companyId: event.companyId,
          eventId: event.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (pending.length < 100 || acknowledged === 0) break;
  }
}

export function startActivityDeliveryRetryLoop(ctx: PluginContext, intervalMs = 30_000): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void deliverPendingActivities(ctx)
      .catch((error) => ctx.logger.warn("Hand-off activity retry could not read its durable queue", {
        error: error instanceof Error ? error.message : String(error),
      }))
      .finally(() => { running = false; });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

async function dispatch(ctx: PluginContext, companyId: string, command: PipelineCommand, expectedVersion?: number) {
  const meta = commandMeta(command.type === "rebuild" ? command.requestId : undefined);
  const state = await createStore(ctx).dispatch(companyId, command, meta, expectedVersion);
  await deliverPendingActivities(ctx, companyId);
  return { state, event: state.events.find((candidate) => candidate.id === meta.id) ?? null };
}

function findJob(state: PipelineState, jobId: string): RecurringJob | undefined {
  return state.jobs.find((job) => job.id === jobId);
}

function flatRuns(state: PipelineState) {
  return state.jobs.flatMap((job) => job.runs.map((run) => ({ ...run, jobId: job.id, jobTitle: job.title })));
}

interface HostRunRecord {
  id: string; company_id: string; agent_id: string; status: string;
  started_at: string | Date | null; finished_at: string | Date | null;
  result_json: Record<string, unknown> | null; context_snapshot: Record<string, unknown> | null;
}

interface CorrectionWakeRunRecord {
  id: string;
  wakeup_request_id: string | null;
  agent_id: string;
  status: string;
  started_at: string | Date | null;
}

interface CorrectionCommentRecord {
  id: string;
  correction_recipient_agent_ids: unknown;
}

interface CorrectionWakeReceiptRecord {
  id: string;
  agent_id: string;
  idempotency_key: string;
  status: string;
  reason: string | null;
  run_id?: string | null;
  payload?: Record<string, unknown> | null;
}

function iso(value: string | Date | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function runCounts(value: unknown): RunCounts | null {
  const candidate = record(value);
  if (!candidate) return null;
  const values = [candidate.itemsRead, candidate.entriesAdded, candidate.changesProposed];
  if (!values.every((item) => typeof item === "number" && Number.isSafeInteger(item) && item >= 0)) return null;
  return { itemsRead: values[0] as number, entriesAdded: values[1] as number, changesProposed: values[2] as number };
}

function hostSummary(result: Record<string, unknown> | null): string | null {
  for (const key of ["summary", "result", "message", "error"]) {
    const value = result?.[key];
    if (typeof value === "string" && value.trim()) return value.slice(0, 500);
  }
  return null;
}

async function readHostRun(ctx: PluginContext, companyId: string, runId: string): Promise<HostRunRecord | null> {
  const rows = await ctx.db.query<HostRunRecord>(
    "SELECT id, company_id, agent_id, status, started_at, finished_at, result_json, context_snapshot FROM public.heartbeat_runs WHERE id = $1 AND company_id = $2",
    [runId, companyId],
  );
  return rows[0] ?? null;
}

export function correctionDeliveryForReceipts(
  receipts: CorrectionWakeReceiptRecord[],
  rows: Array<{ agent_id: string; status: string; started_at: string | Date | null }>,
  intendedRecipientAgentIds: string[] = receipts.map((receipt) => receipt.agent_id),
): CorrectionDelivery {
  const accepted = new Set(rows.filter((row) => row.started_at !== null || row.status === "queued" || row.status === "running").map((row) => row.agent_id));
  const receiptByAgent = new Map<string, CorrectionWakeReceiptRecord>();
  for (const receipt of receipts) {
    const current = receiptByAgent.get(receipt.agent_id);
    if (!current || (current.status === "skipped" && receipt.status !== "skipped")) receiptByAgent.set(receipt.agent_id, receipt);
  }
  const pending = [...new Set(intendedRecipientAgentIds)]
    .filter((agentId) => !accepted.has(agentId))
    .map((agentId) => {
      const receipt = receiptByAgent.get(agentId);
      const reason = !receipt
        ? "The host has not recorded an agent delivery receipt for this correction."
        : receipt.status === "skipped" && receipt.reason
        ? `The host skipped agent delivery (${receipt.reason}).`
        : receipt.status === "deferred_issue_execution" || receipt.status === "coalesced"
          ? "Correction delivery is waiting for the current issue execution to finish."
        : "The host has not confirmed a queued agent run for this correction.";
      return { agentId, reason };
    });
  return { status: pending.length ? "pending" : "accepted", pending };
}

export async function correctionWakeRunsForReceipts(
  ctx: PluginContext,
  companyId: string,
  receipts: CorrectionWakeReceiptRecord[],
): Promise<CorrectionWakeRunRecord[]> {
  const readRuns = async (candidates: CorrectionWakeReceiptRecord[]): Promise<CorrectionWakeRunRecord[]> => {
    if (!candidates.length) return [];
    const runIds = [...new Set(candidates.map((receipt) => receipt.run_id).filter((id): id is string => Boolean(id)))];
    const receiptIds = [...new Set(candidates.map((receipt) => receipt.id))];
    const params: unknown[] = [companyId];
    const clauses: string[] = [];
    if (runIds.length) {
      const placeholders = runIds.map((id) => {
        params.push(id);
        return `$${params.length}`;
      }).join(", ");
      clauses.push(`h.id IN (${placeholders})`);
    }
    if (receiptIds.length) {
      const placeholders = receiptIds.map((id) => {
        params.push(id);
        return `$${params.length}`;
      }).join(", ");
      clauses.push(`h.wakeup_request_id IN (${placeholders})`);
    }
    const rows = await ctx.db.query<CorrectionWakeRunRecord>(
      `SELECT h.id, h.wakeup_request_id, h.agent_id, h.status, h.started_at
         FROM public.heartbeat_runs h
        WHERE h.company_id = $1 AND (${clauses.join(" OR ")})`,
      params,
    );
    const runAgents = new Map<string, Set<string>>();
    const receiptAgents = new Map<string, Set<string>>();
    for (const candidate of candidates) {
      if (candidate.status === "skipped") continue;
      if (candidate.run_id) {
        const agents = runAgents.get(candidate.run_id) ?? new Set<string>();
        agents.add(candidate.agent_id);
        runAgents.set(candidate.run_id, agents);
      }
      const agents = receiptAgents.get(candidate.id) ?? new Set<string>();
      agents.add(candidate.agent_id);
      receiptAgents.set(candidate.id, agents);
    }
    return rows.filter((row) => runAgents.get(row.id)?.has(row.agent_id)
      || (row.wakeup_request_id !== null && receiptAgents.get(row.wakeup_request_id)?.has(row.agent_id)));
  };

  const directRows = await readRuns(receipts);
  const linkedReceiptIds = new Set(directRows.map((row) => row.wakeup_request_id).filter((id): id is string => id !== null));
  const linkedRunIds = new Set(directRows.map((row) => row.id));
  const deferredById = new Map<string, Set<string>>();
  for (const receipt of receipts) {
    const hasDirectRun = linkedReceiptIds.has(receipt.id) || (typeof receipt.run_id === "string" && linkedRunIds.has(receipt.run_id));
    const deferredId = receipt.status === "coalesced" && !hasDirectRun
      ? record(receipt.payload)?.deferredWakeupRequestId
      : null;
    if (typeof deferredId !== "string" || !deferredId.trim()) continue;
    const agentIds = deferredById.get(deferredId) ?? new Set<string>();
    agentIds.add(receipt.agent_id);
    deferredById.set(deferredId, agentIds);
  }
  if (!deferredById.size) return directRows;

  const deferredIds = [...deferredById.keys()];
  const placeholders = deferredIds.map((_, index) => `$${index + 2}`).join(", ");
  const deferredReceipts = (await ctx.db.query<CorrectionWakeReceiptRecord>(
    `SELECT w.id, w.agent_id, w.idempotency_key, w.status, w.reason, w.run_id, w.payload
       FROM public.agent_wakeup_requests w
      WHERE w.company_id = $1 AND w.id IN (${placeholders})`,
    [companyId, ...deferredIds],
  )).filter((receipt) => deferredById.get(receipt.id)?.has(receipt.agent_id));
  return [...directRows, ...await readRuns(deferredReceipts)];
}

async function correctionDeliveryFromHost(ctx: PluginContext, companyId: string, run: JobRun, commentId: string, reviewerId: string): Promise<CorrectionDelivery> {
  if (!run.hostAgentId || !run.sourceIssueId) throw new PipelineError("conflict", "Production correction delivery requires verified host provenance");
  const comments = await ctx.db.query<CorrectionCommentRecord>(
    `SELECT c.id, c.correction_recipient_agent_ids FROM public.issue_comments c
      WHERE c.id = $1 AND c.company_id = $2 AND c.issue_id = $3
        AND c.intent = 'correction' AND c.author_user_id = $4 AND c.author_agent_id IS NULL
        AND c.expected_assignee_agent_id = $5`,
    [commentId, companyId, run.sourceIssueId, reviewerId, run.hostAgentId],
  );
  if (!comments[0]) throw new PipelineError("conflict", "Correction delivery requires the saved run-bound board correction");
  const receiptPrefix = `issue-comment:${commentId}:`;
  const receipts = (await ctx.db.query<CorrectionWakeReceiptRecord>(
    `SELECT w.id, w.agent_id, w.idempotency_key, w.status, w.reason, w.run_id, w.payload
       FROM public.agent_wakeup_requests w
      WHERE w.company_id = $1 AND w.requested_by_actor_type = 'user' AND w.requested_by_actor_id = $2
        AND w.idempotency_key LIKE $3
      ORDER BY w.created_at DESC`,
    [companyId, reviewerId, `${receiptPrefix}%`],
  )).filter((receipt) => receipt.idempotency_key === `${receiptPrefix}assignee:${receipt.agent_id}`
    || receipt.idempotency_key === `${receiptPrefix}mention:${receipt.agent_id}`);
  const storedRecipients = comments[0].correction_recipient_agent_ids;
  if (storedRecipients !== null && (!Array.isArray(storedRecipients)
    || storedRecipients.some((agentId) => typeof agentId !== "string" || !agentId.trim()))) {
    throw new PipelineError("conflict", "Correction delivery recipient identity is invalid");
  }
  const intendedRecipients = storedRecipients === null
    ? [...new Set(receipts.map((receipt) => receipt.agent_id))]
    : [...new Set(storedRecipients as string[])];
  if (!intendedRecipients.includes(run.hostAgentId)) {
    throw new PipelineError(
      "conflict",
      storedRecipients === null
        ? "Correction delivery requires the original agent's host delivery receipt"
        : "Correction delivery recipients must include the original agent",
    );
  }
  const intendedSet = new Set(intendedRecipients);
  const relevantReceipts = receipts.filter((receipt) => intendedSet.has(receipt.agent_id));
  const rows = await correctionWakeRunsForReceipts(ctx, companyId, relevantReceipts);
  return correctionDeliveryForReceipts(relevantReceipts, rows, intendedRecipients);
}

async function productionCommand(ctx: PluginContext, runContext: ToolRunContext, command: Extract<PipelineCommand, { type: "log_run" }>, exactRetry: boolean): Promise<Extract<PipelineCommand, { type: "log_run" }>> {
  const host = await readHostRun(ctx, runContext.companyId, runContext.runId);
  if (!host || host.agent_id !== runContext.agentId) throw new PipelineError("conflict", "Production results require this tool call's verified host run and agent");
  const startedAt = iso(host.started_at);
  const sourceIssueId = typeof host.context_snapshot?.issueId === "string" ? host.context_snapshot.issueId : null;
  if (!startedAt || !sourceIssueId) throw new PipelineError("blocked", "Production results require an issue-bound host run with a recorded start time");
  if (!exactRetry) {
    const issue = await ctx.db.query<{ id: string; assignee_agent_id: string | null }>(
      "SELECT id, assignee_agent_id FROM public.issues WHERE id = $1 AND company_id = $2",
      [sourceIssueId, runContext.companyId],
    );
    if (issue[0]?.assignee_agent_id !== runContext.agentId) throw new PipelineError("conflict", "The production run's source issue must still be assigned to the invoking agent");
  }
  return {
    ...command,
    idempotencyKey: `host-run:${runContext.runId}`,
    startedAt,
    hostRunId: runContext.runId,
    hostAgentId: runContext.agentId,
    sourceIssueId,
  };
}

async function hydrateState(ctx: PluginContext, state: PipelineState): Promise<PipelineState> {
  const hydrated = structuredClone(state);
  const productionRuns = hydrated.jobs.flatMap((job) => job.runs).filter((run) => run.mode === "production" && run.hostRunId);
  if (productionRuns.length) {
    const ids = [...new Set(productionRuns.map((run) => run.hostRunId!))];
    const placeholders = ids.map((_, index) => `$${index + 2}`).join(", ");
    const rows = await ctx.db.query<HostRunRecord>(
      `SELECT id, company_id, agent_id, status, started_at, finished_at, result_json, context_snapshot FROM public.heartbeat_runs WHERE company_id = $1 AND id IN (${placeholders})`,
      [state.companyId, ...ids],
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const run of productionRuns) {
      const host = byId.get(run.hostRunId!);
      const result = record(host?.result_json);
      run.hostStatus = host?.status ?? null;
      run.hostFinishedAt = iso(host?.finished_at ?? null);
      run.hostSummary = hostSummary(result);
      run.runCounts = runCounts(result?.runCounts);
      run.runCountsReporting = record(result?.runCountsReporting);
    }
  }
  const reviewed = hydrated.jobs.flatMap((job) => job.runs).filter((run) => run.review?.correctionCommentId && run.hostAgentId);
  if (reviewed.length) {
    const commentIds = [...new Set(reviewed.map((run) => run.review!.correctionCommentId!))];
    const placeholders = commentIds.map((_, index) => `$${index + 2}`).join(", ");
    const approvals = await ctx.db.query<{ id: string; status: string; payload: Record<string, unknown> }>(
      `SELECT id, status, payload FROM public.approvals WHERE company_id = $1 AND type = 'instruction_change' AND payload ->> 'sourceCommentId' IN (${placeholders}) ORDER BY created_at DESC`,
      [state.companyId, ...commentIds],
    );
    const bySourceAndAgent = new Map<string, { id: string; status: string }>();
    for (const approval of approvals) {
      const sourceCommentId = approval.payload.sourceCommentId;
      const targetAgentId = approval.payload.targetAgentId;
      if (typeof sourceCommentId === "string" && typeof targetAgentId === "string") {
        const key = `${sourceCommentId}:${targetAgentId}`;
        if (!bySourceAndAgent.has(key)) bySourceAndAgent.set(key, { id: approval.id, status: approval.status });
      }
    }
    for (const run of reviewed) run.review!.instructionChangeApproval = bySourceAndAgent.get(`${run.review!.correctionCommentId}:${run.hostAgentId}`) ?? null;
  }
  return hydrated;
}

type ProductionReviewCommand = Extract<PipelineCommand, { type: "review_run" | "prepare_rewrite" }>;

async function verifyProductionReview(ctx: PluginContext, companyId: string, run: JobRun, command: ProductionReviewCommand): Promise<void> {
  if (!run.hostRunId || !run.hostAgentId || !run.sourceIssueId) throw new PipelineError("conflict", "Production review requires verified host run provenance");
  const host = await readHostRun(ctx, companyId, run.hostRunId);
  if (!host || host.agent_id !== run.hostAgentId || iso(host.started_at) !== run.startedAt || host.context_snapshot?.issueId !== run.sourceIssueId) {
    throw new PipelineError("conflict", "Production run provenance no longer matches the host run");
  }
  const result = record(host.result_json);
  const terminal = ["succeeded", "failed", "cancelled", "timed_out"].includes(host.status);
  if (!terminal || !host.finished_at || !runCounts(result?.runCounts) || record(result?.runCountsReporting)?.status !== "reported") {
    throw new PipelineError("blocked", "A production review requires a finished host run with valid reported counts");
  }
  if (command.type === "review_run" && command.verdict === "clean" && host.status !== "succeeded") {
    throw new PipelineError("blocked", "A clean production review requires a succeeded host run");
  }
  if (command.type === "review_run" && command.verdict === "rewritten") {
    const comments = await ctx.db.query<{ id: string; idempotency_key: string | null; expected_assignee_agent_id: string | null; body: string }>(
      `SELECT c.id, c.idempotency_key, c.expected_assignee_agent_id, c.body FROM public.issue_comments c
       INNER JOIN public.issues i ON i.id = c.issue_id
       WHERE c.id = $1 AND c.company_id = $2 AND c.issue_id = $3
         AND c.intent = 'correction' AND c.author_user_id = $4 AND c.author_agent_id IS NULL
         AND i.company_id = $2`,
      [command.correctionCommentId, companyId, run.sourceIssueId, command.reviewerId],
    );
    const expectedBody = correctionCommentBody(run.id, command.revisedOutput ?? "", command.reason ?? "");
    if (!comments[0] || comments[0].idempotency_key !== `handoff.review:${run.id}` || comments[0].expected_assignee_agent_id !== run.hostAgentId || !storedCorrectionBodyMatches(comments[0].body, expectedBody)) throw new PipelineError("conflict", "A rewritten production review requires its exact prepared, run-bound board correction for the original agent on the source issue");
  }
}

interface SkillDrift { jobId: string; reason: string }

async function currentSkillDrift(ctx: PluginContext, companyId: string, job: RecurringJob): Promise<SkillDrift | null> {
  if ((job.stage !== "draft" && job.stage !== "run") || !job.companySkillId || !job.skillKey || !job.currentRevisionId) return null;
  const revision = job.revisions.find((candidate) => candidate.id === job.currentRevisionId);
  if (!revision) return { jobId: job.id, reason: "The current skill revision is missing. Do not execute this job." };
  try {
    const live = await readCompanySkill(ctx, companyId, job.companySkillId, job.skillKey);
    if (normalizedSkillContent(live.markdown) !== normalizedSkillContent(revision.content)) {
      return { jobId: job.id, reason: "The linked company skill changed after this revision was verified. Do not execute it until the job is rebuilt and qualified." };
    }
    return null;
  } catch (error) {
    return { jobId: job.id, reason: `${error instanceof Error ? error.message : String(error)} Do not execute this job until its company skill is restored and the job is rebuilt.` };
  }
}

async function pipelineSkillDrift(ctx: PluginContext, companyId: string, state: PipelineState): Promise<SkillDrift[]> {
  return (await Promise.all(state.jobs.map((job) => currentSkillDrift(ctx, companyId, job)))).filter((value): value is SkillDrift => value !== null);
}

function compactPipeline(state: PipelineState, skillDrift: SkillDrift[]) {
  const driftByJob = new Map(skillDrift.map((item) => [item.jobId, item.reason]));
  return {
    companyId: state.companyId,
    version: state.version,
    audits: state.audits.map((audit) => ({ id: audit.id, startAt: audit.startAt, endAt: audit.endAt, sources: audit.sources.map((source) => ({ source: source.source, status: source.status, evidenceCount: source.evidence.length })) })),
    jobs: rankJobs(state.jobs).map((job) => ({
      id: job.id,
      title: job.title,
      stage: job.stage,
      monthlyHoursSaved: job.monthlyHoursSaved,
      companySkillId: job.companySkillId,
      skillKey: job.skillKey,
      currentRevisionId: job.currentRevisionId,
      historicalExamples: job.examples.length,
      pendingReviews: job.runs.filter((run) => run.reviewRequired && !run.review).length,
      cleanStreak: job.cleanStreak,
      rewrittenStreak: job.rewrittenStreak,
      executionBlocked: driftByJob.has(job.id),
      executionBlockReason: driftByJob.get(job.id) ?? null,
    })),
  };
}

async function verifyCommandSkill(
  ctx: PluginContext,
  companyId: string,
  command: PipelineCommand,
  state?: PipelineState,
): Promise<void> {
  if (command.type === "create_job") {
    if (command.initialDisposition === "draft") await verifyCompanySkill(ctx, companyId, command.companySkillId!, command.skillKey!, command.skillContent!);
    return;
  }
  if (command.type === "log_run" || command.type === "review_run" || command.type === "prepare_rewrite") {
    const current = state ?? await createStore(ctx).read(companyId);
    const job = current.jobs.find((candidate) => candidate.id === command.jobId);
    if (!job || !job.companySkillId || !job.skillKey) throw new PipelineError("not_found", "Job or linked company skill was not found in this company");
    if (command.type === "log_run" && job.runs.some((candidate) => candidate.idempotencyKey === command.idempotencyKey)) return;
    const run = command.type === "review_run" || command.type === "prepare_rewrite" ? job.runs.find((candidate) => candidate.id === command.runId) : undefined;
    const revisionId = command.type === "log_run" ? command.revisionId : run?.revisionId;
    const revision = job.revisions.find((candidate) => candidate.id === revisionId);
    if (!revision) throw new PipelineError("conflict", "Run must use a known skill revision");
    const live = await readCompanySkill(ctx, companyId, job.companySkillId, job.skillKey);
    const contentMatches = normalizedSkillContent(live.markdown) === normalizedSkillContent(revision.content);
    const unsafeRunRecord = command.type === "log_run" && !contentMatches;
    const unsafeCurrentReview = (command.type === "review_run" || command.type === "prepare_rewrite") && revision.id === job.currentRevisionId && !contentMatches;
    if (unsafeRunRecord || unsafeCurrentReview) {
      throw new PipelineError("conflict", "The linked company skill changed after this revision was verified. Rebuild the job before new current-revision work; old-revision runs cannot be newly recorded after the skill changes.");
    }
    return;
  }
  if (command.type !== "revise_skill" && command.type !== "rebuild") return;
  const current = state ?? await createStore(ctx).read(companyId);
  const job = current.jobs.find((candidate) => candidate.id === command.jobId);
  if (!job) throw new PipelineError("not_found", "Job not found in this company");
  const companySkillId = command.type === "revise_skill" ? command.companySkillId ?? job.companySkillId : job.companySkillId;
  const skillKey = command.type === "revise_skill" ? command.skillKey ?? job.skillKey : job.skillKey;
  if (!companySkillId || !skillKey) throw new PipelineError("invalid_input", "A real company skill is required before this job can enter Draft");
  await verifyCompanySkill(ctx, companyId, companySkillId, skillKey, command.skillContent);
}

export async function handleApiRequest(ctx: PluginContext, input: PluginApiRequestInput): Promise<PluginApiResponse> {
  if (!(await allowed(ctx, input.companyId))) {
    ctx.logger.warn("ECOMPANY_NOT_ALLOWED", { route: input.routeKey, companyId: input.companyId });
    return { status: 403, body: { error: "Hand-off is not enabled for this company." } };
  }
  try {
    const store = createStore(ctx);
    const body = object(input.body);
    if (input.routeKey === "handoff.summary") {
      const state = await hydrateState(ctx, await store.read(input.companyId));
      return { status: 200, body: { state, skillDrift: await pipelineSkillDrift(ctx, input.companyId, state) } };
    }
    if (input.routeKey === "handoff.list-audits") {
      const state = await store.read(input.companyId);
      return { status: 200, body: { audits: [...state.audits].reverse() } };
    }
    if (input.routeKey === "handoff.list-jobs") {
      const state = await hydrateState(ctx, await store.read(input.companyId));
      return { status: 200, body: { jobs: rankJobs(state.jobs) } };
    }
    if (input.routeKey === "handoff.list-runs" || input.routeKey === "handoff.list-review") {
      const state = await hydrateState(ctx, await store.read(input.companyId));
      const runs = flatRuns(state);
      return { status: 200, body: { runs: input.routeKey === "handoff.list-review" ? runs.filter((run) => run.reviewRequired && !run.review) : [...runs].reverse() } };
    }
    if (input.routeKey === "handoff.preflight-rebuild") {
      const command = { ...body, type: "rebuild", jobId: input.params.jobId } as Extract<PipelineCommand, { type: "rebuild" }>;
      const state = await store.read(input.companyId);
      applyCommand(state, command, commandMeta(command.requestId));
      return { status: 200, body: { version: state.version } };
    }

    let command: PipelineCommand;
    let expectedVersion: number | undefined;
    switch (input.routeKey) {
      case "handoff.create-audit":
        command = { type: "create_audit", startAt: body.startAt as string, endAt: body.endAt as string, sources: body.sources as SourceCoverage[] };
        break;
      case "handoff.create-job":
        command = { ...body, type: "create_job" } as PipelineCommand;
        break;
      case "handoff.update-job":
        command = { ...body, type: "revise_skill", jobId: input.params.jobId } as PipelineCommand;
        break;
      case "handoff.add-example":
        command = { ...body, type: "add_example", jobId: input.params.jobId } as PipelineCommand;
        break;
      case "handoff.add-run":
        if (body.mode === "production") throw new PipelineError("blocked", "Production runs are recorded only by the executing agent through the Hand-off tool");
        command = { ...body, type: "log_run", jobId: input.params.jobId } as PipelineCommand;
        break;
      case "handoff.rebuild-job":
        expectedVersion = body.expectedVersion as number;
        if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new PipelineError("invalid_input", "Rebuild preflight version is required");
        command = { type: "rebuild", jobId: input.params.jobId, skillContent: body.skillContent as string, reason: body.reason as string, requestId: body.requestId as string };
        break;
      case "handoff.retire-job":
        command = { ...body, type: "retire", jobId: input.params.jobId } as PipelineCommand;
        break;
      case "handoff.prepare-rewrite": {
        if (input.actor.actorType !== "user" || !(input.actor.userId ?? input.actor.actorId)) {
          return { status: 403, body: { error: "A signed-in person must review this run." } };
        }
        const current = await store.read(input.companyId);
        const job = current.jobs.find((candidate) => candidate.runs.some((run) => run.id === input.params.runId));
        if (!job) throw new PipelineError("not_found", "Run not found in this company");
        command = {
          ...body,
          type: "prepare_rewrite",
          jobId: job.id,
          runId: input.params.runId,
          reviewerId: input.actor.userId ?? input.actor.actorId,
        } as PipelineCommand;
        break;
      }
      case "handoff.record-correction-delivery":
      case "handoff.review-run": {
        if (input.actor.actorType !== "user" || !(input.actor.userId ?? input.actor.actorId)) {
          return { status: 403, body: { error: "A signed-in person must review this run." } };
        }
        const before = await store.read(input.companyId);
        const job = before.jobs.find((candidate) => candidate.runs.some((run) => run.id === input.params.runId));
        if (!job) throw new PipelineError("not_found", "Run not found in this company");
        command = {
          ...body,
          type: input.routeKey === "handoff.review-run" ? "review_run" : "record_correction_delivery",
          jobId: job.id,
          runId: input.params.runId,
          reviewerId: input.actor.userId ?? input.actor.actorId,
        } as PipelineCommand;
        break;
      }
      default:
        return { status: 404, body: { error: `Unknown Hand-off route: ${input.routeKey}` } };
    }
    const before = expectedVersion === undefined ? undefined : await store.read(input.companyId);
    if (before && before.version !== expectedVersion) throw new PipelineError("conflict", "Pipeline changed after rebuild preflight; review the latest job before saving the skill");
    if (command.type === "review_run" || command.type === "prepare_rewrite") {
      const reviewState = before ?? await store.read(input.companyId);
      const reviewRunId = command.runId;
      const reviewRun = reviewState.jobs.flatMap((job) => job.runs).find((run) => run.id === reviewRunId);
      if (!reviewRun) throw new PipelineError("not_found", "Run not found in this company");
      if (reviewRun.mode === "production") {
        await verifyProductionReview(ctx, input.companyId, reviewRun, command);
        if (command.type === "review_run" && command.verdict === "rewritten") {
          command = {
            ...command,
            correctionDelivery: await correctionDeliveryFromHost(ctx, input.companyId, reviewRun, command.correctionCommentId!, command.reviewerId),
          };
        }
      }
    }
    if (command.type === "record_correction_delivery") {
      const deliveryState = before ?? await store.read(input.companyId);
      const deliveryRunId = command.runId;
      const deliveryRun = deliveryState.jobs.flatMap((job) => job.runs).find((run) => run.id === deliveryRunId);
      if (!deliveryRun) throw new PipelineError("not_found", "Run not found in this company");
      if (deliveryRun.review?.reviewerId !== command.reviewerId) throw new PipelineError("invalid_input", "Only the original reviewer can record correction delivery");
      if (deliveryRun.review.correctionCommentId !== command.correctionCommentId) throw new PipelineError("invalid_input", "Delivery must reference the saved correction comment");
      command = {
        ...command,
        delivery: await correctionDeliveryFromHost(ctx, input.companyId, deliveryRun, command.correctionCommentId, command.reviewerId),
      };
    }
    await verifyCommandSkill(ctx, input.companyId, command, before);
    const { state, event } = await dispatch(ctx, input.companyId, command, expectedVersion);
    return {
      status: input.method === "POST" && (command.type === "create_audit" || command.type === "create_job") ? 201 : 200,
      body: { state, event },
    };
  } catch (error) {
    return errorResponse(error);
  }
}

async function toolDispatch(
  ctx: PluginContext,
  runContext: ToolRunContext,
  command: PipelineCommand,
): Promise<ToolResult> {
  if (!(await allowed(ctx, runContext.companyId))) return toolError(new Error("Hand-off is not enabled for this company."));
  try {
    if (command.type === "log_run" && command.mode === "production") {
      const production = command;
      const current = await createStore(ctx).read(runContext.companyId);
      const exactRetry = current.jobs.find((job) => job.id === production.jobId)?.runs.some((run) => run.idempotencyKey === `host-run:${runContext.runId}`) ?? false;
      command = await productionCommand(ctx, runContext, production, exactRetry);
    }
    await verifyCommandSkill(ctx, runContext.companyId, command);
    const { state, event } = await dispatch(ctx, runContext.companyId, command);
    const commandJobId = "jobId" in command ? command.jobId : null;
    return {
      content: `Recorded ${command.type.replaceAll("_", " ")} for company ${runContext.companyId}.`,
      data: { event, stateVersion: state.version, job: commandJobId ? findJob(state, commandJobId) : event?.jobId ? findJob(state, event.jobId) : undefined },
    };
  } catch (error) {
    return toolError(error);
  }
}

function registerTools(ctx: PluginContext): void {
  const factories: Record<string, (params: JsonObject, run: ToolRunContext) => PipelineCommand> = {
    handoff_record_audit: (params) => ({ ...params, type: "create_audit" }) as PipelineCommand,
    handoff_record_job: (params) => ({ ...params, type: "create_job" }) as PipelineCommand,
    handoff_add_example: (params) => ({ ...params, type: "add_example" }) as PipelineCommand,
    handoff_record_run: (params, run) => ({
      ...params,
      type: "log_run",
      idempotencyKey: typeof params.idempotencyKey === "string" ? params.idempotencyKey : run.idempotencyKey,
    }) as PipelineCommand,
  };
  for (const declaration of manifest.tools ?? []) {
    if (declaration.name === "handoff_get_pipeline") {
      ctx.tools.register(
        declaration.name,
        { displayName: declaration.displayName, description: declaration.description, parametersSchema: declaration.parametersSchema },
        async (params, run) => {
          if (!(await allowed(ctx, run.companyId))) return toolError(new Error("Hand-off is not enabled for this company."));
          try {
            const state = await hydrateState(ctx, await createStore(ctx).read(run.companyId));
            const skillDrift = await pipelineSkillDrift(ctx, run.companyId, state);
            const jobId = object(params).jobId;
            if (jobId !== undefined) {
              if (typeof jobId !== "string") throw new PipelineError("invalid_input", "Job ID must be text");
              const job = findJob(state, jobId);
              if (!job) throw new PipelineError("not_found", "Job not found in this company");
              const drift = skillDrift.find((item) => item.jobId === job.id);
              if (drift) return { error: drift.reason, content: drift.reason, data: { job, stateVersion: state.version, executionBlocked: true, executionBlockReason: drift.reason } };
              return { content: `Loaded ${job.title} at stage ${job.stage}.`, data: { job, stateVersion: state.version } };
            }
            const summary = compactPipeline(state, skillDrift);
            const warning = skillDrift.length ? ` ${skillDrift.length} job${skillDrift.length === 1 ? " is" : "s are"} blocked because the linked skill changed. Do not execute blocked jobs.` : "";
            return { content: `Loaded ${summary.jobs.length} ranked hand-off jobs.${warning}`, data: summary };
          } catch (error) {
            return toolError(error);
          }
        },
      );
      continue;
    }
    const factory = factories[declaration.name];
    if (!factory) throw new Error(`Missing handler for ${declaration.name}`);
    ctx.tools.register(
      declaration.name,
      { displayName: declaration.displayName, description: declaration.description, parametersSchema: declaration.parametersSchema },
      async (params, run) => toolDispatch(ctx, run, factory(object(params), run)),
    );
  }
}

export const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    workerContext = ctx;
    stopActivityRetryLoop?.();
    await deliverPendingActivities(ctx);
    stopActivityRetryLoop = startActivityDeliveryRetryLoop(ctx);
    registerTools(ctx);
    ctx.data.register("handoff.sidebar-visible", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : "";
      return { visible: companyId.length > 0 && await allowed(ctx, companyId) };
    });
    const config = (await ctx.config.get()) as HandOffConfig;
    if (!config.allowedCompanies?.length) ctx.logger.warn("Hand-off denies every company until allowedCompanies is configured.");
  },
  async onShutdown() {
    stopActivityRetryLoop?.();
    stopActivityRetryLoop = null;
    workerContext = null;
  },
  async onApiRequest(input: PluginApiRequestInput): Promise<PluginApiResponse> {
    if (!workerContext) return { status: 503, body: { error: "Hand-off worker is not ready." } };
    return handleApiRequest(workerContext, input);
  },
  async onHealth() {
    return { status: "ok", message: "Hand-off ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
