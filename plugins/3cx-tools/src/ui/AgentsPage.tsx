import { useEffect, useState } from "react";
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
} from "./common.js";

type Presence = "available" | "busy" | "away" | "dnd" | "offline";
interface Agent {
  extension: string;
  name: string;
  presence: Presence;
  inCall: boolean;
  currentCallSec?: number;
  queueMemberships: string[];
}
interface AgentsResponse {
  agents: Agent[];
  error?: string;
}

const REFRESH_MS = 5000;

export function AgentsPage(_props: PluginPageProps) {
  const host = useHostContext();
  const [tick, setTick] = useState(0);
  const [filter, setFilter] = useState<"" | Presence>("");

  const { data, loading } = usePluginData<AgentsResponse>(
    "phone.agents",
    { companyId: host.companyId, tick },
  );
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  const all = data?.agents ?? [];
  const filtered = filter ? all.filter((a) => a.presence === filter) : all;

  return (
    <PageContainer>
      <PageHeader
        title="Agents"
        subtitle={
          loading
            ? "loading…"
            : `${filtered.length} shown of ${all.length} · refreshes every ${REFRESH_MS / 1000}s`
        }
        right={
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as "" | Presence)}
            style={selectStyle}
          >
            <option value="">All presences</option>
            <option value="available">Available</option>
            <option value="busy">Busy / in call</option>
            <option value="away">Away</option>
            <option value="dnd">DND</option>
            <option value="offline">Offline</option>
          </select>
        }
      />
      {data?.error ? <ErrorBanner message={data.error} /> : null}
      {!loading && !data?.error && filtered.length === 0 ? (
        <EmptyState>No agents match the current filter.</EmptyState>
      ) : null}
      {filtered.length > 0 ? (
        <Table>
          <thead>
            <tr>
              <Th>Ext.</Th>
              <Th>Name</Th>
              <Th>Presence</Th>
              <Th>On call</Th>
              <Th align="right">In call for</Th>
              <Th>Queues</Th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((a) => (
              <tr key={a.extension}>
                <Td mono>{a.extension}</Td>
                <Td>{a.name}</Td>
                <Td>
                  <Badge tone={presenceTone(a.presence)}>{a.presence}</Badge>
                </Td>
                <Td>{a.inCall ? "yes" : "—"}</Td>
                <Td mono align="right">{formatDuration(a.currentCallSec)}</Td>
                <Td mono>{a.queueMemberships.length === 0 ? "—" : a.queueMemberships.join(", ")}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : null}
    </PageContainer>
  );
}

function presenceTone(p: Presence): "green" | "yellow" | "red" | "blue" | "neutral" {
  switch (p) {
    case "available":
      return "green";
    case "busy":
      return "yellow";
    case "away":
      return "blue";
    case "dnd":
      return "red";
    case "offline":
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
