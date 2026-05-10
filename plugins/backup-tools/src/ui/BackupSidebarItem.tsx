import {
  useHostContext,
  usePluginData,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";

interface VisibilityResult {
  visible: boolean;
}

/**
 * Sidebar entry for the Backups feature.
 *
 * Hidden when the current company isn't in `allowedCompanies` for the
 * plugin (the worker handles that determination via the `sidebar.visibility`
 * getData hook).
 */
export function BackupSidebarItem(_props: PluginSidebarProps) {
  const host = useHostContext();
  const { data, loading } = usePluginData<VisibilityResult>("sidebar.visibility", {
    companyId: host.companyId,
  });

  if (loading || !data?.visible) return null;

  const href = host.companyPrefix ? `/${host.companyPrefix}/backups` : `/backups`;

  return (
    <a
      href={href}
      className="flex items-center gap-2 rounded-md px-2 py-1 text-[13px] font-medium text-foreground hover:bg-accent/30"
      style={{ color: "inherit", textDecoration: "none" }}
    >
      <span aria-hidden style={{ display: "inline-flex", width: 14, height: 14, alignItems: "center", justifyContent: "center" }}>
        💾
      </span>
      <span>Backups</span>
    </a>
  );
}
