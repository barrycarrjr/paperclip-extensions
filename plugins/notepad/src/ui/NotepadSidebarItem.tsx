import {
  useHostContext,
  usePluginData,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";

interface VisibilityResult {
  visible: boolean;
  reason: string;
}

export function NotepadSidebarItem(_props: PluginSidebarProps) {
  const host = useHostContext();
  const { data, loading } = usePluginData<VisibilityResult>(
    "notepad.sidebar-visible",
    { companyId: host.companyId },
  );

  if (loading || !data?.visible) return null;

  const href = host.companyPrefix
    ? `/${host.companyPrefix}/notepad`
    : "/notepad";

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
        📝
      </span>
      <span>Notepad</span>
    </a>
  );
}
