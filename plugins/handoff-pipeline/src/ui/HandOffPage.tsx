import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useHostContext, type PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import { AUDIT_SOURCES, type AuditSource, type JobRun, type PipelineState, type RecurringJob, type SourceCoverage } from "../contracts.js";
import { auditDates, handoffApi, qualificationCount, rankedJobs, unconfirmedCorrectionDelivery, type CorrectionDelivery } from "./api.js";

const border = "1px solid var(--border)";
const muted: CSSProperties = { color: "var(--muted-foreground)", fontSize: 13 };
const card: CSSProperties = { border, borderRadius: 8, padding: 16, background: "var(--card)", color: "var(--card-foreground)", minWidth: 0 };
const button: CSSProperties = { border, borderRadius: 6, padding: "7px 12px", background: "var(--background)", color: "var(--foreground)", cursor: "pointer", font: "inherit" };
const input: CSSProperties = { boxSizing: "border-box", width: "100%", border, borderRadius: 6, padding: 8, background: "var(--background)", color: "var(--foreground)", font: "inherit" };
const stack: CSSProperties = { display: "grid", gap: 16 };
const row: CSSProperties = { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" };

type Tab = "Audit" | "Jobs" | "Review" | "Run log";
type FormValues = Record<string, string>;
interface PendingCorrectionDelivery { run: JobRun; revisedOutput: string; reason: string; delivery: CorrectionDelivery }
function pendingCorrection(run: JobRun): PendingCorrectionDelivery | null {
  if (run.mode !== "production" || run.review?.verdict !== "rewritten" || !run.review.correctionCommentId || run.correctionDelivery?.status === "accepted") return null;
  return { run, revisedOutput: run.review.revisedOutput!, reason: run.review.reason!, delivery: run.correctionDelivery ?? unconfirmedCorrectionDelivery(run) };
}
interface Field {
  name: string;
  label: string;
  type?: "text" | "number" | "date" | "textarea";
  value?: string;
  optional?: boolean;
  options?: { value: string; label: string }[];
  hint?: string;
  min?: number;
  max?: number | string;
  when?: { name: string; value: string };
}

export function actionFormValue(value: string, type: Field["type"]): string {
  return type === "textarea" ? value : value.trim();
}

function ErrorMessage({ children }: { children: ReactNode }) {
  return <p role="alert" style={{ color: "var(--destructive)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{children}</p>;
}

function ActionForm({ title, fields, submit, onSubmit, disabled = false }: {
  title: string;
  fields: Field[];
  submit: string;
  onSubmit: (values: FormValues) => Promise<void>;
  disabled?: boolean;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [selected, setSelected] = useState<Record<string, string>>({});
  return <form style={stack} onChange={(event) => { const target = event.target; if (target instanceof HTMLSelectElement) setSelected((previous) => ({ ...previous, [target.name]: target.value })); }} onSubmit={async (event) => {
    event.preventDefault();
    if (saving || disabled) return;
    const form = event.currentTarget;
    const values: FormValues = {};
    new FormData(form).forEach((value, key) => { values[key] = actionFormValue(String(value), fields.find((field) => field.name === key)?.type); });
    setSaving(true);
    setError(null);
    setSaved(false);
    try { await onSubmit(values); form.reset(); setSelected({}); setSaved(true); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not save. Try again."); }
    finally { setSaving(false); }
  }}>
    <h3 style={{ margin: 0, fontSize: 15 }}>{title}</h3>
    <fieldset disabled={saving || disabled} style={{ border: 0, padding: 0, margin: 0, ...stack }}>
      {fields.filter((field) => !field.when || (selected[field.when.name] ?? fields.find((item) => item.name === field.when!.name)?.value) === field.when.value).map((field) => <label key={field.name} style={{ display: "grid", gap: 5, fontSize: 13 }}>
        {field.label}{field.optional ? " (optional)" : ""}
        {field.options ? <select name={field.name} defaultValue={field.value ?? ""} required={!field.optional} style={input}>
          <option value="">Select</option>
          {field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select> : field.type === "textarea" ? <textarea name={field.name} defaultValue={field.value} required={!field.optional} rows={4} style={{ ...input, resize: "vertical" }} />
          : <input name={field.name} type={field.type ?? "text"} defaultValue={field.value} required={!field.optional} min={field.min} max={field.max} step={field.type === "number" ? "any" : undefined} style={input} />}
        {field.hint ? <span style={muted}>{field.hint}</span> : null}
      </label>)}
      {error ? <ErrorMessage>{error}</ErrorMessage> : null}
      <div style={row}><button type="submit" style={button}>{saving ? "Saving..." : submit}</button>{saved ? <span role="status" style={muted}>Saved.</span> : null}</div>
    </fieldset>
  </form>;
}

function Output({ label, value }: { label: string; value: string | undefined | null }) {
  return <div><h4 style={{ fontSize: 13, margin: "12px 0 6px" }}>{label}</h4><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", font: "inherit", fontSize: 13, padding: 12, borderRadius: 6, background: "var(--muted)", color: "var(--foreground)", margin: 0 }}>{value || "Not recorded"}</pre></div>;
}

export function HandOffPage(_props: PluginPageProps) {
  const { companyId } = useHostContext();
  if (!companyId) return <p>Select a company to open Hand-off.</p>;
  return <CompanyPage key={companyId} companyId={companyId} />;
}

function CompanyPage({ companyId }: { companyId: string }) {
  const [tab, setTab] = useState<Tab>("Audit");
  const [state, setState] = useState<PipelineState | null>(null);
  const [skillDrift, setSkillDrift] = useState<{ jobId: string; reason: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try { const result = await handoffApi.summary(companyId); if (id === requestId.current) { setState(result.state); setSkillDrift(result.skillDrift); } }
    catch (err) { if (id === requestId.current) setError(err instanceof Error ? err.message : "Could not load Hand-off."); }
    finally { if (id === requestId.current) setLoading(false); }
  }, [companyId]);
  useEffect(() => { void refresh(); return () => { requestId.current += 1; }; }, [refresh]);
  return <main style={{ ...stack, maxWidth: 1040, margin: "0 auto", padding: 24, color: "var(--foreground)" }}>
    <div style={{ ...row, justifyContent: "space-between" }}><h1 style={{ margin: 0, fontSize: 24 }}>Hand-off</h1><button type="button" style={button} disabled={loading} onClick={() => void refresh()}>Refresh</button></div>
    <p style={{ ...muted, margin: 0 }}>Find repeated work, teach a skill with three examples, and review each run. Five clean reviews promote a job automatically. Three rewrites require a rebuild.</p>
    <nav aria-label="Hand-off sections" style={{ ...row, borderBottom: border, paddingBottom: 8 }}>
      {(["Audit", "Jobs", "Review", "Run log"] as const).map((name) => <button key={name} type="button" aria-current={tab === name ? "page" : undefined} onClick={() => setTab(name)} style={{ ...button, background: tab === name ? "var(--primary)" : "var(--background)", color: tab === name ? "var(--primary-foreground)" : "var(--foreground)" }}>{name}</button>)}
    </nav>
    {skillDrift.length ? <ErrorMessage>{skillDrift.map((item) => `${state?.jobs.find((job) => job.id === item.jobId)?.title ?? item.jobId}: ${item.reason}`).join("\n")}</ErrorMessage> : null}
    {tab !== "Run log" ? state?.jobs.flatMap((job) => job.runs).map((run) => {
      const pending = pendingCorrection(run);
      return pending ? <CorrectionDeliveryNotice key={run.id} pending={pending} companyId={companyId} refresh={refresh} /> : null;
    }) : null}
    {error ? <ErrorMessage>{error}</ErrorMessage> : loading ? <p role="status">Loading...</p> : state ? <PipelineTab tab={tab} state={state} companyId={companyId} refresh={refresh} /> : <ErrorMessage>The server did not return pipeline data.</ErrorMessage>}
  </main>;
}

const sourceLabels: Record<AuditSource, string> = { calendar: "Calendar", sent_mail: "Sent mail", property_management: "Property management", accounting: "Accounting" };
const stageLabels: Record<RecurringJob["stage"], string> = { keep: "Keep", draft: "Draft", run: "Run", rebuild_required: "Rebuild required", retired: "Retired" };
const splitLines = (value: string) => value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
const dateLabel = (value: string) => new Date(value).toLocaleDateString();
const columns: CSSProperties = { display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 330px), 1fr))" };

export function CorrectionDeliveryNotice({ pending, companyId, refresh }: { pending: PendingCorrectionDelivery; companyId: string; refresh: () => Promise<void> }) {
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <aside style={card} aria-label="Pending correction delivery"><p role="status">Human review saved. Correction delivery is pending for run {pending.run.id}. {pending.delivery.pending.map((item) => item.reason).join(" ")} Restore the agent's availability before retrying.</p>
    {error ? <ErrorMessage>{error}</ErrorMessage> : null}
    <button type="button" style={button} disabled={retrying} onClick={async () => {
      setRetrying(true); setError(null);
      try { await handoffApi.retryCorrectionDelivery(companyId, pending.run); await refresh(); }
      catch (err) { setError(err instanceof Error ? err.message : "Could not retry correction delivery."); }
      finally { setRetrying(false); }
    }}>{retrying ? "Retrying..." : "Retry correction delivery"}</button>
  </aside>;
}

export function PipelineTab({ tab, state, companyId, refresh }: { tab: Tab; state: PipelineState; companyId: string; refresh: () => Promise<void> }) {
  if (tab === "Audit") return <AuditTab state={state} companyId={companyId} refresh={refresh} />;
  if (tab === "Jobs") return <JobsTab state={state} companyId={companyId} refresh={refresh} />;
  const runs = state.jobs.flatMap((job) => job.runs.map((run) => ({ job, run }))).sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt));
  if (tab === "Review") {
    const pending = runs.filter(({ run }) => run.reviewRequired && !run.review).reverse();
    return <section style={stack} aria-label="Pending human reviews"><h2 style={{ margin: 0, fontSize: 18 }}>Pending review ({pending.length})</h2>
      {pending.length ? pending.map(({ job, run }) => <ReviewCard key={run.id} job={job} run={run} companyId={companyId} refresh={refresh} />) : <p style={muted}>No runs are waiting for a human review.</p>}
    </section>;
  }
  return <section style={stack} aria-label="Run log">
    <h2 style={{ margin: 0, fontSize: 18 }}>Run log</h2>
    {runs.length ? runs.map(({ job, run }) => <article style={card} key={run.id}><RunDetails job={job} run={run} />
      {pendingCorrection(run) ? <CorrectionDeliveryNotice pending={pendingCorrection(run)!} companyId={companyId} refresh={refresh} /> : run.correctionDelivery?.status === "accepted" ? <p style={muted}>Correction delivery accepted by the host.</p> : null}
      {run.review ? <><p style={muted}>Human verdict: {run.review.verdict === "clean" ? "Clean" : "Rewritten"}. Reviewer: {run.review.reviewerId}. Reviewed {dateLabel(run.review.reviewedAt)}.{run.review.correctionCommentId ? ` Correction comment: ${run.review.correctionCommentId}.` : ""}{run.review.instructionChangeApproval ? ` Instruction change approval: ${run.review.instructionChangeApproval.status} (${run.review.instructionChangeApproval.id}).` : run.review.correctionCommentId ? " No matching instruction change proposal yet." : ""}</p>{run.review.revisedOutput ? <Output label="Revised output" value={run.review.revisedOutput} /> : null}{run.review.reason ? <Output label="Rewrite reason" value={run.review.reason} /> : null}</> : run.reviewRequired ? <p style={muted}>Pending human review.</p> : <p style={muted}>Human review is not required in Run.</p>}
    </article>) : <p style={muted}>No runs recorded yet. Add a historical example from a job to begin qualification.</p>}
    <details style={card}><summary>Change history ({state.events.length})</summary><div style={{ ...stack, marginTop: 12 }}>{[...state.events].reverse().map((event) => <div key={event.id} style={{ borderBottom: border, paddingBottom: 8 }}><p style={{ margin: 0 }}>{event.type.replaceAll("_", " ")} on {dateLabel(event.at)}</p><p style={{ ...muted, overflowWrap: "anywhere" }}>Reference: {event.id}{event.jobId ? `. Job: ${event.jobId}` : ""}</p><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12 }}>{JSON.stringify(event.detail, null, 2)}</pre></div>)}{!state.events.length ? <p style={muted}>No changes recorded yet.</p> : null}</div></details>
  </section>;
}

