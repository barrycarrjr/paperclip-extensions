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
  Table,
  Td,
  Th,
} from "./common.js";

interface Did {
  e164: string;
  label?: string;
  routedTo?: string;
  queue?: string;
}
interface DidsResponse {
  dids: Did[];
  error?: string;
}

export function DidsPage(_props: PluginPageProps) {
  const host = useHostContext();
  const { data, loading } = usePluginData<DidsResponse>("phone.dids", {
    companyId: host.companyId,
  });

  const dids = data?.dids ?? [];

  return (
    <PageContainer>
      <PageHeader
        title="DIDs (inbound numbers)"
        subtitle={loading ? "loading…" : `${dids.length} in scope`}
      />
      {data?.error ? <ErrorBanner message={data.error} /> : null}
      {!loading && !data?.error && dids.length === 0 ? (
        <EmptyState>No DIDs in the calling company's scope.</EmptyState>
      ) : null}
      {dids.length > 0 ? (
        <Table>
          <thead>
            <tr>
              <Th>Number</Th>
              <Th>Label</Th>
              <Th>Routed to</Th>
              <Th>Queue</Th>
            </tr>
          </thead>
          <tbody>
            {dids.map((d) => (
              <tr key={d.e164}>
                <Td mono>{d.e164}</Td>
                <Td>{d.label ?? "—"}</Td>
                <Td mono>{d.routedTo ?? "—"}</Td>
                <Td mono>{d.queue ?? "—"}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : null}
    </PageContainer>
  );
}
