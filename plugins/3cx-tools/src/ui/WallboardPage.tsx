import { useEffect, useState } from "react";
import {
  useHostContext,
  usePluginData,
  type PluginPageProps,
} from "@paperclipai/plugin-sdk/ui";
import { Badge, formatDuration, PageContainer, PageHeader } from "./common.js";

interface ParkedCall {
  slot: string;
  callerNumber: string;
  parkedSinceSec: number;
}
interface ActiveCall {
  callId: string;
  fromNumber: string;
  toNumber: string;
  extension?: string;
  queue?: string;
  durationSec: number;
  direction: "inbound" | "outbound" | "internal";
}
interface Queue {
  id: string;
  name: string;
  extension: string;
  depth: number;
  longestWaitSec: number;
  agentsOn: number;
}
type Presence = "available" | "busy" | "away" | "dnd" | "offline";
interface Agent {
  extension: string;
  name: string;
  presence: Presence;
}

const REFRESH_MS = 2500;

/**
 * Office-TV wallboard. Single page, four panels (queues / active /
 * parked / agents) all refreshing in lockstep. Optimized for at-a-glance
 * — large numbers, bold colors on threshold crosses, no fluff.
 */
export function WallboardPage(_props: PluginPageProps) {
  const host = useHostContext();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  const params = { companyId: host.companyId, tick };
  const queues = usePluginData<{ queues: Queue[] }>("phone.queues", params).data?.queues ?? [];
  const active = usePluginData<{ calls: ActiveCall[] }>("phone.active-calls", params).data?.calls ?? [];
  const parked = usePluginData<{ parked: ParkedCall[] }>("phone.parked-calls", params).data?.parked ?? [];
  const agents = usePluginData<{ agents: Agent[] }>("phone.agents", params).data?.agents ?? [];

  const onCall = active.length;
  const totalDepth = queues.reduce((s, q) => s + q.depth, 0);
  const longestWait = Math.max(0, ...queues.map((q) => q.longestWaitSec));
  const available = agents.filter((a) => a.presence === "available").length;

  return (
    <PageContainer>
      <PageHeader
        title="Wallboard"
        subtitle={`Live · refreshes every ${REFRESH_MS / 1000}s`}
      />

      {/* KPI row */}
      <div style={kpiRow}>
        <Kpi label="On the wire" value={onCall} tone={onCall > 0 ? "green" : "neutral"} />
        <Kpi label="Total queue depth" value={totalDepth} tone={totalDepth >= 5 ? "red" : totalDepth >= 2 ? "yellow" : "green"} />
        <Kpi label="Longest wait" value={formatDuration(longestWait)} tone={longestWait >= 120 ? "red" : longestWait >= 60 ? "yellow" : "green"} />
        <Kpi label="Parked" value={parked.length} tone={parked.length > 0 ? "yellow" : "neutral"} />
        <Kpi label="Agents available" value={available} tone={available > 0 ? "green" : "red"} />
      </div>

      {/* Four-panel layout */}
      <div style={gridRow}>
        <Panel title="Queues">
          {queues.length === 0 ? (
            <Empty>No queues in scope</Empty>
          ) : (
            <table style={panelTable}>
              <tbody>
                {queues.map((q) => (
                  <tr key={q.id}>
                    <td style={panelLabel}>{q.name}</td>
                    <td style={panelValue}>
                      <Badge tone={q.depth >= 5 ? "red" : q.depth >= 2 ? "yellow" : "green"}>{q.depth}</Badge>
                    </td>
                    <td style={panelValueRight}>{formatDuration(q.longestWaitSec)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title={`Active calls (${active.length})`}>
          {active.length === 0 ? (
            <Empty>Nothing on the wire</Empty>
          ) : (
            <table style={panelTable}>
              <tbody>
                {active.slice(0, 8).map((c) => (
                  <tr key={c.callId}>
                    <td style={panelLabel}>
                      <Badge tone={c.direction === "inbound" ? "green" : c.direction === "outbound" ? "blue" : "neutral"}>
                        {c.direction === "inbound" ? "in" : c.direction === "outbound" ? "out" : "int"}
                      </Badge>
                    </td>
                    <td style={panelValueMono}>{c.fromNumber || "—"} → {c.toNumber || "—"}</td>
                    <td style={panelValueRight}>{formatDuration(c.durationSec)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title={`Parked (${parked.length})`}>
          {parked.length === 0 ? (
            <Empty>Nothing parked</Empty>
          ) : (
            <table style={panelTable}>
              <tbody>
                {parked.map((p) => (
                  <tr key={`${p.slot}-${p.callerNumber}`}>
                    <td style={panelLabel}>
                      <Badge tone="green">{p.slot}</Badge>
                    </td>
                    <td style={panelValueMono}>{p.callerNumber}</td>
                    <td style={panelValueRight}>{formatDuration(p.parkedSinceSec)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title={`Agents (${available}/${agents.length} available)`}>
          {agents.length === 0 ? (
            <Empty>No agents in scope</Empty>
          ) : (
            <div style={agentGrid}>
              {agents.slice(0, 24).map((a) => (
                <div key={a.extension} style={agentChip} title={`${a.name} (${a.presence})`}>
                  <span style={{ ...agentDot, background: presenceColor(a.presence) }} aria-hidden />
                  <span style={{ fontSize: 11, fontFamily: "ui-monospace, SFMono-Regular, monospace" }}>{a.extension}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </PageContainer>
  );
}

function Kpi({ label, value, tone }: { label: string; value: number | string; tone: "green" | "yellow" | "red" | "neutral" }) {
  const color =
    tone === "green" ? "rgb(140, 230, 160)" :
    tone === "yellow" ? "rgb(245, 215, 130)" :
    tone === "red" ? "rgb(255, 140, 140)" :
    "var(--foreground)";
  return (
    <div style={kpiCard}>
      <div style={kpiLabel}>{label}</div>
      <div style={{ ...kpiValue, color }}>{value}</div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={panel}>
      <div style={panelHeader}>{title}</div>
      <div style={panelBody}>{children}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ opacity: 0.5, fontSize: 12, padding: "12px 4px" }}>{children}</div>;
}

function presenceColor(p: Presence): string {
  switch (p) {
    case "available":
      return "rgb(80, 200, 120)";
    case "busy":
      return "rgb(245, 200, 80)";
    case "away":
      return "rgb(120, 160, 230)";
    case "dnd":
      return "rgb(230, 80, 80)";
    case "offline":
    default:
      return "rgba(180, 180, 180, 0.45)";
  }
}

const kpiRow: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
  gap: 12,
  marginBottom: 16,
};
const kpiCard: React.CSSProperties = {
  padding: "16px 18px",
  background: "var(--card, rgba(255,255,255,0.02))",
  border: "1px solid var(--border, rgba(255,255,255,0.06))",
  borderRadius: 6,
};
const kpiLabel: React.CSSProperties = {
  fontSize: 11,
  opacity: 0.6,
  textTransform: "uppercase",
  letterSpacing: 0.5,
};
const kpiValue: React.CSSProperties = {
  fontSize: 32,
  fontWeight: 700,
  marginTop: 4,
  fontFamily: "ui-monospace, SFMono-Regular, monospace",
};
const gridRow: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
  gap: 12,
};
const panel: React.CSSProperties = {
  background: "var(--card, rgba(255,255,255,0.02))",
  border: "1px solid var(--border, rgba(255,255,255,0.06))",
  borderRadius: 6,
  overflow: "hidden",
};
const panelHeader: React.CSSProperties = {
  padding: "10px 14px",
  fontSize: 12,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  opacity: 0.7,
  borderBottom: "1px solid var(--border, rgba(255,255,255,0.06))",
};
const panelBody: React.CSSProperties = { padding: "8px 14px 12px" };
const panelTable: React.CSSProperties = { width: "100%", borderCollapse: "collapse" };
const panelLabel: React.CSSProperties = { padding: "6px 0", fontSize: 13 };
const panelValue: React.CSSProperties = { padding: "6px 0" };
const panelValueMono: React.CSSProperties = { padding: "6px 0", fontSize: 12, fontFamily: "ui-monospace, SFMono-Regular, monospace" };
const panelValueRight: React.CSSProperties = { padding: "6px 0", textAlign: "right", fontSize: 12, fontFamily: "ui-monospace, SFMono-Regular, monospace", opacity: 0.85 };
const agentGrid: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(64px, 1fr))", gap: 6 };
const agentChip: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  padding: "4px 6px",
  background: "rgba(255,255,255,0.04)",
  borderRadius: 4,
};
const agentDot: React.CSSProperties = {
  display: "inline-block",
  width: 8,
  height: 8,
  borderRadius: "50%",
};
