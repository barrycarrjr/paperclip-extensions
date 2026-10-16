import { correctionCommentBody, type Audit, type CorrectionDelivery, type JobRun, type PipelineCommand, type PipelineState, type RecurringJob } from "../contracts.js";

type Input<T extends PipelineCommand["type"]> = Omit<Extract<PipelineCommand, { type: T }>, "type" | "jobId" | "runId" | "reviewerId">;

export function qualificationCount(job: RecurringJob): number {
  return new Set(job.runs.filter((run) => run.mode === "historical" && run.revisionId === job.currentRevisionId && run.review?.verdict === "clean").map((run) => run.exampleId)).size;
}

export function rankedJobs(jobs: RecurringJob[]): RecurringJob[] {
  return [...jobs].sort((a, b) => b.monthlyHoursSaved - a.monthlyHoursSaved || a.id.localeCompare(b.id));
}

export function auditDates(start: string, end: string): { startAt: string; endAt: string } {
  const startAt = new Date(`${start}T00:00:00.000Z`);
  const endAt = new Date(`${end}T00:00:00.000Z`);
  const days = (endAt.getTime() - startAt.getTime()) / 86_400_000;
  if (!Number.isFinite(days) || startAt.toISOString().slice(0, 10) !== start || endAt.toISOString().slice(0, 10) !== end || days < 30 || days > 90) throw new Error("Choose an audit period of 30 to 90 days.");
  return { startAt: startAt.toISOString(), endAt: endAt.toISOString() };
}

async function request<T>(companyId: string, path: string, method = "GET", body?: unknown): Promise<T> {
  if (!companyId) throw new Error("Select a company first.");
  const url = new URL(`/api/plugins/handoff-pipeline/api${path}`, window.location.origin);
  url.searchParams.set("companyId", companyId);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(url, { method, credentials: "include", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : `Request failed (${response.status}).`;
    throw new Error(message);
  }
  if (payload === null) throw new Error("The server returned an unreadable response.");
  return payload as T;
}

async function updateCompanySkill(companyId: string, skillId: string, content: string): Promise<void> {
  if (!companyId) throw new Error("Select a company first.");
  const url = new URL(`/api/companies/${encodeURIComponent(companyId)}/skills/${encodeURIComponent(skillId)}/files`, window.location.origin);
  const response = await fetch(url, {
    method: "PATCH",
    credentials: "include",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ path: "SKILL.md", content }),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : `Skill update failed (${response.status}).`;
    throw new Error(message);
  }
}

async function readCompanySkill(companyId: string, skillId: string): Promise<string> {
  const url = new URL(`/api/companies/${encodeURIComponent(companyId)}/skills/${encodeURIComponent(skillId)}/files`, window.location.origin);
  url.searchParams.set("path", "SKILL.md");
  const response = await fetch(url, { credentials: "include", headers: { Accept: "application/json" } });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok || !payload || typeof payload !== "object" || !("content" in payload) || typeof payload.content !== "string") {
    const message = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : `Skill read failed (${response.status}).`;
    throw new Error(message);
  }
  return payload.content;
}

export type { CorrectionDelivery } from "../contracts.js";

export function unconfirmedCorrectionDelivery(run: JobRun): CorrectionDelivery {
  return { status: "pending", pending: [{ agentId: run.hostAgentId ?? "unknown", reason: "Agent delivery has not been confirmed. Retry correction delivery." }] };
}

async function createCorrectionComment(run: JobRun, revisedOutput: string, reason: string): Promise<{ id: string; correctionDelivery?: CorrectionDelivery }> {
  if (!run.sourceIssueId || !run.hostAgentId) throw new Error("This production run has no verified source issue or assigned agent.");
  const expectedAssigneeAgentId = run.hostAgentId;
  const commentResponse = await fetch(new URL(`/api/issues/${encodeURIComponent(run.sourceIssueId)}/comments`, window.location.origin), {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      intent: "correction",
      idempotencyKey: `handoff.review:${run.id}`,
      expectedAssigneeAgentId,
      allowPriorAssigneeTarget: true,
      body: correctionCommentBody(run.id, revisedOutput, reason),
    }),
  });
  const commentPayload: unknown = await commentResponse.json().catch(() => null);
  if (!commentResponse.ok || !commentPayload || typeof commentPayload !== "object" || !("id" in commentPayload) || typeof commentPayload.id !== "string") {
    const message = commentPayload && typeof commentPayload === "object" && "error" in commentPayload && typeof commentPayload.error === "string" ? commentPayload.error : `Correction comment failed (${commentResponse.status}).`;
    throw new Error(message);
  }
  return commentPayload as { id: string; correctionDelivery?: CorrectionDelivery };
}

async function reviewRun(companyId: string, run: JobRun, input: Input<"review_run">): Promise<{ result: unknown }> {
  if (run.mode === "production" && input.verdict === "rewritten") {
    await request(companyId, `/runs/${idPath(run.id)}/review/prepare`, "POST", { revisedOutput: input.revisedOutput, reason: input.reason });
    const comment = await createCorrectionComment(run, input.revisedOutput!, input.reason!);
    const result = await request(companyId, `/runs/${idPath(run.id)}/review`, "POST", { ...input, correctionCommentId: comment.id });
    return { result };
  }
  return { result: await request(companyId, `/runs/${idPath(run.id)}/review`, "POST", input) };
}

