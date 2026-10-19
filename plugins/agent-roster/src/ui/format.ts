import type { Verdict } from "../roster.js";

/** usePluginData and usePluginAction fail with a plain `{ message }` object, not an Error. */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return String(error);
}

export function formatCost(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function daysAgo(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "Never";
  const days = Math.floor((now.getTime() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000));
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return `${days} days ago`;
}

export const VERDICT_LABELS: Record<Verdict, string> = {
  Idle: "Idle",
  "Low use": "Low use",
  "Kept on purpose": "Kept on purpose",
  Active: "Active",
  New: "New",
};

export const VERDICT_HINTS: Record<Verdict, string> = {
  Idle: "No run in 30 days.",
  "Low use": "3 runs or fewer in 30 days, and no open issues.",
  "Kept on purpose": "Idle or low use, kept on purpose by the board.",
  Active: "Runs regularly or has open issues.",
  New: "Created in the last 7 days. Not judged yet.",
};
