import { useEffect, useState, type CSSProperties } from "react";

interface CampaignFull {
  campaign: {
    id: string;
    name: string;
    purpose: string;
    status: string;
    accountKey: string;
    assistantAgentId: string;
    pacing: { maxConcurrent: number; secondsBetweenDials: number; maxPerHour: number; maxPerDay: number };
    retry: { onNoAnswer: { afterSec: number; maxAttempts: number }; onBusy: { afterSec: number; maxAttempts: number } };
    preflight: {
      audienceKind: string;
      listSource: string;
      geographicScope: string[];
      callerLocalHours: { startHour: number; endHour: number; weekendsAllowed: boolean };
      acknowledgedAt: string;
      acknowledgedBy: string;
    };
    outcomeIssueProjectId?: string;
    startedAt?: string;
    pausedAt?: string;
    stoppedAt?: string;
    createdAt: string;
    createdBy: string;
  };
  counters: { attempted: number; qualified: number; disqualified: number; noAnswer: number; transferred: number; costUsd: number };
  leadsByStatus: Record<string, number>;
}

interface Lead {
  phoneE164: string;
  name?: string;
  businessName?: string;
  status: string;
  attempts: number;
  lastAttemptAt?: string;
  nextAttemptAfter?: string;
  outcome?: { summary: string; transferred: boolean; issueId?: string };
}

export interface CampaignDetailProps {
  campaignId: string;
  companyId: string;
  onBack: () => void;
  onChanged: () => void;
}

