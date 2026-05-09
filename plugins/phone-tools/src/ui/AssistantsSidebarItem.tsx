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
 * Sidebar entry for the Assistants feature.
 *
 * Hidden when:
 *   - There is no current company.
 *   - The plugin has no accounts configured.
 *   - The current company is not in any account's `allowedCompanies` list.
 *
 * Phase A: relies on the worker's `assistants.sidebar-visible` getData
 * handler to tell us whether to render. This is what enforces the
 * per-company visibility rule from the plan §2 sidebar visibility.
 */
export function AssistantsSidebarItem(_props: PluginSidebarProps) {
  const host = useHostContext();
  const { data, loading } = usePluginData<VisibilityResult>("assistants.sidebar-visible", {
    companyId: host.companyId,
  });

  if (loading || !data?.visible) return null;

  const href = host.companyPrefix
    ? `/${host.companyPrefix.toLowerCase()}/assistants`
    : `/assistants`;

  return (
    <a
      href={href}
      className="flex items-center gap-2 rounded-md px-2 py-1 text-[13px] font-medium text-foreground hover:bg-accent/30"
      style={{ color: "inherit", textDecoration: "none" }}
    >
      <span aria-hidden style={{ display: "inline-flex", width: 14, height: 14, alignItems: "center", justifyContent: "center" }}>
        🤖
      </span>
      <span>Assistants</span>
    </a>
  );
}
