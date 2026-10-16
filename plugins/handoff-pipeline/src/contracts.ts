export const AUDIT_SOURCES = ["calendar", "sent_mail", "property_management", "accounting"] as const;
export type AuditSource = typeof AUDIT_SOURCES[number];
export interface EvidenceRef { ref: string; summary: string }
export interface SourceCoverage {
  source: AuditSource;
  status: "reviewed" | "no_data" | "unavailable";
  evidence: EvidenceRef[];
  reason?: string;
}
export interface Audit {
  id: string; companyId: string; startAt: string; endAt: string;
  sources: SourceCoverage[]; createdAt: string;
}
export type JobStage = "keep" | "draft" | "run" | "rebuild_required" | "retired";
export interface SkillRevision { id: string; hash: string; content: string; createdAt: string; promotedAt: string | null }
export interface HistoricalExample {
  id: string; sourceRef: string; input: string; actualOutcome: string; createdAt: string;
}
export interface HumanReview {
  verdict: "clean" | "rewritten"; reviewerId: string; reviewedAt: string;
  revisedOutput: string | null; reason: string | null; correctionCommentId?: string | null;
  instructionChangeApproval?: { id: string; status: string } | null;
}
export interface PendingRewrite {
  reviewerId: string; preparedAt: string; revisedOutput: string; reason: string;
}
export interface CorrectionDelivery {
  status: "accepted" | "pending";
  pending: { agentId: string; reason: string }[];
}
export interface RunCounts { itemsRead: number; entriesAdded: number; changesProposed: number }
export function correctionCommentBody(runId: string, revisedOutput: string, reason: string): string {
  return `Hand-off review correction for run ${runId}\n\n${reason}\n\nCorrected output:\n${revisedOutput}`;
}
export interface JobRun {
  id: string; idempotencyKey: string; mode: "historical" | "production";
  revisionId: string; revisionHash: string; exampleId: string | null;
  sourceRef: string; actualMinutes: number | null;
  originalOutput: string; startedAt: string; createdAt: string;
  hostRunId?: string | null; hostAgentId?: string | null; sourceIssueId?: string | null;
  hostStatus?: string | null; hostFinishedAt?: string | null; hostSummary?: string | null;
  runCounts?: RunCounts | null; runCountsReporting?: Record<string, unknown> | null;
  reviewRequired: boolean; review: HumanReview | null; pendingRewrite?: PendingRewrite | null;
  correctionDelivery?: CorrectionDelivery & { updatedAt: string };
}
export interface RecurringJob {
  id: string; companyId: string; auditId: string; title: string;
  evidenceRefs: string[]; occurrencesPerMonth: number;
  manualMinutes: number; agentMinutes: number; monthlyHoursSaved: number;
  skillKey: string | null; currentRevisionId: string | null; revisions: SkillRevision[];
  companySkillId: string | null; routineId: string | null;
  stage: JobStage; cleanStreak: number; rewrittenStreak: number;
  runsBlockedAt: string | null;
  examples: HistoricalExample[]; runs: JobRun[]; createdAt: string; updatedAt: string;
}
export interface PipelineEvent {
  id: string; companyId: string; type: PipelineCommand["type"];
  jobId: string | null; at: string; detail: Record<string, unknown>;
}
export interface PipelineState {
  companyId: string; version: number; audits: Audit[];
  jobs: RecurringJob[]; events: PipelineEvent[];
}
export interface CommandMeta { id: string; now: string }
export type PipelineCommand =
  | { type: "create_audit"; startAt: string; endAt: string; sources: SourceCoverage[] }
  | { type: "create_job"; auditId: string; title: string; evidenceRefs: string[];
      occurrencesPerMonth: number; manualMinutes: number; agentMinutes: number;
      initialDisposition: "keep" | "draft"; skillKey?: string; skillContent?: string;
      companySkillId?: string; routineId?: string }
  | { type: "revise_skill"; jobId: string; skillContent: string; skillKey?: string;
      companySkillId?: string; routineId?: string }
  | { type: "add_example"; jobId: string; sourceRef: string; input: string; actualOutcome: string }
  | { type: "log_run"; jobId: string; idempotencyKey: string; revisionId: string;
      mode: "historical" | "production"; originalOutput: string; startedAt: string; exampleId?: string;
      sourceRef?: string; actualMinutes?: number; hostRunId?: string; hostAgentId?: string; sourceIssueId?: string }
  | { type: "review_run"; jobId: string; runId: string;
      verdict: "clean" | "rewritten"; reviewerId: string; revisedOutput?: string; reason?: string; correctionCommentId?: string; correctionDelivery?: CorrectionDelivery }
  | { type: "record_correction_delivery"; jobId: string; runId: string; reviewerId: string; correctionCommentId: string; delivery: CorrectionDelivery }
  | { type: "prepare_rewrite"; jobId: string; runId: string;
      reviewerId: string; revisedOutput: string; reason: string }
  | { type: "rebuild"; jobId: string; skillContent: string; reason: string; requestId: string }
  | { type: "retire"; jobId: string; reason: string };
