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
 * Phone navigation entry — replaces the v0.5.x "Recordings" top-level
 * sidebar item with a collapsible "Phone" group that nests every PBX
 * operational surface (Live / History / Directory) plus the existing
 * Recordings page. Sub-section open/closed state persists in localStorage
 * per company so the operator's preference sticks across reloads.
 *
 * AI-call surfaces (Assistants, Campaigns, Inbound routes, DNC list,
 * Audit log) are owned by the `phone-tools` plugin and surface via its
 * own sibling sidebar entry — they render right below this Phone group
 * in the rail so the two sections read as one logical telephony area.
 *
 * Visibility: only renders if the calling company is in at least one
 * 3cx-tools account's `allowedCompanies` list, same gate as the v0.5.x
 * RecordingsSidebarItem used.
 */
export function PhoneSidebarItem(_props: PluginSidebarProps) {
  const host = useHostContext();
  const { data, loading } = usePluginData<VisibilityResult>(
    "phone.sidebar-visible",
    { companyId: host.companyId },
  );

  if (loading || !data?.visible) return null;

  const prefix = host.companyPrefix ? `/${host.companyPrefix}` : "";

  return (
    <div className="flex flex-col gap-0.5">
      <SectionHeader title="📞 Phone" persistKey="phone:root" defaultOpen>
        <Subsection title="🔴 Live" persistKey="phone:live" defaultOpen>
          <NavLink href={`${prefix}/phone-active-calls`} label="Active calls" />
          <NavLink href={`${prefix}/phone-parked-calls`} label="Parked calls" />
          <NavLink href={`${prefix}/phone-queues`} label="Queues" />
          <NavLink href={`${prefix}/phone-agents`} label="Agents" />
          <NavLink href={`${prefix}/phone-wallboard`} label="Wallboard" />
        </Subsection>
        <Subsection title="📊 History" persistKey="phone:history" defaultOpen={false}>
          <NavLink href={`${prefix}/phone-call-history`} label="Call history" />
          <NavLink href={`${prefix}/recordings`} label="Recordings" />
          <NavLink href={`${prefix}/phone-daily-report`} label="Daily report" />
        </Subsection>
        <Subsection title="☎️ Directory" persistKey="phone:directory" defaultOpen={false}>
          <NavLink href={`${prefix}/phone-dids`} label="DIDs" />
          <NavLink href={`${prefix}/phone-extensions`} label="Extensions" />
          <NavLink href={`${prefix}/phone-trunks`} label="Trunks" />
        </Subsection>
      </SectionHeader>
    </div>
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
    <>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={buttonStyle}
        className="flex items-center gap-2 rounded-md px-2 py-1 text-[13px] font-medium hover:bg-accent/30"
      >
        <span style={chevronStyle(open)} aria-hidden>
          ▸
        </span>
        <span>{title}</span>
      </button>
      {open ? <div style={{ paddingLeft: 12 }}>{children}</div> : null}
    </>
  );
}

function Subsection({
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
    <>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={subsectionButtonStyle}
        className="flex items-center gap-2 rounded-md px-2 py-1 text-[12px] font-medium text-muted-foreground hover:bg-accent/20"
      >
        <span style={chevronStyle(open)} aria-hidden>
          ▸
        </span>
        <span>{title}</span>
      </button>
      {open ? <div style={{ paddingLeft: 14 }}>{children}</div> : null}
    </>
  );
}

function NavLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      style={linkStyle}
      className="flex items-center gap-2 rounded-md px-2 py-1 text-[12.5px] hover:bg-accent/30"
    >
      <span style={{ display: "inline-block", width: 12 }} aria-hidden />
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
      /* localStorage may be denied — fall back to default */
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

const subsectionButtonStyle: CSSProperties = {
  ...buttonStyle,
  opacity: 0.75,
};

const linkStyle: CSSProperties = {
  color: "inherit",
  textDecoration: "none",
};

function chevronStyle(open: boolean): CSSProperties {
  return {
    display: "inline-block",
    width: 8,
    transition: "transform 120ms ease",
    transform: open ? "rotate(90deg)" : "rotate(0deg)",
  };
}
