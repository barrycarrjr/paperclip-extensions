import { useEffect, useState, type CSSProperties } from "react";
import { useHostContext, usePluginData } from "@paperclipai/plugin-sdk/ui";
import { companyPath, GUIDANCE, money, type RosterData, type RosterRow } from "../roster.js";
import { loadHandOff, newPauseRequestId, pauseAgent, setKept, type HandOffResult } from "./api.js";

const surface: CSSProperties = { color: "var(--foreground)", background: "var(--background)", padding: 20, display: "grid", gap: 16, minWidth: 0 };
const button: CSSProperties = { color: "var(--foreground)", background: "var(--background)", border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px", font: "inherit", cursor: "pointer" };
const cell: CSSProperties = { textAlign: "left", verticalAlign: "top", padding: 10, borderBottom: "1px solid var(--border)" };
const link: CSSProperties = { color: "var(--primary)", textDecoration: "underline" };
const errorStyle: CSSProperties = { color: "var(--destructive)" };
const safeData = (data: RosterData | null | undefined, companyId: string | null) => data?.companyId === companyId ? data : null;

export function AgentRosterSidebar() {
  const host = useHostContext();
  const { data, loading, error } = usePluginData<{ visible: boolean; companyId?: string }>("roster.visible", { companyId: host.companyId });
  if (!host.companyId || loading) return null;
  if (error) return <span role="status">Agent roster unavailable: {error.message}</span>;
  return data?.visible && data.companyId === host.companyId ? <a style={{ color: "var(--foreground)", textDecoration: "none", display: "block", padding: "4px 8px" }} href={companyPath(host.companyPrefix, "agent-roster")}>Agent roster</a> : null;
}
export interface WidgetData { companyId?: string; companyPrefix?: string | null; visible: boolean; idleCount?: number; idleCostCents30?: number }
export function IdleWidget({ data, companyId, prefix }: { data: WidgetData; companyId: string; prefix: string | null }) {
  if (data.companyId !== companyId || !data.visible || !data.idleCount) return null;
  const companyPrefix = data.companyPrefix ?? prefix;
  if (!companyPrefix) return <p role="alert" style={errorStyle}>The company's roster link is unavailable. Refresh to retry.</p>;
  return <a style={link} href={companyPath(companyPrefix, "agent-roster")}>{data.idleCount} idle {data.idleCount === 1 ? "agent" : "agents"}, {money(data.idleCostCents30 ?? 0)} in the last 30 days</a>;
}
export function AgentRosterWidget() {
  const host = useHostContext();
  const { data, loading, error } = usePluginData<WidgetData>("roster.widget", { companyId: host.companyId });
  if (!host.companyId || loading) return null;
  if (error) return <p role="alert" style={errorStyle}>Agent roster unavailable: {error.message}</p>;
  return data ? <IdleWidget data={data} companyId={host.companyId} prefix={host.companyPrefix} /> : null;
}

export function RosterTable({ rows, prefix, handoff, onPause, canPause = false, onKeep, onUnkeep, busy = false }: { rows: RosterRow[]; prefix: string | null; handoff: HandOffResult | null; onPause: (row: RosterRow) => void; canPause?: boolean; onKeep?: (row: RosterRow) => void; onUnkeep?: (row: RosterRow) => void; busy?: boolean }) {
  if (!rows.length) return <p>No agents to review in this company.</p>;
  return <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse" }}><caption style={{ textAlign: "left", padding: 10 }}>Agent activity, idle agents first. Costs are USD.</caption>
    <thead><tr>{["Agent", "Role", "Status", "Last run", "Runs, 30 days", "Runs, 90 days", "Cost, 30 days", "Open issues", "Hand-off jobs", "Verdict", "Actions"].map((title) => <th scope="col" style={cell} key={title}>{title}</th>)}</tr></thead>
    <tbody>{rows.map((row) => {
      const jobs = handoff?.links.filter((job) => job.hostAgentId === row.id) ?? [];
      return <tr key={row.id}>
        <th scope="row" style={cell}>{row.name}</th><td style={cell}>{row.role}</td><td style={cell}>{row.status}</td>
        <td style={cell}>{row.lastRunAt ? <time dateTime={row.lastRunAt}>{new Date(row.lastRunAt).toLocaleString()}</time> : "Never"}</td>
        <td style={cell}>{row.runs30}</td><td style={cell}>{row.runs90}</td><td style={cell}>{money(row.costCents30)}</td><td style={cell}>{row.openIssues}</td>
        <td style={cell}>{jobs.length ? jobs.map((job) => <div key={job.jobId}><a style={link} href={companyPath(prefix, `agents/${encodeURIComponent(row.id)}/runs/${encodeURIComponent(job.hostRunId)}`)}>{job.title}: host run</a></div>) : handoff === null ? "Loading job evidence" : handoff.notice ? "Unavailable" : "No recorded production jobs"}</td>
        <td style={cell}><span>{row.verdict}</span>{row.keep && <p style={{ color: "var(--muted-foreground)", marginBottom: 0, overflowWrap: "anywhere" }}>Keep note: {row.keep.note}</p>}</td><td style={cell}><div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <a style={link} href={companyPath(prefix, `agents/${encodeURIComponent(row.id)}`)}>Open agent</a>
          {canPause && <button style={button} disabled={busy || row.status === "paused" || row.status === "pending_approval" || row.status === "terminated"} onClick={() => onPause(row)}>Pause</button>}
          {row.status !== "terminated" && <>
            {(row.keep || row.verdict === "Idle" || row.verdict === "Low use") && onKeep && <button style={button} disabled={busy} onClick={() => onKeep(row)}>{row.keep ? "Edit keep note" : "Keep"}</button>}
            {row.keep && onUnkeep && <button style={button} disabled={busy} onClick={() => onUnkeep(row)}>Unkeep</button>}
          </>}
        </div></td>
      </tr>;
    })}</tbody>
  </table></div>;
}
export function PauseConfirmation({ name, busy, error, onCancel, onConfirm }: { name: string; busy: boolean; error: string | null; onCancel: () => void; onConfirm: () => void }) {
  return <section role="alertdialog" aria-label={`Pause ${name}`} aria-describedby="roster-pause-description" style={{ border: "1px solid var(--border)", background: "var(--card)", color: "var(--card-foreground)", padding: 16, borderRadius: 8 }}>
    <p id="roster-pause-description">Pause {name}? This stops new agent runs. You can resume the agent on its agent page. This does not terminate the agent or reassign its issues.</p>
    {error && <p role="alert" style={errorStyle}>{error}</p>}
    <div style={{ display: "flex", gap: 8 }}><button autoFocus style={button} disabled={busy} onClick={onCancel}>Cancel</button><button style={button} disabled={busy} onClick={onConfirm}>{busy ? "Pausing..." : "Confirm pause"}</button></div>
  </section>;
}
export function KeepConfirmation({ name, note, busy, error, onNote, onCancel, onConfirm }: { name: string; note: string; busy: boolean; error: string | null; onNote: (note: string) => void; onCancel: () => void; onConfirm: () => void }) {
  return <form aria-label={`Keep ${name}`} onSubmit={(event) => { event.preventDefault(); onConfirm(); }} style={{ border: "1px solid var(--border)", background: "var(--card)", color: "var(--card-foreground)", padding: 16, borderRadius: 8 }}>
    <label htmlFor="roster-keep-note">Why keep {name}? A note is required (500 characters maximum).</label>
    <textarea id="roster-keep-note" autoFocus required maxLength={500} rows={3} value={note} disabled={busy} onChange={(event) => onNote(event.target.value)} style={{ display: "block", width: "100%", boxSizing: "border-box", margin: "8px 0", color: "var(--foreground)", background: "var(--background)", border: "1px solid var(--border)" }} />
    {error && <p role="alert" style={errorStyle}>{error}</p>}
    <div style={{ display: "flex", gap: 8 }}><button type="button" style={button} disabled={busy} onClick={onCancel}>Cancel</button><button type="submit" style={button} disabled={busy || !note.trim()}>{busy ? "Saving..." : "Save keep note"}</button></div>
  </form>;
}
export function AgentRosterPage() {
  const host = useHostContext();
  // Remount local confirmation/evidence state when the selected company changes.
  return <CompanyRoster key={host.companyId ?? "none"} companyId={host.companyId} prefix={host.companyPrefix} />;
}
export function HandOffNotice({ handoff }: { handoff: HandOffResult | null }) {
  // A summary error cannot establish that the audit page is accessible.
  return handoff?.notice ? <p role="status">{handoff.notice}</p> : null;
}
function CompanyRoster({ companyId, prefix }: { companyId: string | null; prefix: string | null }) {
  const visible = usePluginData<{ visible: boolean; companyId?: string }>("roster.visible", { companyId });
  if (!companyId) return <p>Select a company to review its agents.</p>;
  if (visible.loading) return <p>Loading agent roster...</p>;
  if (visible.error) return <p role="alert" style={errorStyle}>Agent roster unavailable: {visible.error.message}</p>;
  if (!visible.data?.visible || visible.data.companyId !== companyId) return null;
  return <AllowedRoster companyId={companyId} prefix={prefix} />;
}
function AllowedRoster({ companyId, prefix }: { companyId: string; prefix: string | null }) {
  const { data, loading, error, refresh } = usePluginData<RosterData>("roster.list", { companyId });
  const [handoff, setHandOff] = useState<HandOffResult | null>(null);
  const [pending, setPending] = useState<{ row: RosterRow; requestId: string } | null>(null);
  const [keeping, setKeeping] = useState<RosterRow | null>(null);
  const [note, setNote] = useState("");
  const [keepError, setKeepError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pauseError, setPauseError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [evidenceVersion, setEvidenceVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setHandOff(null);
    void loadHandOff(companyId, fetch, controller.signal).then((result) => { if (!controller.signal.aborted) setHandOff(result); }).catch((err: unknown) => {
      if (!controller.signal.aborted) setHandOff({ links: [], notice: err instanceof Error ? err.message : "Hand-off job evidence could not be loaded." });
    });
    return () => controller.abort();
  }, [companyId, evidenceVersion]);
  const roster = safeData(data, companyId);
  async function saveKeep(row: RosterRow, kept: boolean) {
    if (busy) return;
    setBusy(true); setKeepError(null); setNotice(null);
    try {
      await setKept(companyId, row.id, kept, note);
      setKeeping(null); setNotice(kept ? "Keep decision saved and activity recorded." : "Keep mark removed and activity recorded.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Keep decision failed. Refresh the roster before retrying.";
      if (kept) setKeepError(message); else setNotice(message);
    } finally { refresh(); setBusy(false); }
  }
  async function confirmPause() {
    if (!pending || busy) return;
    setBusy(true); setPauseError(null); setNotice(null);
    try {
      await pauseAgent(companyId, pending.row.id, pending.requestId);
      setPending(null); setNotice("Agent paused and activity recorded.");
      refresh();
    } catch (err) { setPauseError(err instanceof Error ? err.message : "Pause failed. Refresh the agent status before retrying."); refresh(); }
    finally { setBusy(false); }
  }
  return <section style={surface}>
    <h1 style={{ margin: 0 }}>Agent roster</h1><p style={{ margin: 0 }}>{GUIDANCE}</p>
    <p style={{ margin: 0, color: "var(--muted-foreground)" }}>New: within 7 days. Idle: at least 7 days old and no activity in 30 days. Low use: fewer than 4 runs in 30 days and no open issues. Pausing is reversible. Termination stays on the board's agent page.</p>
    <button style={{ ...button, justifySelf: "start" }} onClick={() => { refresh(); setEvidenceVersion((v) => v + 1); }}>Refresh roster and job evidence</button>
    {notice && <p role="status">{notice}</p>}
    {pending && <PauseConfirmation key={pending.requestId} name={pending.row.name} busy={busy} error={pauseError} onCancel={() => { setPending(null); setPauseError(null); }} onConfirm={() => void confirmPause()} />}
    {keeping && <KeepConfirmation name={keeping.name} note={note} busy={busy} error={keepError} onNote={setNote} onCancel={() => { setKeeping(null); setKeepError(null); }} onConfirm={() => void saveKeep(keeping, true)} />}
    <HandOffNotice handoff={handoff} />
    {error ? <p role="alert" style={errorStyle}>Could not load agent roster: {error.message}</p> : loading ? <p>Loading agent roster...</p> : !roster ? <p role="alert">The roster response is missing or belongs to another company. Refresh to retry.</p> : <>
      <RosterTable rows={roster.rows} prefix={prefix} handoff={handoff} busy={busy || pending !== null || keeping !== null} canPause={roster.canPause === true} onPause={(row) => { setNotice(null); setPauseError(null); setPending({ row, requestId: newPauseRequestId() }); }} onKeep={(row) => { setPending(null); setKeepError(null); setNotice(null); setNote(row.keep?.note ?? ""); setKeeping(row); }} onUnkeep={(row) => void saveKeep(row, false)} />
      <p style={{ color: "var(--muted-foreground)" }}>Updated {new Date(roster.generatedAt).toLocaleString()}. Hand-off links show recorded production work, not job ownership. Job evidence does not change the activity verdict.</p>
    </>}
  </section>;
}

export { AgentRosterPage as RosterPage, AgentRosterSidebar as RosterSidebarItem, AgentRosterWidget as RosterWidget };
