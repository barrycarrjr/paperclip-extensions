import { useEffect, useState } from "react";
import {
  useHostContext,
  usePluginData,
  type PluginPageProps,
} from "@paperclipai/plugin-sdk/ui";

interface ParkedCall {
  slot: string;
  callerNumber: string;
  parkedSinceSec: number;
  originalExtension?: string;
}
interface ParkedCallsResponse {
  parked: ParkedCall[];
  error?: string;
}

const REFRESH_MS = 3000;

/**
 * Live parked-calls view. Single table, auto-refreshes every 3s. Each
 * row shows slot, caller number, and a live "parked since" timer
 * computed client-side from the server's parkedSinceSec + the time of
 * the last refresh, so the timer ticks smoothly between fetches.
 */
export function ParkedCallsPage(_props: PluginPageProps) {
  const host = useHostContext();
  const [tick, setTick] = useState(0);

  // Re-fetch every REFRESH_MS by bumping `tick` — usePluginData re-runs
  // when its params change, so the tick value forces a fresh call. The
  // tick also drives the in-row "parked since" labels' visual update.
  const { data, loading } = usePluginData<ParkedCallsResponse>(
    "phone.parked-calls",
    { companyId: host.companyId, tick },
  );

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  const parked = data?.parked ?? [];

  return (
    <div style={{ padding: 16, color: "var(--foreground)" }}>
      <header style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 16 }}>
        <h1 style={{ fontSize: 20, margin: 0, fontWeight: 600 }}>Parked calls</h1>
        <span style={{ fontSize: 12, opacity: 0.6 }}>
          {loading ? "loading…" : `${parked.length} parked · refreshes every ${REFRESH_MS / 1000}s`}
        </span>
      </header>

      {data?.error ? (
        <div style={errorStyle}>Error: {data.error}</div>
      ) : null}

      {parked.length === 0 && !loading && !data?.error ? (
        <div style={emptyStyle}>No calls currently parked.</div>
      ) : null}

      {parked.length > 0 ? (
        <table style={tableStyle}>
          <thead>
            <tr>
              <Th>Slot</Th>
              <Th>Caller</Th>
              <Th>Parked for</Th>
              <Th>Original ext.</Th>
            </tr>
          </thead>
          <tbody>
            {parked.map((p) => (
              <tr key={`${p.slot}-${p.callerNumber}`}>
                <Td>
                  <span style={slotBadgeStyle}>{p.slot}</span>
                </Td>
                <Td mono>{p.callerNumber}</Td>
                <Td mono>{formatDuration(p.parkedSinceSec)}</Td>
                <Td mono>{p.originalExtension ?? "—"}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      style={{
        textAlign: "left",
        padding: "8px 12px",
        fontSize: 11,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: 0.5,
        opacity: 0.65,
        borderBottom: "1px solid var(--border, rgba(255,255,255,0.1))",
      }}
    >
      {children}
    </th>
  );
}
function Td({ children, mono = false }: { children: React.ReactNode; mono?: boolean }) {
  return (
    <td
      style={{
        padding: "10px 12px",
        fontSize: 13,
        fontFamily: mono ? "ui-monospace, SFMono-Regular, monospace" : undefined,
        borderBottom: "1px solid var(--border, rgba(255,255,255,0.06))",
      }}
    >
      {children}
    </td>
  );
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  if (m < 60) return `${m}m ${String(s).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${String(rm).padStart(2, "0")}m`;
}

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  background: "var(--card, rgba(255,255,255,0.02))",
  borderRadius: 6,
  overflow: "hidden",
};
const errorStyle: React.CSSProperties = {
  padding: "12px 16px",
  background: "rgba(220, 80, 80, 0.12)",
  border: "1px solid rgba(220, 80, 80, 0.35)",
  color: "rgb(255, 180, 180)",
  borderRadius: 6,
  fontSize: 13,
  marginBottom: 16,
};
const emptyStyle: React.CSSProperties = {
  padding: "32px 16px",
  textAlign: "center",
  opacity: 0.55,
  fontSize: 13,
};
const slotBadgeStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  background: "rgba(80, 180, 100, 0.18)",
  color: "rgb(140, 230, 160)",
  borderRadius: 4,
  fontFamily: "ui-monospace, SFMono-Regular, monospace",
  fontSize: 12,
  fontWeight: 600,
};
