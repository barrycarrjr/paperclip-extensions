/**
 * Styles and two small pieces shared by the Reviews page.
 *
 * Every colour is a host CSS variable with a fallback, so the page follows
 * the light and dark themes rather than painting fixed surfaces (the v0.1.7
 * dark-mode bug was exactly a fixed near-white card).
 */
import type { CSSProperties, ReactNode } from "react";

export const css = {
  fg: "var(--foreground, #111827)",
  muted: "var(--muted-foreground, #6b7280)",
  border: "1px solid var(--border, #e5e7eb)",
  card: "var(--card, #f9fafb)",
  background: "var(--background, #ffffff)",
  danger: "var(--destructive, #b91c1c)",
} as const;

export const cardStyle: CSSProperties = {
  border: css.border,
  background: css.card,
  color: "var(--card-foreground, inherit)",
  padding: 16,
  borderRadius: 8,
};

export const mutedText: CSSProperties = { color: css.muted, fontSize: 13 };

export const primaryButton: CSSProperties = {
  padding: "8px 14px",
  background: "var(--primary, #111827)",
  color: "var(--primary-foreground, #ffffff)",
  border: "none",
  borderRadius: 4,
  fontSize: 13,
  cursor: "pointer",
};

export const secondaryButton: CSSProperties = {
  padding: "8px 14px",
  background: "transparent",
  color: css.fg,
  border: css.border,
  borderRadius: 4,
  fontSize: 13,
  cursor: "pointer",
};

export const linkButton: CSSProperties = {
  appearance: "none",
  border: "none",
  background: "transparent",
  color: "inherit",
  padding: 0,
  fontSize: 14,
  cursor: "pointer",
  fontWeight: 600,
};

export function disabledStyle(base: CSSProperties, disabled: boolean): CSSProperties {
  return disabled ? { ...base, opacity: 0.5, cursor: "not-allowed" } : base;
}

/**
 * The bordered box under the control that failed. It stays until the next
 * attempt, because the person has to act on it; a toast would be gone.
 */
export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      style={{
        marginTop: 8,
        padding: "10px 14px",
        background: "color-mix(in oklab, var(--destructive, #b91c1c) 12%, var(--background, #fef2f2))",
        border: "1px solid color-mix(in oklab, var(--destructive, #b91c1c) 40%, transparent)",
        color: css.fg,
        borderRadius: 6,
        fontSize: 13,
      }}
    >
      {children}
    </div>
  );
}

/** A plain sentence in place of a control the page cannot honestly offer. */
export function Note({ children }: { children: ReactNode }) {
  return (
    <p
      style={{
        margin: "8px 0 0",
        padding: "10px 14px",
        border: css.border,
        borderRadius: 6,
        background: css.background,
        color: css.fg,
        fontSize: 13,
      }}
    >
      {children}
    </p>
  );
}

/** Five stars, filled to the rating, with the number for screen readers. */
export function Stars({ rating }: { rating: number }) {
  const n = Math.max(0, Math.min(5, Math.round(rating)));
  return (
    <span aria-label={`${n} out of 5 stars`} title={`${n} out of 5`} style={{ color: "#f59e0b", letterSpacing: 1 }}>
      {"★".repeat(n)}
      <span style={{ color: css.muted }}>{"☆".repeat(5 - n)}</span>
    </span>
  );
}
