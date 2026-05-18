import { useEffect, useMemo, useState } from "react";
import {
  useHostContext,
  usePluginData,
  type PluginPageProps,
} from "@paperclipai/plugin-sdk/ui";
import {
  Badge,
  EmptyState,
  ErrorBanner,
  PageContainer,
  PageHeader,
  Table,
  Td,
  Th,
  formatDuration,
  formatTimestamp,
} from "./common.js";

type Direction = "inbound" | "outbound" | "internal" | "any";
interface CallRecord {
  callId: string;
  fromNumber: string;
  toNumber: string;
  extension?: string;
  queue?: string;
  startedAt: string;
  endedAt: string;
  durationSec: number;
  direction: "inbound" | "outbound" | "internal";
  disposition: string;
}
interface HistoryResponse {
  calls: CallRecord[];
  nextCursor?: string;
  error?: string;
}

type Preset = "today" | "yesterday" | "7d" | "30d";

export function CallHistoryPage(_props: PluginPageProps) {
  const host = useHostContext();
  const [direction, setDirection] = useState<Direction>("any");
  const [preset, setPreset] = useState<Preset>("today");
  const since = useMemo(() => isoSince(preset), [preset]);

  const { data, loading } = usePluginData<HistoryResponse>("phone.call-history", {
    companyId: host.companyId,
    since,
    direction,
    limit: 200,
  });

  const calls = data?.calls ?? [];

  return (
    <PageContainer>
      <PageHeader
        title="Call history"
        subtitle={loading ? "loading…" : `${calls.length} calls`}
        right={
          <div style={{ display: "flex", gap: 8 }}>
            <select value={preset} onChange={(e) => setPreset(e.target.value as Preset)} style={selectStyle}>
              <option value="today">Today</option>
              <option value="yesterday">Yesterday</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
            </select>
            <select value={direction} onChange={(e) => setDirection(e.target.value as Direction)} style={selectStyle}>
              <option value="any">All directions</option>
              <option value="inbound">Inbound</option>
              <option value="outbound">Outbound</option>
              <option value="internal">Internal</option>
            </select>
          </div>
        }
      />
      {data?.error ? <ErrorBanner message={data.error} /> : null}
      {!loading && !data?.error && calls.length === 0 ? (
        <EmptyState>No calls in this range.</EmptyState>
      ) : null}
      {calls.length > 0 ? (
        <Table>
          <thead>
            <tr>
              <Th>Started</Th>
              <Th>Direction</Th>
              <Th>From</Th>
              <Th>To</Th>
              <Th>Ext.</Th>
              <Th>Queue</Th>
              <Th align="right">Duration</Th>
              <Th>Disposition</Th>
            </tr>
          </thead>
          <tbody>
            {calls.map((c) => (
              <tr key={c.callId}>
                <Td mono>{formatTimestamp(c.startedAt)}</Td>
                <Td>
                  <Badge tone={dirTone(c.direction)}>{c.direction}</Badge>
                </Td>
                <Td mono>{c.fromNumber || "—"}</Td>
                <Td mono>{c.toNumber || "—"}</Td>
                <Td mono>{c.extension ?? "—"}</Td>
                <Td mono>{c.queue ?? "—"}</Td>
                <Td mono align="right">{formatDuration(c.durationSec)}</Td>
                <Td>
                  <Badge tone={dispoTone(c.disposition)}>{c.disposition}</Badge>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : null}
    </PageContainer>
  );
}

function isoSince(p: Preset): string {
  const d = new Date();
  switch (p) {
    case "today":
      d.setHours(0, 0, 0, 0);
      return d.toISOString();
    case "yesterday":
      d.setDate(d.getDate() - 1);
      d.setHours(0, 0, 0, 0);
      return d.toISOString();
    case "7d":
      d.setDate(d.getDate() - 7);
      return d.toISOString();
    case "30d":
      d.setDate(d.getDate() - 30);
      return d.toISOString();
  }
}

function dirTone(d: "inbound" | "outbound" | "internal"): "green" | "blue" | "neutral" {
  if (d === "inbound") return "green";
  if (d === "outbound") return "blue";
  return "neutral";
}

function dispoTone(d: string): "green" | "yellow" | "red" | "neutral" {
  switch (d) {
    case "answered":
      return "green";
    case "abandoned":
    case "missed":
      return "red";
    case "voicemail":
    case "transferred":
      return "yellow";
    default:
      return "neutral";
  }
}

const selectStyle: React.CSSProperties = {
  background: "var(--input, rgba(255,255,255,0.05))",
  color: "inherit",
  border: "1px solid var(--border, rgba(255,255,255,0.1))",
  borderRadius: 6,
  padding: "4px 8px",
  fontSize: 12,
};
