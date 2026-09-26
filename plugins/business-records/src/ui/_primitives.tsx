/**
 * Small styled primitives using the host's Tailwind classes, same approach as
 * the notepad plugin. Plugins cannot import the host's component library, so
 * the few pieces the page needs are defined here.
 *
 * Only classes Paperclip's own UI already uses will work here: the plugin
 * bundle is not run through Tailwind, so an arbitrary value the host never
 * emits (for example a one-off grid template) silently does nothing. Check a
 * new class against the live stylesheet before relying on it.
 */
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

export function cn(...parts: Array<string | undefined | false | null>): string {
  return parts.filter(Boolean).join(" ");
}

type ButtonVariant = "default" | "outline" | "ghost";
type ButtonSize = "default" | "sm" | "xs";

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 outline-none focus-visible:ring-ring focus-visible:ring-[3px]";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  default: "bg-primary text-primary-foreground hover:bg-primary/90",
  outline:
    "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50",
  ghost: "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
};

const BUTTON_SIZE: Record<ButtonSize, string> = {
  default: "h-9 px-4 py-2",
  sm: "h-8 rounded-md px-3",
  xs: "h-6 px-2 text-xs",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({ variant = "default", size = "default", className, type = "button", ...props }: ButtonProps) {
  return <button type={type} className={cn(BUTTON_BASE, BUTTON_VARIANT[variant], BUTTON_SIZE[size], className)} {...props} />;
}

const INPUT_CLASS =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-ring focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(INPUT_CLASS, className)} {...props} />;
}

/** A bordered card with a small heading, used for each part of the business page. */
export function Section({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card shadow-sm">
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
        <h3 className="text-sm font-semibold text-foreground">
          {title}
          {typeof count === "number" && <span className="ml-2 text-xs font-normal text-muted-foreground tabular-nums">{count}</span>}
        </h3>
        {action}
      </header>
      <div className="px-4 py-3 text-sm text-foreground">{children}</div>
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

/** A calm, centred message for a part of the page that has nothing to show yet. */
export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      {children && <div className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">{children}</div>}
    </div>
  );
}

export function ErrorBanner({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-start justify-between gap-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300"
    >
      <span>{message}</span>
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="text-xs underline">
          Dismiss
        </button>
      )}
    </div>
  );
}

export type BadgeTone = "neutral" | "good" | "warn" | "bad";

const BADGE_TONE: Record<BadgeTone, string> = {
  neutral: "bg-muted text-muted-foreground",
  good: "bg-green-500/15 text-green-700 dark:text-green-300",
  warn: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  bad: "bg-red-500/15 text-red-700 dark:text-red-300",
};

export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap", BADGE_TONE[tone])}>
      {children}
    </span>
  );
}

const DOT_TONE: Record<"good" | "warn" | "neutral" | "unknown" | "bad", string> = {
  good: "bg-green-500",
  warn: "bg-amber-500",
  bad: "bg-red-500",
  neutral: "bg-muted-foreground",
  unknown: "bg-muted-foreground opacity-60",
};

/** A small status dot, like the agent status dots elsewhere in Paperclip. */
export function Dot({ tone, label }: { tone: keyof typeof DOT_TONE; label?: string }) {
  return <span aria-label={label} title={label} className={cn("inline-block size-2 shrink-0 rounded-full", DOT_TONE[tone])} />;
}
