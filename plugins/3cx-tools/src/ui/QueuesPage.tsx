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

interface Queue {
  id: string;
  name: string;
  extension: string;
  agentsOn: number;
  depth: number;
  longestWaitSec: number;
}
interface QueuesResponse {
  queues: Queue[];
  error?: string;
}

const REFRESH_MS = 3000;

export function QueuesPage(_props: PluginPageProps) {
  const host = useHostContext();
  const [tick, setTick] = useState(0);
  const { data, loading } = usePluginData<QueuesResponse>(
    "phone.queues",
    { companyId: host.companyId, tick },
  );
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  const queues = data?.queues ?? [];

  return (
    <PageContainer>
      <PageHeader
        title="Queues"
        subtitle={
          loading
            ? "loading…"
            : `${queues.length} configured · refreshes every ${REFRESH_MS / 1000}s`
        }
      />
      {data?.error ? <ErrorBanner message={data.error} /> : null}
      {!loading && !data?.error && queues.length === 0 ? (
        <EmptyState>No queues visible in the calling company's scope.</EmptyState>
      ) : null}
      {queues.length > 0 ? (
        <Table>
          <thead>
            <tr>
              <Th>Queue</Th>
              <Th>Extension</Th>
              <Th align="right">Depth</Th>
              <Th align="right">Longest wait</Th>
              <Th align="right">Agents on</Th>
            </tr>
          </thead>
          <tbody>
            {queues.map((q) => (
              <tr key={q.id}>
                <Td>{q.name}</Td>
                <Td mono>{q.extension}</Td>
                <Td mono align="right">
                  <Badge tone={depthTone(q.depth)}>{q.depth}</Badge>
                </Td>
                <Td mono align="right">{formatDuration(q.longestWaitSec)}</Td>
                <Td mono align="right">{q.agentsOn}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : null}
    </PageContainer>
  );
}

function depthTone(d: number): "green" | "yellow" | "red" {
  if (d >= 5) return "red";
  if (d >= 2) return "yellow";
  return "green";
}
