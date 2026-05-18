/**
 * Shared layout primitives for phone-tools' Phone-section pages. Mirrors
 * the 3cx-tools `ui/common.tsx` module so both plugins' new pages have
 * consistent table / header / badge affordances. Kept separate per
 * plugin (no cross-plugin imports — each bundle is independent).
 */
import type { CSSProperties, ReactNode } from "react";

export function PageHeader({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
}) {
  return (
    <header
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 12,
        marginBottom: 16,
        flexWrap: "wrap",
      }}
    >
      <h1 style={{ fontSize: 20, margin: 0, fontWeight: 600 }}>{title}</h1>
      {subtitle ? (
        <span style={{ fontSize: 12, opacity: 0.6 }}>{subtitle}</span>
      ) : null}
      {right ? <div style={{ marginLeft: "auto" }}>{right}</div> : null}
    </header>
  );
}

export function PageContainer({ children }: { children: ReactNode }) {
  return <div style={{ padding: 16, color: "var(--foreground)" }}>{children}</div>;
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      style={{
        padding: "12px 16px",
        background: "rgba(220, 80, 80, 0.12)",
        border: "1px solid rgba(220, 80, 80, 0.35)",
        color: "rgb(255, 180, 180)",
        borderRadius: 6,
        fontSize: 13,
        marginBottom: 16,
      }}
    >
      Error: {message}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: "32px 16px",
        textAlign: "center",
        opacity: 0.55,
        fontSize: 13,
      }}
    >
      {children}
    </div>
  );
}

export function Table({ children }: { children: ReactNode }) {
  return (
    <table
      style={{
        width: "100%",
        borderCollapse: "collapse",
        background: "var(--card, rgba(255,255,255,0.02))",
        borderRadius: 6,
        overflow: "hidden",
      }}
    >
      {children}
    </table>
  );
}

export function Th({ children, align }: { children: ReactNode; align?: "left" | "right" }) {
  return (
    <th
      style={{
        textAlign: align ?? "left",
        padding: "8px 12px",
        fontSize: 11,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: 0.5,
        opacity: 0.65,
        borderBottom: "1px solid var(--border, rgba(255,255,255,0.1))",
      }}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  mono = false,
  align,
}: {
  children: ReactNode;
  mono?: boolean;
  align?: "left" | "right";
}) {
  return (
    <td
      style={{
        padding: "10px 12px",
        fontSize: 13,
        textAlign: align ?? "left",
        fontFamily: mono ? "ui-monospace, SFMono-Regular, monospace" : undefined,
        borderBottom: "1px solid var(--border, rgba(255,255,255,0.06))",
      }}
    >
      {children}
    </td>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "green" | "yellow" | "red" | "blue" | "neutral";
}) {
  return <span style={{ ...badgeBase, ...toneStyles[tone] }}>{children}</span>;
}

const badgeBase: CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 4,
  fontFamily: "ui-monospace, SFMono-Regular, monospace",
  fontSize: 12,
  fontWeight: 600,
};

const toneStyles: Record<string, CSSProperties> = {
  green: { background: "rgba(80, 180, 100, 0.18)", color: "rgb(140, 230, 160)" },
  yellow: { background: "rgba(220, 180, 60, 0.18)", color: "rgb(245, 215, 130)" },
  red: { background: "rgba(220, 80, 80, 0.18)", color: "rgb(255, 180, 180)" },
  blue: { background: "rgba(80, 140, 220, 0.18)", color: "rgb(160, 200, 250)" },
  neutral: { background: "rgba(255,255,255,0.08)", color: "rgb(220,220,220)" },
};

export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}