function AuditTab({ state, companyId, refresh }: { state: PipelineState; companyId: string; refresh: () => Promise<void> }) {
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
  const fields: Field[] = [
    { name: "start", label: "Start date", type: "date", value: start },
    { name: "end", label: "End date", type: "date", value: end, max: end, hint: "The period must span 30 to 90 days and cannot end in the future." },
    ...AUDIT_SOURCES.flatMap((source): Field[] => [
      { name: `${source}_status`, label: `${sourceLabels[source]} coverage`, value: "reviewed", options: [{ value: "reviewed", label: "Reviewed" }, { value: "no_data", label: "No data" }, { value: "unavailable", label: "Unavailable" }] },
      { name: `${source}_evidence`, label: `${sourceLabels[source]} evidence`, type: "textarea", optional: true, hint: "For reviewed sources, enter one reference | summary per line." },
      { name: `${source}_reason`, label: `${sourceLabels[source]} missing data reason`, optional: true, hint: "Required when no data is available or the source is unavailable." },
    ]),
  ];
  return <section style={stack} aria-label="Audit">
    <details style={card}><summary>Record a 30 to 90 day audit</summary><div style={{ marginTop: 16 }}><ActionForm title="Audit source coverage" fields={fields} submit="Save audit" onSubmit={async (values) => {
      const sources: SourceCoverage[] = AUDIT_SOURCES.map((source) => {
        const status = values[`${source}_status`] as SourceCoverage["status"];
        const evidence = splitLines(values[`${source}_evidence`]).map((line) => {
          const separator = line.indexOf("|");
          if (separator < 1 || !line.slice(separator + 1).trim()) throw new Error(`${sourceLabels[source]} evidence needs a reference and summary separated by |.`);
          return { ref: line.slice(0, separator).trim(), summary: line.slice(separator + 1).trim() };
        });
        const reason = values[`${source}_reason`];
        if (status === "reviewed" && !evidence.length) throw new Error(`Add evidence for ${sourceLabels[source]}.`);
        if (status !== "reviewed" && !reason) throw new Error(`Explain the missing ${sourceLabels[source]} data.`);
        return { source, status, evidence, ...(reason ? { reason } : {}) };
      });
      await handoffApi.createAudit(companyId, { ...auditDates(values.start, values.end), sources }); await refresh();
    }} /></div></details>
    {state.audits.length ? [...state.audits].reverse().map((audit) => <article style={card} key={audit.id}>
      <h2 style={{ fontSize: 17, margin: "0 0 6px" }}>{dateLabel(audit.startAt)} to {dateLabel(audit.endAt)}</h2><p style={{ ...muted, overflowWrap: "anywhere" }}>Audit reference: {audit.id}. Coverage: {audit.sources.filter((source) => source.status === "reviewed").length} of 4 sources reviewed.</p>
      <div style={columns}>{audit.sources.map((source) => <section key={source.source} style={{ borderTop: border, paddingTop: 10 }}><h3 style={{ margin: "0 0 6px", fontSize: 14 }}>{sourceLabels[source.source]}: {source.status.replaceAll("_", " ")}</h3>{source.reason ? <p style={muted}>{source.reason}</p> : null}{source.evidence.map((evidence, index) => <p key={`${evidence.ref}-${index}`} style={{ fontSize: 13, overflowWrap: "anywhere" }}>{evidence.summary}<br /><span style={muted}>Reference: {evidence.ref}</span></p>)}</section>)}</div>
    </article>) : <p style={muted}>No audits recorded yet. Review calendar, sent mail, property management, and accounting records before selecting repeated work.</p>}
  </section>;
}

