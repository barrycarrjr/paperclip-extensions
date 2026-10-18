import { useState, type CSSProperties } from "react";
import { useHostContext, usePluginAction, usePluginData, type PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import type { Roster, RosterRow, Verdict } from "../roster.js";
import { daysAgo, errorText, formatCost, VERDICT_HINTS, VERDICT_LABELS } from "./format.js";

const border = "1px solid var(--border)";
const muted: CSSProperties = { color: "var(--muted-foreground)", fontSize: 13 };
const card: CSSProperties = { border, borderRadius: 8, padding: 16, background: "var(--card)", color: "var(--card-foreground)" };
const button: CSSProperties = { border, borderRadius: 6, padding: "4px 10px", background: "var(--background)", color: "var(--foreground)", cursor: "pointer", font: "inherit", fontSize: 13 };
const cell: CSSProperties = { padding: "8px 10px", borderBottom: border, textAlign: "left", verticalAlign: "top" };
const numberCell: CSSProperties = { ...cell, textAlign: "right", whiteSpace: "nowrap" };

const VERDICT_TONE: Record<Verdict, string> = {
  idle: "var(--destructive)",
  low_use: "color-mix(in oklab, var(--destructive) 55%, var(--foreground))",
  kept: "var(--muted-foreground)",
  active: "var(--foreground)",
  new: "var(--muted-foreground)",
};

interface RosterData {
  roster: Roster;
  canPause: boolean;
}

function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return (
    <span title={VERDICT_HINTS[verdict]} style={{ color: VERDICT_TONE[verdict], border: `1px solid ${VERDICT_TONE[verdict]}`, borderRadius: 999, padding: "1px 8px", fontSize: 12, whiteSpace: "nowrap" }}>
      {VERDICT_LABELS[verdict]}
    </span>
  );
}

function KeepForm({ onSave, onCancel }: { onSave: (note: string) => Promise<void>; onCancel: () => void }) {
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <form
      style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}
      onSubmit={async (event) => {
        event.preventDefault();
        setSaving(true);
        try {
          await onSave(note);
        } finally {
          setSaving(false);
        }
      }}
    >
      <input
        aria-label="Why keep this agent"
        placeholder="Why keep it? e.g. seasonal work"
        value={note}
        maxLength={500}
        onChange={(event) => setNote(event.target.value)}
        style={{ ...button, cursor: "text", minWidth: 200, flex: 1 }}
      />
      <button type="submit" style={button} disabled={saving || note.trim().length === 0}>Save</button>
      <button type="button" style={button} onClick={onCancel}>Cancel</button>
    </form>
  );
}

