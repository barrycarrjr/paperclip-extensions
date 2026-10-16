import { useHostContext, usePluginData, type PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";

export function HandOffSidebarItem(_props: PluginSidebarProps) {
  const host = useHostContext();
  const { data, loading, error } = usePluginData<{ visible: boolean }>("handoff.sidebar-visible", { companyId: host.companyId });
  if (!host.companyId || loading) return null;
  if (error) return <span role="status" style={{ color: "var(--muted-foreground)", fontSize: 12 }}>Hand-off unavailable</span>;
  if (!data?.visible) return null;
  const href = host.companyPrefix ? `/${host.companyPrefix}/hand-off` : "/hand-off";
  return <a href={href} style={{ display: "block", padding: "4px 8px", borderRadius: 6, color: "var(--foreground)", textDecoration: "none", fontSize: 13 }}>Hand-off</a>;
}
