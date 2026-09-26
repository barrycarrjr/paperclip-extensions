/**
 * Display rules for the page, kept free of React so they can be unit tested.
 */
import type { BusinessApi, FilingApi, HistoryApi, StatusField, StatusSource } from "../domain.js";

export const RENEWAL_WINDOW_DAYS = 60;
/** A filing due within this many days is highlighted as coming up. */
export const DUE_SOON_DAYS = 7;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const STATUS_LABELS: Record<StatusField, string> = {
  operating: "Operating status",
  legal: "Legal status",
  tax_account: "Tax account status",
};

export function humanize(value: string | null | undefined): string {
  if (!value) return "";
  const text = value.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "2026-10-19" becomes "Oct 19, 2026". Anything unparseable is returned as given. */
export function formatDate(date: string | null | undefined): string {
  if (!date) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!m) return date;
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return date;
  return `${month} ${Number(m[3])}, ${m[1]}`;
}

/** A timestamp becomes "Sep 26, 2026, 2:04 PM" in the viewer's own time zone. */
export function formatDateTime(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const hours24 = d.getHours();
  const hours = hours24 % 12 === 0 ? 12 : hours24 % 12;
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const ampm = hours24 < 12 ? "AM" : "PM";
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}, ${hours}:${minutes} ${ampm}`;
}

/** Whole days from `today` to `date` (negative when `date` is past). Both YYYY-MM-DD. */
export function daysUntil(date: string, today: string): number {
  const a = Date.parse(`${today}T00:00:00Z`);
  const b = Date.parse(`${date}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** "in 23 days", "today", "tomorrow", "yesterday", "5 days ago". */
export function relativeDays(date: string, today: string): string {
  const days = daysUntil(date, today);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (days > 0) return `in ${days} days`;
  return `${-days} days ago`;
}

/** How to highlight a renewal date: lapsed, due within the window, or not at all. */
export function renewalTone(renewalDate: string | null, today: string): "bad" | "warn" | null {
  if (!renewalDate) return null;
  const days = daysUntil(renewalDate, today);
  if (days < 0) return "bad";
  if (days <= RENEWAL_WINDOW_DAYS) return "warn";
  return null;
}

/** "Renews Nov 1, 2026 (in 36 days)" or "Lapsed Sep 1, 2026 (25 days ago)". */
export function describeRenewal(renewalDate: string, today: string): string {
  const lapsed = daysUntil(renewalDate, today) < 0;
  return `${lapsed ? "Lapsed" : "Renews"} ${formatDate(renewalDate)} (${relativeDays(renewalDate, today)})`;
}

export function isFilingOpen(f: Pick<FilingApi, "status">): boolean {
  return f.status !== "filed" && f.status !== "accepted" && f.status !== "not_required";
}

export function isFilingOverdue(f: Pick<FilingApi, "status" | "effectiveDueDate">, today: string): boolean {
  return isFilingOpen(f) && f.effectiveDueDate < today;
}

/** Red when overdue, amber when due within a week, nothing otherwise. Closed filings never tint. */
export function dueTone(f: Pick<FilingApi, "status" | "effectiveDueDate">, today: string): "bad" | "warn" | null {
  if (!isFilingOpen(f)) return null;
  const days = daysUntil(f.effectiveDueDate, today);
  if (days < 0) return "bad";
  if (days <= DUE_SOON_DAYS) return "warn";
  return null;
}

