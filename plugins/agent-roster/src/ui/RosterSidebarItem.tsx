import { useHostContext, usePluginData, type PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";

export function RosterSidebarItem(_props: PluginSidebarProps) {
  const host = useHostContext();
  const { data, loading, error } = usePluginData<{ visible: boolean }>("roster.sidebar-visible", { companyId: host.companyId });
  if (!host.companyId || loading) return null;
  if (error) return <span role="status" style={{ color: "var(--muted-foreground)", fontSize: 12 }}>Agent roster unavailable</span>;
  if (!data?.visible) return null;
  const href = host.companyPrefix ? `/${host.companyPrefix}/agent-roster` : "/agent-roster";
  return <a href={href} style={{ display: "block", padding: "4px 8px", borderRadius: 6, color: "var(--foreground)", textDecoration: "none", fontSize: 13 }}>Agent roster</a>;
}
