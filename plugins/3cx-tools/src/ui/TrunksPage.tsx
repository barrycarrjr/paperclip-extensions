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
} from "./common.js";

interface Trunk {
  id: string;
  name: string;
  provider?: string;
  registered: boolean;
  channels?: number;
  number?: string;
}
interface TrunksResponse {
  trunks: Trunk[];
  error?: string;
}

export function TrunksPage(_props: PluginPageProps) {
  const host = useHostContext();
  const { data, loading } = usePluginData<TrunksResponse>("phone.trunks", {
    companyId: host.companyId,
  });

  const trunks = data?.trunks ?? [];

  return (
    <PageContainer>
      <PageHeader
        title="SIP trunks"
        subtitle={loading ? "loading…" : `${trunks.length} configured`}
      />
      {data?.error ? <ErrorBanner message={data.error} /> : null}
      {!loading && !data?.error && trunks.length === 0 ? (
        <EmptyState>No SIP trunks configured on the PBX.</EmptyState>
      ) : null}
      {trunks.length > 0 ? (
        <Table>
          <thead>
            <tr>
              <Th>Trunk</Th>
              <Th>Provider</Th>
              <Th>DID / Number</Th>
              <Th>Status</Th>
              <Th align="right">Channels</Th>
            </tr>
          </thead>
          <tbody>
            {trunks.map((t) => (
              <tr key={t.id}>
                <Td>{t.name}</Td>
                <Td>{t.provider ?? "—"}</Td>
                <Td mono>{t.number ?? "—"}</Td>
                <Td>
                  <Badge tone={t.registered ? "green" : "red"}>
                    {t.registered ? "registered" : "unregistered"}
                  </Badge>
                </Td>
                <Td mono align="right">{t.channels ?? "—"}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : null}
    </PageContainer>
  );
}