function JobsTab({ state, companyId, refresh }: { state: PipelineState; companyId: string; refresh: () => Promise<void> }) {
  return <section style={stack} aria-label="Jobs">
    <details style={card}><summary>Add a repeated job</summary><div style={{ marginTop: 16 }}>
      {!state.audits.length ? <p style={muted}>Record an audit before adding a job.</p> : <ActionForm title="Create repeated job" submit="Create job" fields={[
        { name: "auditId", label: "Audit", options: [...state.audits].reverse().map((audit) => ({ value: audit.id, label: `${dateLabel(audit.startAt)} to ${dateLabel(audit.endAt)} (${audit.id})` })) },
        { name: "title", label: "Job title" },
        { name: "evidenceRefs", label: "Audit evidence references", type: "textarea", hint: "One existing evidence reference from the selected audit per line." },
        { name: "occurrencesPerMonth", label: "Occurrences per month", type: "number", min: 0.01 },
        { name: "manualMinutes", label: "Current minutes per occurrence", type: "number", min: 0.01 },
        { name: "agentMinutes", label: "Estimated agent minutes per occurrence", type: "number", min: 0 },
        { name: "initialDisposition", label: "Disposition", value: "draft", options: [{ value: "keep", label: "Keep: continue doing this work manually" }, { value: "draft", label: "Draft: qualify an agent skill" }] },
        { name: "companySkillId", label: "Company skill reference ID", hint: "Create the real company skill in Skills first, then paste its ID here.", when: { name: "initialDisposition", value: "draft" } },
        { name: "skillKey", label: "Company skill key", hint: "Paste the returned key, including company ID and slug.", when: { name: "initialDisposition", value: "draft" } },
        { name: "skillContent", label: "Complete SKILL.md", type: "textarea", when: { name: "initialDisposition", value: "draft" } },
        { name: "routineId", label: "Routine reference ID", optional: true, when: { name: "initialDisposition", value: "draft" } },
      ]} onSubmit={async (values) => {
        await handoffApi.createJob(companyId, { auditId: values.auditId, title: values.title, evidenceRefs: splitLines(values.evidenceRefs), occurrencesPerMonth: Number(values.occurrencesPerMonth), manualMinutes: Number(values.manualMinutes), agentMinutes: Number(values.agentMinutes), initialDisposition: values.initialDisposition as "keep" | "draft", ...(values.initialDisposition === "draft" ? { companySkillId: values.companySkillId, skillKey: values.skillKey, skillContent: values.skillContent, ...(values.routineId ? { routineId: values.routineId } : {}) } : {}) }); await refresh();
      }} />}
    </div></details>
    <p style={{ ...muted, margin: 0 }}>Ranked by estimated monthly hours saved. Each job keeps its own skill and revision history.</p>
    {state.jobs.length ? rankedJobs(state.jobs).map((job, index) => <JobCard key={job.id} job={job} rank={index + 1} companyId={companyId} refresh={refresh} />) : <p style={muted}>No jobs yet. Use audit evidence to identify repeated work and estimate the time it could save.</p>}
  </section>;
}

