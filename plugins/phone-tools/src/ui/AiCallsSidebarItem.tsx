import { useState, useEffect, type CSSProperties } from "react";
import {
  useHostContext,
  usePluginData,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";

interface VisibilityResult {
  visible: boolean;
}

/**
 * "AI Calls" navigation entry — replaces the v0.5.x standalone
 * Assistants + Campaigns sidebar items with one collapsible group that
 * holds every AI-call surface owned by `phone-tools`: Assistants,
 * Campaigns, Inbound routes (v0.6.x), DNC list (v0.6.x), Audit log
 * (v0.6.x).
 *
 * Sibling of the `3cx-tools` Phone group — rendered side-by-side in the
 * sidebar rail so the two groups read together as the operator's
 * complete telephony surface.
 *
 * Visibility gate is the same `assistants.sidebar-visible` channel the
 * old sidebar items used; renders only if the company has access to at
 * least one phone-tools account.
 */
export function AiCallsSidebarItem(_props: PluginSidebarProps) {
  const host = useHostContext();
  const { data, loading } = usePluginData<VisibilityResult>(
    "assistants.sidebar-visible",
    { companyId: host.companyId },
  );

  if (loading || !data?.visible) return null;

  const prefix = host.companyPrefix ? `/${host.companyPrefix}` : "";

  return (
    <SectionHeader title="🎙️ AI Calls" persistKey="ai-calls:root" defaultOpen>
      <NavLink href={`${prefix}/assistants`} label="Assistants" icon="🤖" />
      <NavLink href={`${prefix}/campaigns`} label="Campaigns" icon="📋" />
      <NavLink href={`${prefix}/phone-inbound-routes`} label="Inbound routes" icon="📥" />
      <NavLink href={`${prefix}/phone-dnc`} label="DNC list" icon="🚫" />
      <NavLink href={`${prefix}/phone-audit-log`} label="Audit log" icon="📜" />
    </SectionHeader>
  );
}

function SectionHeader({
  title,
  persistKey,
  defaultOpen,
  children,
}: {
  title: string;
  persistKey: string;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = usePersistedToggle(persistKey, defaultOpen);
  return (
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={buttonStyle}
        className="flex items-center gap-2 rounded-md px-2 py-1 text-[13px] font-medium hover:bg-accent/30"
      >
        <span style={chevronStyle(open)} aria-hidden>▸</span>
        <span>{title}</span>
      </button>
      {open ? <div style={{ paddingLeft: 12 }}>{children}</div> : null}
    </div>
  );
}

function NavLink({ href, label, icon }: { href: string; label: string; icon: string }) {
  return (
    <a
      href={href}
      style={linkStyle}
      className="flex items-center gap-2 rounded-md px-2 py-1 text-[12.5px] hover:bg-accent/30"
    >
      <span style={{ display: "inline-block", width: 14 }} aria-hidden>{icon}</span>
      <span>{label}</span>
    </a>
  );
}

function usePersistedToggle(key: string, defaultOpen: boolean): [boolean, (open: boolean) => void] {
  const fullKey = `pc:phone-nav:${key}`;
  const [open, setOpen] = useState<boolean>(defaultOpen);
  useEffect(() => {
    try {
      const v = localStorage.getItem(fullKey);
      if (v === "1") setOpen(true);
      else if (v === "0") setOpen(false);
    } catch {
      /* localStorage may be denied */
    }
  }, [fullKey]);
  function update(next: boolean): void {
    setOpen(next);
    try {
      localStorage.setItem(fullKey, next ? "1" : "0");
    } catch {
      /* noop */
    }
  }
  return [open, update];
}

const buttonStyle: CSSProperties = {
  background: "transparent",
  border: 0,
  color: "inherit",
  cursor: "pointer",
  textAlign: "left",
  width: "100%",
};
const linkStyle: CSSProperties = { color: "inherit", textDecoration: "none" };
function chevronStyle(open: boolean): CSSProperties {
  return {
    display: "inline-block",
    width: 8,
    transition: "transform 120ms ease",
    transform: open ? "rotate(90deg)" : "rotate(0deg)",
  };
}
