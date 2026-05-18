import { useMemo, useState } from "react";
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

interface AuditEntry {
  at: string;
  decision: string;
  phoneE164: string;
  campaignId?: string;
  callId?: string;
  actor?: string;
  note?: string;
}
interface AuditLogResponse {
  entries: AuditEntry[];
  error?: string;
}

type Preset = "today" | "yesterday" | "7d" | "30d";

/**
 * Campaign audit log page. Every dial decision the runner makes (dialed
 * / skipped-account-dnc / skipped-federal-dnc / skipped-out-of-hours /
 * etc.) is recorded — the page lists them with filters + download.
 *
 * Download mirrors the existing CSV export endpoint
 * (`/api/plugins/phone-tools/api/audit?format=csv`) so the regulatory
 * evidence trail is one click away.
 */
export function AuditLogPage(_props: PluginPageProps) {
  const host = useHostContext();
  const [preset, setPreset] = useState<Preset>("today");
  const [decisionFilter, setDecisionFilter] = useState("");
  const since = useMemo(() => isoSince(preset), [preset]);

  const { data, loading } = usePluginData<AuditLogResponse>("phone.audit-log", {
    companyId: host.companyId,
    since,
  });

  const all = data?.entries ?? [];
  const filtered = decisionFilter
    ? all.filter((e) => e.decision === decisionFilter)
    : all;

  const decisions = useMemo(() => {
    const set = new Set<string>();
    all.forEach((e) => set.add(e.decision));
    return Array.from(set).sort();
  }, [all]);

  const downloadHref = host.companyPrefix
    ? `/api/plugins/phone-tools/api/audit?companyId=${host.companyId}&since=${encodeURIComponent(since)}&format=csv`
    : `/api/plugins/phone-tools/api/audit?companyId=${host.companyId}&since=${encodeURIComponent(since)}&format=csv`;

  return (
    <PageContainer>
      <PageHeader
        title="Audit log"
        subtitle={loading ? "loading…" : `${filtered.length} of ${all.length} entries`}
        right={
          <div style={{ display: "flex", gap: 8 }}>
            <select value={preset} onChange={(e) => setPreset(e.target.value as Preset)} style={selectStyle}>
              <option value="today">Today</option>
              <option value="yesterday">Yesterday</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
            </select>
            <select
              value={decisionFilter}
              onChange={(e) => setDecisionFilter(e.target.value)}
              style={selectStyle}
            >
              <option value="">All decisions</option>
              {decisions.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <a href={downloadHref} download style={downloadStyle}>
              ↓ CSV
            </a>
          </div>
        }
      />
      {data?.error ? <ErrorBanner message={data.error} /> : null}
      {!loading && !data?.error && filtered.length === 0 ? (
        <EmptyState>
          No audit entries in this range. The audit log populates as
          campaigns run; if a campaign placed calls but you see nothing
          here, check the date range or the plugin state TTL (30 days
          default).
        </EmptyState>
      ) : null}
      {filtered.length > 0 ? (
        <Table>
          <thead>
            <tr>
              <Th>When</Th>
              <Th>Decision</Th>
              <Th>Phone</Th>
              <Th>Campaign</Th>
              <Th>Call</Th>
              <Th>Actor</Th>
              <Th>Note</Th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((e, i) => (
              <tr key={`${e.at}-${e.phoneE164}-${i}`}>
                <Td mono>{formatTimestamp(e.at)}</Td>
                <Td>
                  <Badge tone={decisionTone(e.decision)}>{e.decision}</Badge>
                </Td>
                <Td mono>{e.phoneE164}</Td>
                <Td mono>{e.campaignId ?? "—"}</Td>
                <Td mono>{e.callId ?? "—"}</Td>
                <Td>{e.actor ?? "—"}</Td>
                <Td>{e.note ?? "—"}</Td>
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

function decisionTone(d: string): "green" | "yellow" | "red" | "neutral" {
  if (d === "dialed") return "green";
  if (d.startsWith("skipped-")) return "yellow";
  if (d === "failed" || d === "rejected") return "red";
  return "neutral";
}

const selectStyle: React.CSSProperties = {
  background: "var(--input, rgba(255,255,255,0.05))",
  color: "inherit",
  border: "1px solid var(--border, rgba(255,255,255,0.1))",
  borderRadius: 6,
  padding: "4px 8px",
  fontSize: 12,
};
const downloadStyle: React.CSSProperties = {
  background: "var(--input, rgba(255,255,255,0.05))",
  color: "inherit",
  border: "1px solid var(--border, rgba(255,255,255,0.1))",
  borderRadius: 6,
  padding: "4px 10px",
  fontSize: 12,
  textDecoration: "none",
  fontWeight: 600,
};