function JobCard({ job, rank, companyId, refresh }: { job: RecurringJob; rank: number; companyId: string; refresh: () => Promise<void> }) {
  const qualified = qualificationCount(job);
  const revision = job.revisions.find((item) => item.id === job.currentRevisionId);
  const active = job.stage === "draft" || job.stage === "run";
  const exampleKey = useRef(crypto.randomUUID());
  const rebuildKey = useRef(crypto.randomUUID());
  const unusedExamples = job.examples.filter((example) => !job.runs.some((run) => run.mode === "historical" && run.revisionId === job.currentRevisionId && run.exampleId === example.id));
  return <article style={{ ...card, ...stack }}>
    <div style={{ ...row, justifyContent: "space-between" }}><h2 style={{ margin: 0, fontSize: 17 }}>{rank}. {job.title}</h2><span style={{ background: "var(--muted)", color: "var(--foreground)", padding: "4px 8px", borderRadius: 6, fontSize: 13 }}>{stageLabels[job.stage]}</span></div>
    <p style={{ margin: 0 }}>{job.monthlyHoursSaved.toFixed(1)} estimated hours saved per month</p>
    <p style={{ ...muted, margin: 0 }}>{job.occurrencesPerMonth} occurrences/month. {job.manualMinutes} current minutes and {job.agentMinutes} estimated agent minutes each.</p>
    <div style={{ ...muted, overflowWrap: "anywhere" }}>Skill key: {job.skillKey ?? "Not assigned"}<br />Company skill reference: {job.companySkillId ?? "Not assigned"}<br />Routine reference: {job.routineId ?? "Not assigned"}<br />Current revision: {job.currentRevisionId ?? "Not assigned"}<br />Revision hash: {revision?.hash ?? "Not assigned"}<br />Job: {job.id}<br />Audit: {job.auditId}<br />Evidence: {job.evidenceRefs.join(", ")}</div>
    <div style={row}><span>Qualification: {qualified}/3 clean historical examples</span><span>Clean streak: {job.cleanStreak}/5</span><span>Rewrite streak: {job.rewrittenStreak}/3</span></div>
    <progress max={3} value={Math.min(qualified, 3)} aria-label="Clean historical examples on current revision" style={{ width: "100%", accentColor: "var(--primary)" }} />
    {job.stage === "keep" ? <p style={{ ...muted, margin: 0 }}>This job stays manual. Move it to Draft when a real company skill is ready for qualification.</p> : null}
    {job.stage === "rebuild_required" ? <p style={{ margin: 0 }}>Three consecutive rewrites blocked new runs. Rebuild the skill and qualify three new examples.</p> : job.stage === "run" ? <p style={{ ...muted, margin: 0 }}>Promoted automatically after five consecutive clean production reviews. New production runs no longer require human review. Host approvals and company permissions still apply.</p> : job.stage === "draft" ? <p style={{ ...muted, margin: 0 }}>{qualified >= 3 ? "Qualified for production runs. Five consecutive clean production reviews promote this job automatically." : "Production is blocked until three distinct historical examples pass human review on this revision."}</p> : null}
    <details><summary>Skill content and revision history ({job.revisions.length})</summary>{[...job.revisions].reverse().map((item) => <div key={item.id} style={{ overflowWrap: "anywhere" }}><p style={muted}>Revision {item.id}, {dateLabel(item.createdAt)}. Hash: {item.hash}{item.promotedAt ? `. Promoted ${dateLabel(item.promotedAt)}.` : ""}</p><Output label="Instructions" value={item.content} /></div>)}</details>
    <details><summary>Historical examples ({job.examples.length})</summary><div style={{ ...stack, marginTop: 12 }}>{job.examples.map((example) => <section key={example.id} style={{ borderTop: border, paddingTop: 8 }}><p style={{ ...muted, overflowWrap: "anywhere" }}>Example ID: {example.id}<br />Source reference: {example.sourceRef}</p><Output label="Historical input" value={example.input} /><Output label="Actual outcome" value={example.actualOutcome} /></section>)}{!job.examples.length ? <p style={muted}>No historical examples recorded.</p> : null}</div></details>
    {job.stage !== "retired" ? <details><summary>Add a historical example</summary><div style={{ marginTop: 12 }}><ActionForm title="Record a real past occurrence" submit="Save example" fields={[{ name: "sourceRef", label: "Distinct source reference" }, { name: "input", label: "Historical input", type: "textarea" }, { name: "actualOutcome", label: "Actual outcome", type: "textarea" }]} onSubmit={async (values) => {
      await handoffApi.addExample(companyId, job.id, { sourceRef: values.sourceRef, input: values.input, actualOutcome: values.actualOutcome }); await refresh();
    }} /></div></details> : null}
    {job.stage === "keep" ? <details><summary>Move Keep to Draft</summary><div style={{ marginTop: 12 }}><ActionForm title="Attach a company skill and begin qualification" submit="Move to Draft" fields={[
      { name: "companySkillId", label: "Company skill reference ID", hint: "Create the real company skill in Skills first, then paste its ID here." }, { name: "skillKey", label: "Unique skill key" }, { name: "skillContent", label: "Complete SKILL.md", type: "textarea" }, { name: "routineId", label: "Routine reference ID", optional: true },
    ]} onSubmit={async (values) => { await handoffApi.updateJob(companyId, job.id, { companySkillId: values.companySkillId, skillKey: values.skillKey, skillContent: values.skillContent, ...(values.routineId ? { routineId: values.routineId } : {}) }); await refresh(); }} /></div></details> : null}
    {active ? <div style={columns}>
      <details><summary>Log a historical rehearsal</summary><div style={{ marginTop: 12 }}>{!unusedExamples.length ? <p style={muted}>Add a distinct historical example that has not been rehearsed on this revision.</p> : <ActionForm title="Record the skill's original output" submit="Add rehearsal for review" fields={[{ name: "exampleId", label: "Historical example", options: unusedExamples.map((example) => ({ value: example.id, label: example.sourceRef })) }, { name: "startedAt", label: "Execution started at (ISO timestamp)", hint: "Use the actual start time, for example 2026-10-15T14:30:00Z." }, { name: "originalOutput", label: "Original agent output", type: "textarea" }, { name: "actualMinutes", label: "Actual agent minutes", type: "number", optional: true, min: 0 }]} onSubmit={async (values) => {
        await handoffApi.addRun(companyId, job.id, { mode: "historical", idempotencyKey: exampleKey.current, revisionId: job.currentRevisionId!, exampleId: values.exampleId, startedAt: values.startedAt, originalOutput: values.originalOutput, ...(values.actualMinutes ? { actualMinutes: Number(values.actualMinutes) } : {}) }); exampleKey.current = crypto.randomUUID(); await refresh();
      }} />}</div></details>
      <details><summary>Production runs</summary><div style={{ marginTop: 12 }}><p style={muted}>{qualified < 3 ? "Three clean historical examples are required first." : "The executing agent records production output with the Hand-off tool. The host run supplies its agent, source issue, start time, status, summary and counts."}</p></div></details>
    </div> : null}
    {job.stage !== "retired" ? <div style={columns}>
      {job.stage !== "keep" ? <details><summary>Rebuild skill</summary><div style={{ marginTop: 12 }}><ActionForm title="Update the real skill and rebuild" submit="Update skill and rebuild job" fields={[{ name: "skillContent", label: "Complete revised SKILL.md", type: "textarea", value: revision?.content }, { name: "reason", label: "Rebuild reason" }]} onSubmit={async (values) => { await handoffApi.rebuildJob(companyId, job.companySkillId!, job.id, { skillContent: values.skillContent, reason: values.reason, requestId: rebuildKey.current }); rebuildKey.current = crypto.randomUUID(); await refresh(); }} /><p style={muted}>Validates the rebuild, saves SKILL.md to the linked company skill, verifies it, creates a new revision, and resets qualification and both review streaks. Earlier runs remain in the log.</p></div></details> : null}
      <details><summary>Retire job</summary><div style={{ marginTop: 12 }}><ActionForm title="Stop new runs permanently" submit="Retire job" fields={[{ name: "reason", label: "Retirement reason" }]} onSubmit={async (values) => { await handoffApi.retireJob(companyId, job.id, { reason: values.reason }); await refresh(); }} /><p style={muted}>Retired jobs cannot be rebuilt. Their history remains available.</p></div></details>
    </div> : null}
  </article>;
}