async function retryCorrectionDelivery(companyId: string, run: JobRun): Promise<unknown> {
  if (run.mode !== "production" || run.review?.verdict !== "rewritten" || !run.review.correctionCommentId || !run.review.revisedOutput || !run.review.reason) throw new Error("This run has no saved production correction to retry.");
  const comment = await createCorrectionComment(run, run.review.revisedOutput, run.review.reason);
  if (comment.id !== run.review.correctionCommentId) throw new Error("The retried correction does not match the saved review.");
  return request(companyId, `/runs/${idPath(run.id)}/correction-delivery`, "POST", {
    correctionCommentId: comment.id,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameContent(left: string, right: string): boolean {
  return left.replace(/\r\n/g, "\n") === right.replace(/\r\n/g, "\n");
}

async function updateAndRebuildCompanySkill(companyId: string, skillId: string, jobId: string, input: Input<"rebuild">): Promise<unknown> {
  const { version } = await request<{ version: number }>(companyId, `/jobs/${idPath(jobId)}/rebuild/preflight`, "POST", input);
  try {
    await updateCompanySkill(companyId, skillId, input.skillContent);
  } catch (error) {
    let liveContent: string;
    try { liveContent = await readCompanySkill(companyId, skillId); }
    catch (readError) { throw new Error(`${errorMessage(error)} The skill update result could not be confirmed, and the live SKILL.md could not be read: ${errorMessage(readError)}`); }
    if (!sameContent(liveContent, input.skillContent)) {
      throw new Error(`${errorMessage(error)} The pipeline was unchanged and the live SKILL.md does not match the submitted rebuild. Reopen the job and reconcile it before execution.`);
    }
  }
  try {
    return await request(companyId, `/jobs/${idPath(jobId)}/rebuild`, "POST", { ...input, expectedVersion: version });
  } catch (error) {
    let latest: PipelineState;
    try {
      latest = (await handoffApi.summary(companyId)).state;
    } catch (reconcileError) {
      throw new Error(`${errorMessage(error)} The result could not be confirmed, so SKILL.md was left as submitted: ${errorMessage(reconcileError)}`);
    }
    const latestJob = latest.jobs.find((job) => job.id === jobId);
    const latestRevision = latestJob?.revisions.find((revision) => revision.id === latestJob.currentRevisionId);
    const committedEvent = latest.events.find((event) => event.id === input.requestId && event.type === "rebuild" && event.jobId === jobId);
    if (committedEvent && latestRevision && sameContent(latestRevision.content, input.skillContent)) {
      const liveContent = await readCompanySkill(companyId, skillId).catch((readError) => {
        throw new Error(`${errorMessage(error)} The pipeline saved the revision, but the current SKILL.md could not be confirmed: ${errorMessage(readError)}`);
      });
      if (!sameContent(liveContent, input.skillContent)) {
        throw new Error(`${errorMessage(error)} The pipeline saved the revision, but SKILL.md changed again and needs manual reconciliation.`);
      }
      return { state: latest };
    }
    if (latest.version !== version) throw new Error(`${errorMessage(error)} The pipeline changed concurrently, so SKILL.md was left as submitted for manual reconciliation.`);
    const savedContent = await readCompanySkill(companyId, skillId).catch((readError) => {
      throw new Error(`${errorMessage(error)} The pipeline was unchanged, but the current SKILL.md could not be confirmed: ${errorMessage(readError)}`);
    });
    if (!sameContent(savedContent, input.skillContent)) throw new Error(`${errorMessage(error)} SKILL.md changed again. It was not overwritten; reopen the job and reconcile the live skill with the saved revision.`);
    throw new Error(`${errorMessage(error)} The pipeline was unchanged and SKILL.md was left as submitted. Retry the rebuild or reconcile it from the job before any execution.`);
  }
}

const idPath = (id: string) => encodeURIComponent(id);

export const handoffApi = {
  summary: (companyId: string) => request<{ state: PipelineState; skillDrift: { jobId: string; reason: string }[] }>(companyId, "/summary"),
  listAudits: (companyId: string) => request<{ audits: Audit[] }>(companyId, "/audits"),
  listJobs: (companyId: string) => request<{ jobs: RecurringJob[] }>(companyId, "/jobs"),
  listReview: (companyId: string) => request<{ runs: JobRun[] }>(companyId, "/review"),
  listRuns: (companyId: string) => request<{ runs: JobRun[] }>(companyId, "/runs"),
  createAudit: (companyId: string, input: Input<"create_audit">) => request(companyId, "/audits", "POST", input),
  createJob: (companyId: string, input: Input<"create_job">) => request(companyId, "/jobs", "POST", input),
  updateJob: (companyId: string, id: string, input: Input<"revise_skill">) => request(companyId, `/jobs/${idPath(id)}`, "PATCH", input),
  addExample: (companyId: string, id: string, input: Input<"add_example">) => request(companyId, `/jobs/${idPath(id)}/examples`, "POST", input),
  addRun: (companyId: string, id: string, input: Input<"log_run">) => request(companyId, `/jobs/${idPath(id)}/runs`, "POST", input),
  reviewRun,
  retryCorrectionDelivery,
  rebuildJob: updateAndRebuildCompanySkill,
  retireJob: (companyId: string, id: string, input: Input<"retire">) => request(companyId, `/jobs/${idPath(id)}/retire`, "POST", input),
};
