import { useState } from "react";
import {
  useHostContext,
  usePluginData,
  type PluginPageProps,
} from "@paperclipai/plugin-sdk/ui";
import {
  EmptyState,
  ErrorBanner,
  PageContainer,
  PageHeader,
  formatDuration,
} from "./common.js";

interface DayStats {
  offered: number;
  answered: number;
  abandoned: number;
  internalCalls: number;
  avgWaitSec: number;
  avgHandleSec: number;
  peakDepth: number;
  abandonRate: number;
  sla: { answeredWithinTargetPct: number; targetSec: number };
}
interface DailyReportResponse {
  stats: DayStats;
  error?: string;
}

type Day = "today" | "yesterday";

export function DailyReportPage(_props: PluginPageProps) {
  const host = useHostContext();
  const [day, setDay] = useState<Day>("today");
  const { data, loading } = usePluginData<DailyReportResponse>(
    "phone.daily-report",
    { companyId: host.companyId, day },
  );

  return (
    <PageContainer>
      <PageHeader
        title="Daily report"
        subtitle={loading ? "loading…" : day === "today" ? "Today's totals" : "Yesterday's totals"}
        right={
          <select value={day} onChange={(e) => setDay(e.target.value as Day)} style={selectStyle}>
            <option value="today">Today</option>
            <option value="yesterday">Yesterday</option>
          </select>
        }
      />
      {data?.error ? <ErrorBanner message={data.error} /> : null}
      {!loading && !data?.error && !data?.stats ? (
        <EmptyState>No data yet.</EmptyState>
      ) : null}
      {data?.stats ? (
        <div style={gridStyle}>
          <Stat label="Calls offered" value={data.stats.offered} />
          <Stat label="Answered" value={data.stats.answered} tone="green" />
          <Stat label="Abandoned" value={data.stats.abandoned} tone="red" />
          <Stat label="Internal" value={data.stats.internalCalls} />
          <Stat label="Abandon rate" value={pct(data.stats.abandonRate)} tone={data.stats.abandonRate > 0.1 ? "red" : "neutral"} />
          <Stat label="SLA (answered within target)" value={pct(data.stats.sla.answeredWithinTargetPct)} sub={`target ${data.stats.sla.targetSec}s`} />
          <Stat label="Avg wait" value={formatDuration(data.stats.avgWaitSec)} />
          <Stat label="Avg handle" value={formatDuration(data.stats.avgHandleSec)} />
          <Stat label="Peak queue depth" value={data.stats.peakDepth} />
        </div>
      ) : null}
    </PageContainer>
  );
}

function Stat({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: number | string;
  sub?: string;
  tone?: "green" | "red" | "neutral";
}) {
  const color =
    tone === "green" ? "rgb(140, 230, 160)" : tone === "red" ? "rgb(255, 180, 180)" : "var(--foreground)";
  return (
    <div style={statCard}>
      <div style={{ fontSize: 11, opacity: 0.6, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 600, color, marginTop: 4, fontFamily: "ui-monospace, SFMono-Regular, monospace" }}>
        {value}
      </div>
      {sub ? <div style={{ fontSize: 11, opacity: 0.5, marginTop: 2 }}>{sub}</div> : null}
    </div>
  );
}

function pct(p: number): string {
  if (!Number.isFinite(p)) return "—";
  return `${(p * 100).toFixed(1)}%`;
}

const gridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
  gap: 12,
};
const statCard: React.CSSProperties = {
  padding: "14px 16px",
  background: "var(--card, rgba(255,255,255,0.02))",
  border: "1px solid var(--border, rgba(255,255,255,0.06))",
  borderRadius: 6,
};
const selectStyle: React.CSSProperties = {
  background: "var(--input, rgba(255,255,255,0.05))",
  color: "inherit",
  border: "1px solid var(--border, rgba(255,255,255,0.1))",
  borderRadius: 6,
  padding: "4px 8px",
  fontSize: 12,
};
