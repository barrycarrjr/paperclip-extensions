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

interface ActiveCall {
  callId: string;
  fromNumber: string;
  toNumber: string;
  extension?: string;
  queue?: string;
  startedAt: string;
  durationSec: number;
  direction: "inbound" | "outbound" | "internal";
}
interface ActiveCallsResponse {
  calls: ActiveCall[];
  error?: string;
}

const REFRESH_MS = 2000;

export function ActiveCallsPage(_props: PluginPageProps) {
  const host = useHostContext();
  const [tick, setTick] = useState(0);
  const { data, loading } = usePluginData<ActiveCallsResponse>(
    "phone.active-calls",
    { companyId: host.companyId, tick },
  );

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  const calls = data?.calls ?? [];

  return (
    <PageContainer>
      <PageHeader
        title="Active calls"
        subtitle={
          loading
            ? "loading…"
            : `${calls.length} on the wire · refreshes every ${REFRESH_MS / 1000}s`
        }
      />
      {data?.error ? <ErrorBanner message={data.error} /> : null}
      {!loading && !data?.error && calls.length === 0 ? (
        <EmptyState>No calls in progress.</EmptyState>
      ) : null}
      {calls.length > 0 ? (
        <Table>
          <thead>
            <tr>
              <Th>Direction</Th>
              <Th>From</Th>
              <Th>To</Th>
              <Th>Extension</Th>
              <Th>Queue</Th>
              <Th>Duration</Th>
            </tr>
          </thead>
          <tbody>
            {calls.map((c) => (
              <tr key={c.callId}>
                <Td>
                  <Badge tone={directionTone(c.direction)}>{c.direction}</Badge>
                </Td>
                <Td mono>{c.fromNumber || "—"}</Td>
                <Td mono>{c.toNumber || "—"}</Td>
                <Td mono>{c.extension ?? "—"}</Td>
                <Td mono>{c.queue ?? "—"}</Td>
                <Td mono>{formatDuration(c.durationSec)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : null}
    </PageContainer>
  );
}

function directionTone(d: "inbound" | "outbound" | "internal"): "green" | "blue" | "neutral" {
  if (d === "inbound") return "green";
  if (d === "outbound") return "blue";
  return "neutral";
}
