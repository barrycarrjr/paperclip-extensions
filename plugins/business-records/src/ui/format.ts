/**
 * Display rules for the page, kept free of React so they can be unit tested.
 */
import type { FilingApi, StatusSource } from "../domain.js";

export const RENEWAL_WINDOW_DAYS = 60;

export function humanize(value: string | null | undefined): string {
  if (!value) return "";
  const text = value.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Whole days from `today` to `date` (negative when `date` is past). Both YYYY-MM-DD. */
export function daysUntil(date: string, today: string): number {
  const a = Date.parse(`${today}T00:00:00Z`);
  const b = Date.parse(`${date}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** How to highlight a renewal date: lapsed, due within the window, or not at all. */
export function renewalTone(renewalDate: string | null, today: string): "bad" | "warn" | null {
  if (!renewalDate) return null;
  const days = daysUntil(renewalDate, today);
  if (days < 0) return "bad";
  if (days <= RENEWAL_WINDOW_DAYS) return "warn";
  return null;
}

export function isFilingOpen(f: Pick<FilingApi, "status">): boolean {
  return f.status !== "filed" && f.status !== "accepted" && f.status !== "not_required";
}

export function isFilingOverdue(f: Pick<FilingApi, "status" | "effectiveDueDate">, today: string): boolean {
  return isFilingOpen(f) && f.effectiveDueDate < today;
}

/** Next due first; ties by name. Returns a new array. */
export function sortFilingsByDue<T extends Pick<FilingApi, "effectiveDueDate" | "filing">>(filings: T[]): T[] {
  return [...filings].sort((a, b) =>
    a.effectiveDueDate === b.effectiveDueDate
      ? a.filing.localeCompare(b.filing)
      : a.effectiveDueDate < b.effectiveDueDate
        ? -1
        : 1,
  );
}

/** One line describing where a status came from, naming the document when it is known. */
export function describeSource(source: StatusSource | null, docTitles: Record<string, string>): string {
  if (!source) return "no source recorded";
  const parts = [humanize(source.kind)];
  if (source.documentId) parts.push(docTitles[source.documentId] ? `"${docTitles[source.documentId]}"` : `document ${source.documentId.slice(0, 8)}`);
  if (source.url) parts.push(source.url);
  if (source.note) parts.push(source.note);
  return parts.join(", ");
}