function RunDetails({ job, run }: { job: RecurringJob; run: JobRun }) {
  const example = job.examples.find((item) => item.id === run.exampleId);
  return <><h3 style={{ fontSize: 16, margin: 0 }}>{job.title}: {run.mode === "historical" ? "Historical rehearsal" : "Production run"}</h3><p style={{ ...muted, overflowWrap: "anywhere" }}>Run: {run.id}. Started {dateLabel(run.startedAt)}. Recorded {dateLabel(run.createdAt)}.<br />Skill: {job.skillKey}. Revision: {run.revisionId}.<br />Revision hash: {run.revisionHash}<br />Source reference: {run.sourceRef}{run.hostRunId ? <><br />Host run: {run.hostRunId}. Host agent: {run.hostAgentId}. Source issue: {run.sourceIssueId}.<br />Host status: {run.hostStatus ?? "Unavailable"}{run.hostFinishedAt ? `. Finished ${dateLabel(run.hostFinishedAt)}.` : ""}<br />Counts: {run.runCounts ? `${run.runCounts.itemsRead} items read, ${run.runCounts.entriesAdded} entries added, ${run.runCounts.changesProposed} changes proposed` : "Not reported"}</> : null}{run.actualMinutes !== null ? <><br />Actual agent minutes: {run.actualMinutes}</> : null}{run.revisionId !== job.currentRevisionId ? <><br />This run belongs to an earlier revision and does not count toward current qualification or streaks.</> : null}</p>{run.hostSummary ? <Output label="Host run summary" value={run.hostSummary} /> : null}{example ? <><Output label="Historical input" value={example.input} /><div style={columns}><Output label="Actual historical outcome" value={example.actualOutcome} /><Output label="Agent output" value={run.originalOutput} /></div></> : <Output label="Original agent output" value={run.originalOutput} />}</>;
}