function AgentRow({ row, agentHref, canPause, busy, act }: {
  row: RosterRow;
  agentHref: string;
  canPause: boolean;
  busy: boolean;
  act: (action: "pause" | "keep" | "unkeep", agentId: string, note?: string) => Promise<boolean>;
}) {
  const [keeping, setKeeping] = useState(false);
  const flagged = row.usage === "idle" || row.usage === "low_use";
  return (
    <tr>
      <td style={cell}>
        <a href={agentHref} style={{ color: "var(--foreground)", fontWeight: 600 }}>{row.name}</a>
        <div style={muted}>{row.title || row.role}{row.status === "paused" ? " · paused" : ""}</div>
        {row.keep && <div style={muted}>Kept: {row.keep.note}</div>}
        {keeping && <KeepForm onCancel={() => setKeeping(false)} onSave={async (note) => { if (await act("keep", row.agentId, note)) setKeeping(false); }} />}
      </td>
      <td style={cell}><VerdictBadge verdict={row.verdict} /></td>
      <td style={{ ...cell, whiteSpace: "nowrap" }}>{daysAgo(row.lastRunAt)}</td>
      <td style={numberCell}>{row.runsLast30Days}</td>
      <td style={numberCell}>{row.runsLast90Days}</td>
      <td style={numberCell}>{formatCost(row.costCentsLast30Days)}</td>
      <td style={numberCell}>{row.openIssues}</td>
      <td style={{ ...cell, whiteSpace: "nowrap" }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {canPause && row.status !== "paused" && (
            <button
              type="button"
              style={button}
              disabled={busy}
              onClick={() => {
                if (window.confirm(`Pause ${row.name}? It stops taking work until someone resumes it on its agent page.`)) void act("pause", row.agentId);
              }}
            >
              Pause
            </button>
          )}
          {flagged && !row.keep && !keeping && <button type="button" style={button} disabled={busy} onClick={() => setKeeping(true)}>Keep</button>}
          {row.keep && <button type="button" style={button} disabled={busy} onClick={() => void act("unkeep", row.agentId)}>Remove keep</button>}
        </div>
      </td>
    </tr>
  );
}

export function RosterPage(_props: PluginPageProps) {
  const host = useHostContext();
  const { data, loading, error, refresh } = usePluginData<RosterData>("roster.list", { companyId: host.companyId });
  const pause = usePluginAction("roster.pause-agent");
  const keep = usePluginAction("roster.keep-agent");
  const unkeep = usePluginAction("roster.unkeep-agent");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function act(action: "pause" | "keep" | "unkeep", agentId: string, note?: string): Promise<boolean> {
    setBusy(true);
    setActionError(null);
    try {
      if (action === "pause") await pause({ companyId: host.companyId, agentId });
      if (action === "keep") await keep({ companyId: host.companyId, agentId, note });
      if (action === "unkeep") await unkeep({ companyId: host.companyId, agentId });
      refresh();
      return true;
    } catch (err) {
      setActionError(errorText(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const agentHref = (agentId: string) => (host.companyPrefix ? `/${host.companyPrefix}/agents/${agentId}` : `/agents/${agentId}`);

  return (
    <div style={{ display: "grid", gap: 16, padding: 16, color: "var(--foreground)" }}>
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Agent roster</h1>
        <p style={{ ...muted, maxWidth: 720 }}>
          Every agent costs tokens and adds noise, so each one should have a recurring job or regular assigned work.
          Review Idle and Low use agents first: pause one, open it to terminate it, or keep it with a note if it is idle on purpose.
          Add a new agent only for a job the Hand-off work audit found.
        </p>
      </div>

      {actionError && <p role="alert" style={{ color: "var(--destructive)", margin: 0 }}>{actionError}</p>}

      {error ? (
        <p role="alert" style={{ color: "var(--destructive)" }}>{errorText(error)}</p>
      ) : loading && !data ? (
        <p style={muted}>Loading agents…</p>
      ) : data && data.roster.rows.length === 0 ? (
        <div style={card}>This company has no agents.</div>
      ) : data ? (
        <>
          <div style={{ ...card, display: "flex", gap: 24, flexWrap: "wrap" }}>
            <span><strong>{data.roster.summary.agentCount}</strong> agents</span>
            <span><strong>{data.roster.summary.idleCount}</strong> idle</span>
            <span><strong>{data.roster.summary.lowUseCount}</strong> low use</span>
            <span><strong>{data.roster.summary.keptCount}</strong> kept on purpose</span>
            <span><strong>{formatCost(data.roster.summary.flaggedCostCentsLast30Days)}</strong> spent on idle and low use agents in 30 days</span>
          </div>
          {!data.canPause && <p style={muted}>Only an instance admin can pause agents from here.</p>}
          <div style={{ overflowX: "auto", border, borderRadius: 8 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr style={muted}>
                  <th style={cell}>Agent</th>
                  <th style={cell}>Verdict</th>
                  <th style={cell}>Last run</th>
                  <th style={{ ...numberCell, fontWeight: 500 }}>Runs, 30 days</th>
                  <th style={{ ...numberCell, fontWeight: 500 }}>Runs, 90 days</th>
                  <th style={{ ...numberCell, fontWeight: 500 }}>Cost, 30 days</th>
                  <th style={{ ...numberCell, fontWeight: 500 }}>Open issues</th>
                  <th style={cell}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.roster.rows.map((row) => (
                  <AgentRow key={row.agentId} row={row} agentHref={agentHref(row.agentId)} canPause={data.canPause} busy={busy} act={act} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}
