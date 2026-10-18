import { useHostContext, usePluginData, type PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";
import type { RosterSummary } from "../roster.js";
import { errorText, formatCost } from "./format.js";

const text = { padding: 12, fontSize: 13, color: "var(--muted-foreground)" };

export function RosterWidget(_props: PluginWidgetProps) {
  const host = useHostContext();
  const { data, loading, error } = usePluginData<{ enabled: false } | { enabled: true; summary: RosterSummary }>(
    "roster.summary",
    { companyId: host.companyId },
  );
  if (loading) return null;
  if (error) return <div role="alert" style={text}>Agent roster: {errorText(error)}</div>;
  if (!data?.enabled) return null;
  const { idleCount, lowUseCount, flaggedCostCentsLast30Days } = data.summary;
  if (idleCount + lowUseCount === 0) return null;
  const href = host.companyPrefix ? `/${host.companyPrefix}/agent-roster` : "/agent-roster";
  return (
    <a href={href} style={{ display: "block", padding: 12, color: "var(--foreground)", textDecoration: "none" }}>
      <div style={{ fontSize: 14, fontWeight: 600 }}>
        {idleCount} idle {idleCount === 1 ? "agent" : "agents"}, {lowUseCount} low use
      </div>
      <div style={{ fontSize: 13, color: "var(--muted-foreground)" }}>
        {formatCost(flaggedCostCentsLast30Days)} in the last 30 days. Review the agent roster.
      </div>
    </a>
  );
}
