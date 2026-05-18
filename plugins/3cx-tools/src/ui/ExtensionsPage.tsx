import { useState } from "react";
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

interface Extension {
  number: string;
  displayName: string;
  type: "user" | "queue" | "ringgroup" | "system";
  email?: string;
}
interface ExtensionsResponse {
  extensions: Extension[];
  error?: string;
}

export function ExtensionsPage(_props: PluginPageProps) {
  const host = useHostContext();
  const [filter, setFilter] = useState("");
  const { data, loading } = usePluginData<ExtensionsResponse>("phone.extensions", {
    companyId: host.companyId,
  });

  const all = data?.extensions ?? [];
  const q = filter.trim().toLowerCase();
  const filtered = q
    ? all.filter(
        (e) => e.number.includes(q) || e.displayName.toLowerCase().includes(q) || (e.email ?? "").toLowerCase().includes(q),
      )
    : all;

  return (
    <PageContainer>
      <PageHeader
        title="Extensions"
        subtitle={loading ? "loading…" : `${filtered.length} of ${all.length}`}
        right={
          <input
            type="search"
            placeholder="Search extension, name, email…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={inputStyle}
          />
        }
      />
      {data?.error ? <ErrorBanner message={data.error} /> : null}
      {!loading && !data?.error && filtered.length === 0 ? (
        <EmptyState>No extensions match.</EmptyState>
      ) : null}
      {filtered.length > 0 ? (
        <Table>
          <thead>
            <tr>
              <Th>Number</Th>
              <Th>Name</Th>
              <Th>Type</Th>
              <Th>Email</Th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((e) => (
              <tr key={`${e.type}-${e.number}`}>
                <Td mono>{e.number}</Td>
                <Td>{e.displayName}</Td>
                <Td>
                  <Badge tone={typeTone(e.type)}>{e.type}</Badge>
                </Td>
                <Td mono>{e.email ?? "—"}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : null}
    </PageContainer>
  );
}

function typeTone(t: "user" | "queue" | "ringgroup" | "system"): "green" | "blue" | "yellow" | "neutral" {
  switch (t) {
    case "user":
      return "green";
    case "queue":
      return "blue";
    case "ringgroup":
      return "yellow";
    case "system":
    default:
      return "neutral";
  }
}

const inputStyle: React.CSSProperties = {
  background: "var(--input, rgba(255,255,255,0.05))",
  color: "inherit",
  border: "1px solid var(--border, rgba(255,255,255,0.1))",
  borderRadius: 6,
  padding: "4px 10px",
  fontSize: 12,
  width: 260,
};
