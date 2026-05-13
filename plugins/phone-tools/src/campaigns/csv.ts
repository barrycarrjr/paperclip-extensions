/**
 * Minimal CSV parser for lead-list import.
 *
 * Handles: BOM, quoted fields, escaped quotes (""), CRLF / LF line
 * endings, commas inside quoted fields, trailing newline. Doesn't
 * handle: multi-character delimiters, configurable separators (always
 * comma), schema validation (caller does that).
 *
 * Why inline rather than `csv-parse`: campaigns CSV input is small
 * (<10k rows) and adding a dep for ~80 LoC of parsing would be
 * disproportionate. The plugin is bundled by esbuild; adding deps
 * inflates the worker bundle.
 */

import type { CampaignLead, CampaignLeadStatus } from "./types.js";

export interface CsvParseResult {
  headers: string[];
  rows: Array<Record<string, string>>;
}

export function parseCsv(text: string): CsvParseResult {
  // Strip UTF-8 BOM if present.
  const stripped = text.replace(/^﻿/, "");
  const lines = splitLines(stripped);
  if (lines.length === 0) return { headers: [], rows: [] };

  const headers = splitCsvLine(lines[0]).map((h) => h.trim());
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const cells = splitCsvLine(line);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = (cells[j] ?? "").trim();
    }
    rows.push(row);
  }
  return { headers, rows };
}

/**
 * Split CSV input into logical lines, respecting quoted fields that
 * contain literal newlines. Most lead CSVs don't have embedded
 * newlines, but the parser shouldn't break if one does.
 */
function splitLines(text: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"') {
      if (inQuote && next === '"') {
        // Escaped quote — emit one and advance past the second.
        buf += '""';
        i++;
        continue;
      }
      inQuote = !inQuote;
      buf += ch;
      continue;
    }
    if ((ch === "\n" || ch === "\r") && !inQuote) {
      // CRLF: skip the LF after a CR.
      if (ch === "\r" && next === "\n") i++;
      out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.length > 0) out.push(buf);
  return out;
}

/**
 * Split a single CSV row into cells, handling quoted fields.
 */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let buf = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];
    if (ch === '"') {
      if (inQuote && next === '"') {
        buf += '"';
        i++;
        continue;
      }
      inQuote = !inQuote;
      continue;
    }
    if (ch === "," && !inQuote) {
      cells.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  cells.push(buf);
  return cells;
}

// ─── Lead extraction ────────────────────────────────────────────────────

export interface LeadColumnMapping {
  /** Column name in the CSV that holds the phone number. */
  phone: string;
  /** Optional column name for the lead's name. */
  name?: string;
  /** Optional column name for the business name. */
  businessName?: string;
  /** Optional column name for the website URL. */
  website?: string;
  /** Optional column name for the IANA timezone hint. */
  timezone?: string;
}

export interface RowToLeadResult {
  ok: boolean;
  lead?: CampaignLead;
  reason?: string;
}

/**
 * Convert a parsed CSV row to a CampaignLead. Phones are normalized
 * to E.164 (best-effort); rows with no phone or an invalid phone are
 * rejected with a `reason`.
 */
export function rowToLead(
  campaignId: string,
  row: Record<string, string>,
  mapping: LeadColumnMapping,
  defaultStatus: CampaignLeadStatus = "pending",
): RowToLeadResult {
  const rawPhone = row[mapping.phone];
  if (!rawPhone) {
    return { ok: false, reason: "missing-phone" };
  }
  const e164 = normalizeToE164(rawPhone);
  if (!e164) {
    return { ok: false, reason: `invalid-phone:${rawPhone}` };
  }
  const lead: CampaignLead = {
    campaignId,
    phoneE164: e164,
    name: mapping.name ? row[mapping.name] || undefined : undefined,
    businessName: mapping.businessName ? row[mapping.businessName] || undefined : undefined,
    websiteUrl: mapping.website ? row[mapping.website] || undefined : undefined,
    timezoneHint: mapping.timezone ? row[mapping.timezone] || undefined : undefined,
    status: defaultStatus,
    attempts: 0,
    callIds: [],
  };
  return { ok: true, lead };
}

/**
 * Loose-and-then-strict E.164 normalizer. Accepts:
 *   "+15551234567"          → "+15551234567"
 *   "(555) 123-4567"        → "+15551234567" (assumes US/CA, prepends +1)
 *   "5551234567"            → "+15551234567" (assumes US/CA)
 *   "15551234567"           → "+15551234567"
 *   "+44 20 1234 5678"      → "+442012345678"
 * Rejects anything that doesn't end up as `+[1-9][0-9]{6,14}`.
 */
export function normalizeToE164(raw: string): string | null {
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  // Strip all non-digit chars except leading +.
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/[^\d]/g, "");
  if (!digits) return null;
  let candidate: string;
  if (hasPlus) {
    candidate = `+${digits}`;
  } else if (digits.length === 10) {
    // Assume US/CA local format; prepend +1.
    candidate = `+1${digits}`;
  } else if (digits.length === 11 && digits.startsWith("1")) {
    candidate = `+${digits}`;
  } else {
    candidate = `+${digits}`;
  }
  // Final E.164 validator: + then 7-15 digits, no leading 0.
  if (!/^\+[1-9]\d{6,14}$/.test(candidate)) return null;
  return candidate;
}
