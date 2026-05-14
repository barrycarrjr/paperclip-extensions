import {
  useHostContext,
  usePluginData,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";

interface VisibilityResult {
  visible: boolean;
  reason: string;
}

/**
 * Sidebar entry for Campaigns. Re-uses the existing
 * `assistants.sidebar-visible` data registration — the visibility
 * gate is identical (any company in any account's allowedCompanies
 * gets the sidebar; campaigns are an extension of the assistant
 * surface, not a separate access tier).
 */
export function CampaignsSidebarItem(_props: PluginSidebarProps) {
  const host = useHostContext();
  const { data, loading } = usePluginData<VisibilityResult>("assistants.sidebar-visible", {
    companyId: host.companyId,
  });

  if (loading || !data?.visible) return null;

  const href = host.companyPrefix
    ? `/${host.companyPrefix}/campaigns`
    : `/campaigns`;

  return (
    <a
      href={href}
      className="flex items-center gap-2 rounded-md px-2 py-1 text-[13px] font-medium text-foreground hover:bg-accent/30"
      style={{ color: "inherit", textDecoration: "none" }}
    >
      <span
        aria-hidden
        style={{
          display: "inline-flex",
          width: 14,
          height: 14,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        📋
      </span>
      <span>Campaigns</span>
    </a>
  );
}