/** "Due Oct 19, 2026 (in 23 days)", or "(12 days overdue)" for an open filing past its date. */
export function describeDue(f: Pick<FilingApi, "status" | "effectiveDueDate">, today: string): string {
  const days = daysUntil(f.effectiveDueDate, today);
  const detail =
    isFilingOpen(f) && days < 0
      ? days === -1
        ? "1 day overdue"
        : `${-days} days overdue`
      : relativeDays(f.effectiveDueDate, today);
  return `Due ${formatDate(f.effectiveDueDate)} (${detail})`;
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

export function allStatusesUnknown(business: Pick<BusinessApi, "statuses">): boolean {
  return (["operating", "legal", "tax_account"] as StatusField[]).every((f) => business.statuses[f].value === "unknown");
}

/** Plain words for the legal status shown on a list row, and the colour of its dot. */
export function legalStatusSummary(value: string): { text: string; tone: "good" | "warn" | "neutral" | "unknown" } {
  switch (value) {
    case "active":
      return { text: "Active", tone: "good" };
    case "not_yet_formed":
      return { text: "Not yet formed", tone: "warn" };
    case "formation_filed":
      return { text: "Formation filed", tone: "warn" };
    case "dissolution_filed":
      return { text: "Dissolution filed", tone: "neutral" };
    case "dissolved":
      return { text: "Dissolved", tone: "neutral" };
    default:
      return { text: "Status not yet proven", tone: "unknown" };
  }
}

const ROLE_LABELS: Record<string, string> = {
  "case:notice": "Notice",
  "case:formation": "Formation",
  "case:wind-down": "Wind-down",
  records: "Records",
  filing: "Filing",
};

export function roleLabel(role: string): string {
  if (ROLE_LABELS[role]) return ROLE_LABELS[role];
  const bare = role.startsWith("case:") ? role.slice(5) : role;
  return humanize(bare.replace(/-/g, " "));
}

const PREPARER_LABELS: Record<string, string> = {
  cpa: "CPA",
  owner: "Owner",
  agent_drafts: "agent drafts",
  other: "someone else",
};

export function preparerLabel(preparer: string | null | undefined): string {
  if (!preparer) return "";
  return PREPARER_LABELS[preparer] ?? humanize(preparer).toLowerCase();
}

/**
 * History is append-only, so rows written before input was cleaned still hold
 * HTML entities ("Profit &amp; Loss"). Show them as the characters they mean.
 */
function plainText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function quoted(value: string | null): string {
  return value ? `"${plainText(value)}"` : "";
}

/** One plain sentence for a history row, without the timestamp. */
export function describeHistory(h: Pick<HistoryApi, "kind" | "field" | "oldValue" | "newValue" | "asOf">): string {
  const asOf = h.asOf ? ` (as of ${formatDate(h.asOf)})` : "";
  switch (h.kind) {
    case "business_created":
      return `Business record created${h.newValue ? ` for ${quoted(h.newValue)}` : ""}`;
    case "business_updated": {
      const what = h.field ? humanize(h.field.replace(/^filing\./, "filing ")) : "Record";
      if (h.oldValue && h.newValue) return `${what} changed from ${quoted(h.oldValue)} to ${quoted(h.newValue)}${asOf}`;
      if (h.newValue) return `${what} set to ${quoted(h.newValue)}${asOf}`;
      return `${what} updated${asOf}`;
    }
    case "status_change": {
      const label = h.field && h.field in STATUS_LABELS ? STATUS_LABELS[h.field as StatusField] : humanize(h.field ?? "Status");
      const from = h.oldValue ? ` from ${humanize(h.oldValue).toLowerCase()}` : "";
      return `${label} changed${from} to ${humanize(h.newValue ?? "").toLowerCase()}${asOf}`;
    }
    case "filing_status_change": {
      const name = h.field ? quoted(h.field) : "Filing";
      const from = h.oldValue ? ` from ${humanize(h.oldValue).toLowerCase()}` : "";
      return `${name} moved${from} to ${humanize(h.newValue ?? "").toLowerCase()}${asOf}`;
    }
    case "document_added":
      return `Document added: ${quoted(h.newValue)}${h.field ? ` (${humanize(h.field).toLowerCase()})` : ""}${asOf}`;
    case "document_replaced":
      if (!h.oldValue || h.oldValue === h.newValue) return `${quoted(h.newValue)} replaced by a newer copy${asOf}`;
      return `${quoted(h.oldValue)} replaced by ${quoted(h.newValue)}${asOf}`;
    case "document_updated": {
      const what = h.field ? ` (${h.field})` : "";
      if (h.oldValue && h.newValue && h.oldValue !== h.newValue) {
        return `Document ${quoted(h.oldValue)} renamed to ${quoted(h.newValue)}${what}`;
      }
      return `Document ${quoted(h.newValue ?? h.oldValue)} edited${what}`;
    }
    case "document_removed":
      return `Document removed: ${quoted(h.oldValue)}`;
    default:
      return `${humanize(h.kind)}${h.newValue ? `: ${h.newValue}` : ""}${asOf}`;
  }
}

export interface AttentionCounts {
  overdue: number;
  dueSoon: number;
  renewals: number;
}

/** Per-business counts from the overview, so the list can show where attention is needed. */
export function attentionByBusiness(overview: {
  overdueFilings: Array<{ businessId: string }>;
  filingsDueSoon: Array<{ businessId: string }>;
  documentsRenewingSoon: Array<{ businessId: string }>;
}): Record<string, AttentionCounts> {
  const out: Record<string, AttentionCounts> = {};
  const bump = (id: string, key: keyof AttentionCounts) => {
    out[id] ??= { overdue: 0, dueSoon: 0, renewals: 0 };
    out[id][key] += 1;
  };
  for (const f of overview.overdueFilings) bump(f.businessId, "overdue");
  for (const f of overview.filingsDueSoon) bump(f.businessId, "dueSoon");
  for (const d of overview.documentsRenewingSoon) bump(d.businessId, "renewals");
  return out;
}
