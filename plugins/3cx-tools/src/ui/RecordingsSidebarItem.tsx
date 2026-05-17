import {
  useHostContext,
  usePluginData,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";

interface VisibilityResult {
  visible: boolean;
}

/**
 * Sidebar entry for call recordings. Visible only for companies that
 * appear in at least one 3cx-tools account's `allowedCompanies` list,
 * so it stays out of the way for companies without PBX access.
 */
export function RecordingsSidebarItem(_props: PluginSidebarProps) {
  const host = useHostContext();
  const { data, loading } = usePluginData<VisibilityResult>(
    "recordings.sidebar-visible",
    { companyId: host.companyId },
  );

  if (loading || !data?.visible) return null;

  const href = host.companyPrefix
    ? `/${host.companyPrefix}/recordings`
    : `/recordings`;

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
        🎙️
      </span>
      <span>Recordings</span>
    </a>
  );
}
