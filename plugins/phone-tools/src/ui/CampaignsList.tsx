import { useEffect, useState, type CSSProperties } from "react";

interface CampaignSummary {
  campaign: {
    id: string;
    name: string;
    purpose: string;
    status: string;
    startedAt?: string;
    createdAt: string;
    accountKey: string;
    pacing: { maxPerDay: number };
  };
  counters: { attempted: number; qualified: number; transferred: number; costUsd: number };
  totalLeads: number;
  done: number;
}

export interface CampaignsListProps {
  companyId: string;
  onSelect: (campaignId: string) => void;
  onNew: () => void;
}

const STATUSES = ["all", "running", "paused", "draft", "stopped", "completed"] as const;
type StatusFilter = (typeof STATUSES)[number];

export function CampaignsList({ companyId, onSelect, onNew }: CampaignsListProps) {
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [campaigns, setCampaigns] = useState<CampaignSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCampaigns(null);
    setError(null);
    const url = new URL("/api/plugins/phone-tools/api/campaigns", window.location.origin);
    url.searchParams.set("companyId", companyId);
    if (filter !== "all") url.searchParams.set("status", filter);
    fetch(url.toString(), { credentials: "include" })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(
            body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string"
              ? (body as { error: string }).error
              : `Request failed (${res.status})`,
          );
        }
        return body as { campaigns: CampaignSummary[] };
      })
      .then((body) => {
        if (cancelled) return;
        setCampaigns(body.campaigns);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [companyId, filter]);

  return (
    <div style={stack}>
      <div style={toolbar}>
        <div style={{ display: "flex", gap: 6 }}>
          {STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setFilter(s)}
              style={s === filter ? activeChip : chip}
            >
              {s}
            </button>
          ))}
        </div>
        <button type="button" onClick={onNew} style={primaryButton}>
          + New campaign
        </button>
      </div>

      {error && <div style={errBox}>{error}</div>}

      {campaigns == null && !error && <p style={muted}>Loading…</p>}

      {campaigns && campaigns.length === 0 && (
        <div style={emptyState}>
          <p style={{ margin: 0, fontSize: 13 }}>
            No campaigns yet{filter !== "all" ? ` in status '${filter}'` : ""}.
          </p>
          <p style={{ ...muted, fontSize: 12, marginTop: 6 }}>
            Click <strong>+ New campaign</strong> to create one. You'll need an assistant with
            warm transfer configured before you can start it.
          </p>
        </div>
      )}

      {campaigns && campaigns.length > 0 && (
        <table style={table}>
          <thead>
            <tr style={trHead}>
              <th style={thLeft}>Name</th>
              <th style={th}>Status</th>
              <th style={th}>Progress</th>
              <th style={th}>Today</th>
              <th style={th}>Cost today</th>
              <th style={th}>Account</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map(({ campaign, counters, totalLeads, done }) => {
              const pct = totalLeads > 0 ? Math.round((done / totalLeads) * 100) : 0;
              return (
                <tr
                  key={campaign.id}
                  style={trBody}
                  onClick={() => onSelect(campaign.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onSelect(campaign.id);
                  }}
                  tabIndex={0}
                >
                  <td style={tdLeft}>
                    <div style={{ fontWeight: 600 }}>{campaign.name}</div>
                    <div style={{ ...muted, fontSize: 11, marginTop: 2 }}>{campaign.purpose}</div>
                  </td>
                  <td style={td}>
                    <StatusBadge status={campaign.status} />
                  </td>
                  <td style={td}>
                    {done}/{totalLeads} ({pct}%)
                  </td>
                  <td style={td}>{counters.attempted}</td>
                  <td style={td}>${counters.costUsd.toFixed(2)}</td>
                  <td style={{ ...td, fontFamily: "monospace", fontSize: 11 }}>
                    {campaign.accountKey}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const color =
    status === "running"
      ? "var(--foreground)"
      : status === "paused"
        ? "var(--muted-foreground)"
        : status === "stopped" || status === "completed"
          ? "var(--muted-foreground)"
          : "var(--foreground)";
  return (
    <span
      style={{
        fontSize: 11,
        padding: "2px 8px",
        border: "1px solid var(--border)",
        color,
      }}
    >
      {status}
    </span>
  );
}

const stack: CSSProperties = { display: "flex", flexDirection: "column", gap: 12 };
const toolbar: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  flexWrap: "wrap",
};
const chip: CSSProperties = {
  appearance: "none",
  border: "1px solid var(--border)",
  background: "transparent",
  color: "inherit",
  padding: "4px 10px",
  fontSize: 12,
  cursor: "pointer",
  textTransform: "capitalize",
};
const activeChip: CSSProperties = { ...chip, background: "var(--foreground)", color: "var(--background)" };
const primaryButton: CSSProperties = {
  appearance: "none",
  border: "1px solid var(--foreground)",
  background: "var(--foreground)",
  color: "var(--background)",
  padding: "6px 14px",
  fontSize: 13,
  cursor: "pointer",
};
const muted: CSSProperties = { color: "var(--muted-foreground)" };
const errBox: CSSProperties = {
  padding: 12,
  border: "1px solid var(--destructive, #f00)",
  color: "var(--destructive, #f00)",
  fontSize: 13,
};
const emptyState: CSSProperties = { padding: 24, border: "1px dashed var(--border)", textAlign: "center" };
const table: CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 13 };
const trHead: CSSProperties = { borderBottom: "1px solid var(--border)" };
const trBody: CSSProperties = { borderBottom: "1px solid var(--border)", cursor: "pointer" };
const th: CSSProperties = { textAlign: "left", padding: "6px 8px", fontSize: 12, fontWeight: 600, color: "var(--muted-foreground)" };
const thLeft: CSSProperties = { ...th, paddingLeft: 0 };
const td: CSSProperties = { padding: "8px" };
const tdLeft: CSSProperties = { ...td, paddingLeft: 0 };