export function CampaignDetail({ campaignId, companyId, onBack, onChanged }: CampaignDetailProps) {
  const [data, setData] = useState<CampaignFull | null>(null);
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);

  async function load() {
    setError(null);
    try {
      const detailUrl = new URL(`/api/plugins/phone-tools/api/campaigns/${campaignId}`, window.location.origin);
      detailUrl.searchParams.set("companyId", companyId);
      const detailRes = await fetch(detailUrl.toString(), { credentials: "include" });
      const detailBody = await detailRes.json().catch(() => null);
      if (!detailRes.ok) throw new Error(extractError(detailBody, detailRes.status));
      setData(detailBody as CampaignFull);

      const leadsUrl = new URL(`/api/plugins/phone-tools/api/campaigns/${campaignId}/leads`, window.location.origin);
      leadsUrl.searchParams.set("companyId", companyId);
      leadsUrl.searchParams.set("limit", "200");
      const leadsRes = await fetch(leadsUrl.toString(), { credentials: "include" });
      const leadsBody = await leadsRes.json().catch(() => null);
      if (leadsRes.ok) setLeads((leadsBody as { leads: Lead[] }).leads);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void load();
    // v0.5.5: tightened to 3s while running so the counters feel
    // live during a smoke test or a small campaign. Idle campaigns
    // (paused / draft / stopped) don't re-poll. SSE on the
    // /campaigns/:id/events endpoint is planned for v0.6.x — once
    // that lands, this poll becomes the fallback for clients that
    // can't open an EventSource (older proxies, mobile webviews).
    const id = window.setInterval(() => {
      if (data?.campaign.status === "running") void load();
    }, 3_000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, companyId, data?.campaign.status]);

  async function action(verb: "start" | "pause" | "resume" | "stop") {
    if (!data) return;
    setActing(true);
    setError(null);
    try {
      const url = new URL(
        `/api/plugins/phone-tools/api/campaigns/${campaignId}/${verb}`,
        window.location.origin,
      );
      url.searchParams.set("companyId", companyId);
      const res = await fetch(url.toString(), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({}),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(extractError(body, res.status));
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(false);
    }
  }

  if (error) {
    return (
      <div style={stack}>
        <button type="button" onClick={onBack} style={ghostButton}>
          ← Back
        </button>
        <div style={errBox}>{error}</div>
      </div>
    );
  }
  if (!data) return <p style={muted}>Loading…</p>;

  const c = data.campaign;
  const totalLeads = Object.values(data.leadsByStatus).reduce((n, v) => n + (v ?? 0), 0);
  const done =
    (data.leadsByStatus.qualified ?? 0) +
    (data.leadsByStatus.disqualified ?? 0) +
    (data.leadsByStatus.transferred ?? 0) +
    (data.leadsByStatus.dnc ?? 0) +
    (data.leadsByStatus.voicemail ?? 0);

  return (
    <div style={stack}>
      <button type="button" onClick={onBack} style={ghostButton}>
        ← Back to list
      </button>

      <div style={headerCard}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <h2 style={{ margin: 0, fontSize: 18 }}>{c.name}</h2>
              <StatusBadge status={c.status} />
            </div>
            <p style={{ ...muted, fontSize: 13, marginTop: 4 }}>{c.purpose}</p>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {c.status === "draft" && (
              <button type="button" onClick={() => action("start")} disabled={acting} style={primaryButton}>
                ▶ Start
              </button>
            )}
            {c.status === "running" && (
              <button type="button" onClick={() => action("pause")} disabled={acting} style={ghostButton}>
                ⏸ Pause
              </button>
            )}
            {c.status === "paused" && (
              <button type="button" onClick={() => action("resume")} disabled={acting} style={primaryButton}>
                ▶ Resume
              </button>
            )}
            {(c.status === "running" || c.status === "paused" || c.status === "draft") && (
              <button type="button" onClick={() => action("stop")} disabled={acting} style={destructiveButton}>
                ⏹ Stop
              </button>
            )}
          </div>
        </div>
      </div>

      <section style={panel}>
        <h3 style={panelTitle}>Today</h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12 }}>
          <Stat label="Attempted" value={String(data.counters.attempted)} />
          <Stat label="Qualified" value={String(data.counters.qualified)} />
          <Stat label="Transferred" value={String(data.counters.transferred)} />
          <Stat label="Disqualified" value={String(data.counters.disqualified)} />
          <Stat label="Cost" value={`$${data.counters.costUsd.toFixed(2)}`} />
        </div>
      </section>

      <section style={panel}>
        <h3 style={panelTitle}>
          Lead progress {totalLeads > 0 && <span style={muted}>({done}/{totalLeads})</span>}
        </h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12 }}>
          <Stat label="Pending" value={String(data.leadsByStatus.pending ?? 0)} />
          <Stat label="No-answer" value={String(data.leadsByStatus["no-answer"] ?? 0)} />
          <Stat label="Qualified" value={String(data.leadsByStatus.qualified ?? 0)} />
          <Stat label="Transferred" value={String(data.leadsByStatus.transferred ?? 0)} />
          <Stat label="DNC" value={String(data.leadsByStatus.dnc ?? 0)} />
        </div>
      </section>

      <section style={panel}>
        <h3 style={panelTitle}>Leads</h3>
        {leads == null && <p style={muted}>Loading leads…</p>}
        {leads && leads.length === 0 && (
          <p style={muted}>No leads yet — import a CSV via the API or wizard.</p>
        )}
        {leads && leads.length > 0 && (
          <div style={{ maxHeight: 360, overflow: "auto", border: "1px solid var(--border)" }}>
            <table style={table}>
              <thead>
                <tr style={trHead}>
                  <th style={thLeft}>Phone</th>
                  <th style={th}>Name / Business</th>
                  <th style={th}>Status</th>
                  <th style={th}>Attempts</th>
                  <th style={th}>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {leads.map((l) => (
                  <tr key={l.phoneE164} style={trBody}>
                    <td style={{ ...tdLeft, fontFamily: "monospace" }}>{l.phoneE164}</td>
                    <td style={td}>
                      {l.name ?? "—"}
                      {l.businessName && <span style={muted}> · {l.businessName}</span>}
                    </td>
                    <td style={td}>
                      <StatusBadge status={l.status} />
                    </td>
                    <td style={td}>{l.attempts}</td>
                    <td style={{ ...td, fontSize: 12 }}>
                      {l.outcome?.summary ?? (l.nextAttemptAfter ? `retry @ ${formatTs(l.nextAttemptAfter)}` : "—")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section style={panel}>
        <h3 style={panelTitle}>Configuration</h3>
        <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", rowGap: 6, fontSize: 13 }}>
          <span style={muted}>Account</span>
          <span style={{ fontFamily: "monospace", fontSize: 12 }}>{c.accountKey}</span>
          <span style={muted}>Driving assistant</span>
          <span style={{ fontFamily: "monospace", fontSize: 12 }}>{c.assistantAgentId}</span>
          <span style={muted}>Outcome project</span>
          <span style={{ fontFamily: "monospace", fontSize: 12 }}>
            {c.outcomeIssueProjectId ?? "—"}
          </span>
          <span style={muted}>Pacing</span>
          <span>
            max {c.pacing.maxConcurrent} concurrent · {c.pacing.secondsBetweenDials}s between dials ·{" "}
            {c.pacing.maxPerHour}/h · {c.pacing.maxPerDay}/day
          </span>
          <span style={muted}>Retry</span>
          <span>
            no-answer: every {Math.round(c.retry.onNoAnswer.afterSec / 60)}min × {c.retry.onNoAnswer.maxAttempts} ·
            busy: every {Math.round(c.retry.onBusy.afterSec / 60)}min × {c.retry.onBusy.maxAttempts}
          </span>
          <span style={muted}>Started</span>
          <span>{c.startedAt ?? "—"}</span>
        </div>
      </section>

      <section style={panel}>
        <h3 style={panelTitle}>Compliance footer</h3>
        <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", rowGap: 4, fontSize: 12 }}>
          <span style={muted}>Audience</span>
          <span>{c.preflight.audienceKind}</span>
          <span style={muted}>List source</span>
          <span>{c.preflight.listSource}</span>
          <span style={muted}>Geographic scope</span>
          <span>{c.preflight.geographicScope.join(", ")}</span>
          <span style={muted}>Hours (caller-local)</span>
          <span>
            {c.preflight.callerLocalHours.startHour}:00–{c.preflight.callerLocalHours.endHour}:00
            {c.preflight.callerLocalHours.weekendsAllowed ? " · weekends OK" : " · weekdays only"}
          </span>
          <span style={muted}>TCPA / DNC ack</span>
          <span>by {c.preflight.acknowledgedBy} at {c.preflight.acknowledgedAt}</span>
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ ...muted, fontSize: 11, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>{value}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      style={{
        fontSize: 11,
        padding: "2px 8px",
        border: "1px solid var(--border)",
        color: "var(--foreground)",
        textTransform: "capitalize",
      }}
    >
      {status}
    </span>
  );
}

function formatTs(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function extractError(body: unknown, status: number): string {
  if (body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string") {
    return (body as { error: string }).error;
  }
  return `Request failed (${status})`;
}

const stack: CSSProperties = { display: "flex", flexDirection: "column", gap: 16 };
const headerCard: CSSProperties = { padding: 16, border: "1px solid var(--border)" };
const panel: CSSProperties = { padding: 16, border: "1px solid var(--border)" };
const panelTitle: CSSProperties = { margin: "0 0 12px", fontSize: 13, fontWeight: 600 };
const muted: CSSProperties = { color: "var(--muted-foreground)" };
const errBox: CSSProperties = {
  padding: 12,
  border: "1px solid var(--destructive, #f00)",
  color: "var(--destructive, #f00)",
  fontSize: 13,
};
const ghostButton: CSSProperties = {
  appearance: "none",
  border: "1px solid var(--border)",
  background: "transparent",
  color: "inherit",
  padding: "6px 14px",
  fontSize: 13,
  cursor: "pointer",
};
const primaryButton: CSSProperties = {
  appearance: "none",
  border: "1px solid var(--foreground)",
  background: "var(--foreground)",
  color: "var(--background)",
  padding: "6px 14px",
  fontSize: 13,
  cursor: "pointer",
};
const destructiveButton: CSSProperties = {
  appearance: "none",
  border: "1px solid var(--destructive, #f00)",
  background: "transparent",
  color: "var(--destructive, #f00)",
  padding: "6px 14px",
  fontSize: 13,
  cursor: "pointer",
};
const table: CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 13 };
const trHead: CSSProperties = { borderBottom: "1px solid var(--border)", background: "var(--muted)" };
const trBody: CSSProperties = { borderBottom: "1px solid var(--border)" };
const th: CSSProperties = { textAlign: "left", padding: "6px 8px", fontSize: 11, fontWeight: 600, color: "var(--muted-foreground)" };
const thLeft: CSSProperties = { ...th, paddingLeft: 12 };
const td: CSSProperties = { padding: "6px 8px" };
const tdLeft: CSSProperties = { ...td, paddingLeft: 12 };