function ReviewCard({ job, run, companyId, refresh }: { job: RecurringJob; run: JobRun; companyId: string; refresh: () => Promise<void> }) {
  const oldestPendingProduction = job.runs
    .filter((item) => item.mode === "production" && item.revisionId === run.revisionId && item.reviewRequired && !item.review)
    .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt))[0];
  const olderPending = run.mode === "production" && oldestPendingProduction?.id !== run.id;
  return <article style={{ ...card, ...stack }}><RunDetails job={job} run={run} />{olderPending ? <p style={muted}>Review the oldest pending production run for this revision first.</p> : null}{run.pendingRewrite ? <p style={muted}>This correction was prepared but not fully saved. Retry it with the preserved output and reason below.</p> : null}<ActionForm disabled={olderPending} title="Human review" submit="Save human review" fields={[
    { name: "verdict", label: "Verdict", value: run.pendingRewrite ? "rewritten" : "clean", options: [{ value: "clean", label: "Clean: original output is usable" }, { value: "rewritten", label: "Rewritten: corrected output was needed" }] },
    { name: "revisedOutput", label: "Revised output", type: "textarea", value: run.pendingRewrite?.revisedOutput, when: { name: "verdict", value: "rewritten" } },
    { name: "reason", label: "Rewrite reason", value: run.pendingRewrite?.reason, hint: "Explain what needed correction.", when: { name: "verdict", value: "rewritten" } },
  ]} onSubmit={async (values) => {
    const verdict = values.verdict as "clean" | "rewritten";
    if (verdict === "rewritten" && (!values.revisedOutput || !values.reason)) throw new Error("A rewrite requires revised output and a reason.");
    await handoffApi.reviewRun(companyId, run, verdict === "rewritten" ? { verdict, revisedOutput: values.revisedOutput, reason: values.reason } : { verdict });
    await refresh();
  }} /><p style={{ ...muted, margin: 0 }}>Reviews are permanent. The authenticated human reviewer is recorded. A rewritten production review also posts an idempotent correction to its source issue.</p></article>;
}
