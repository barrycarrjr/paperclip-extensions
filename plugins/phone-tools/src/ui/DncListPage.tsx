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
  formatTimestamp,
} from "./common.js";

interface DncEntry {
  phoneE164: string;
  addedAt: string;
  addedBy?: string;
  reason?: string;
}
interface DncListResponse {
  entries: DncEntry[];
  totalCount: number;
  federalCacheStatus?: {
    sourceUrl: string;
    refreshedAt: string;
    count: number;
    stale: boolean;
  } | null;
  error?: string;
}

/**
 * DNC (Do Not Call) list page. Two surfaces:
 *  1. Account-local DNC: numbers added by the AI or operator that get
 *     refused on every outbound campaign dial. Always-on.
 *  2. Federal DNC cache: populated from the configured federalDncListUrl
 *     on the account, with refresh status + last-refreshed timestamp.
 *
 * Filtering: searchable by digits. Adding entries lives on a v0.6.x
 * mutation API; today the "+ Add" button surfaces a TODO note pointing
 * to the agent tool (`phone_dnc_add`).
 */
export function DncListPage(_props: PluginPageProps) {
  const host = useHostContext();
  const [filter, setFilter] = useState("");
  const [tick, setTick] = useState(0);

  const { data, loading } = usePluginData<DncListResponse>("phone.dnc-list", {
    companyId: host.companyId,
    tick,
  });

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(id);
  }, []);

  const all = data?.entries ?? [];
  const q = filter.trim().replace(/\D/g, "");
  const filtered = q ? all.filter((e) => e.phoneE164.replace(/\D/g, "").includes(q)) : all;

  return (
    <PageContainer>
      <PageHeader
        title="DNC list"
        subtitle={
          loading
            ? "loading…"
            : `${filtered.length} of ${data?.totalCount ?? all.length} entries`
        }
        right={
          <input
            type="search"
            placeholder="Search by digits…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={inputStyle}
          />
        }
      />
      {data?.error ? <ErrorBanner message={data.error} /> : null}

      {data?.federalCacheStatus ? (
        <div style={cacheBoxStyle}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
            <strong>Federal DNC cache:</strong>
            <Badge tone={data.federalCacheStatus.stale ? "yellow" : "green"}>
              {data.federalCacheStatus.stale ? "stale" : "fresh"}
            </Badge>
            <span style={{ fontSize: 12, opacity: 0.7 }}>
              {data.federalCacheStatus.count.toLocaleString()} entries · refreshed{" "}
              {formatTimestamp(data.federalCacheStatus.refreshedAt)}
            </span>
          </div>
          <div style={{ fontSize: 11, opacity: 0.55, marginTop: 4, fontFamily: "ui-monospace, monospace" }}>
            {data.federalCacheStatus.sourceUrl}
          </div>
        </div>
      ) : (
        <div style={cacheBoxNeutralStyle}>
          No federal DNC URL configured for this account. Add one in the
          plugin settings to cross-check campaign dials against the FTC
          registry (or any list).
        </div>
      )}

      {!loading && !data?.error && all.length === 0 ? (
        <EmptyState>No account-local DNC entries.</EmptyState>
      ) : null}
      {filtered.length > 0 ? (
        <Table>
          <thead>
            <tr>
              <Th>Number</Th>
              <Th>Added</Th>
              <Th>By</Th>
              <Th>Reason</Th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((e) => (
              <tr key={e.phoneE164}>
                <Td mono>{e.phoneE164}</Td>
                <Td mono>{formatTimestamp(e.addedAt)}</Td>
                <Td>{e.addedBy ?? "—"}</Td>
                <Td>{e.reason ?? "—"}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : null}

      <div style={addHintStyle}>
        Add / remove entries via the agent tools{" "}
        <code>phone_dnc_add</code> and <code>phone_dnc_remove</code>. A
        UI mutation surface lands with the v0.6.x DNC slice.
      </div>
    </PageContainer>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--input, rgba(255,255,255,0.05))",
  color: "inherit",
  border: "1px solid var(--border, rgba(255,255,255,0.1))",
  borderRadius: 6,
  padding: "4px 10px",
  fontSize: 12,
  width: 240,
};
const cacheBoxStyle: React.CSSProperties = {
  padding: "12px 14px",
  background: "rgba(80, 180, 100, 0.08)",
  border: "1px solid rgba(80, 180, 100, 0.25)",
  borderRadius: 6,
  marginBottom: 16,
  fontSize: 13,
};
const cacheBoxNeutralStyle: React.CSSProperties = {
  padding: "12px 14px",
  background: "rgba(255,255,255,0.04)",
  border: "1px solid var(--border, rgba(255,255,255,0.08))",
  borderRadius: 6,
  marginBottom: 16,
  fontSize: 12,
  opacity: 0.75,
};
const addHintStyle: React.CSSProperties = {
  marginTop: 24,
  padding: 14,
  background: "rgba(80, 140, 220, 0.08)",
  border: "1px solid rgba(80, 140, 220, 0.25)",
  borderRadius: 6,
  fontSize: 12,
  opacity: 0.85,
};
