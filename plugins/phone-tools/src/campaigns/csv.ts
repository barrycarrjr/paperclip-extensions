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
 * Heuristic: given a parsed CSV, suggest a `LeadColumnMapping` by
 * scoring each header against (a) its name and (b) the shape of its
 * data. Returns the best-fit mapping plus a confidence note per
 * column for the UI to show.
 *
 * Scoring rules:
 *   - phone: header names containing 'phone' / 'tel' / 'mobile' /
 *     'number' get a name-bump; columns whose values normalize to
 *     E.164 ≥60% of the time get a data-bump. Highest combined
 *     score wins; tie-broken by index (leftmost preferred).
 *   - name / businessName / website / timezone: header-name match
 *     only — values are too varied to score reliably.
 *
 * Confidence per column: "high" if both name + data bump, "medium"
 * if only name match, "low" if data-only inference, "none" if no
 * column matched. The UI renders the confidence so the operator
 * knows when to override.
 */
export interface AutoDetectResult {
  mapping: LeadColumnMapping;
  confidence: {
    phone: "high" | "medium" | "low" | "none";
    name?: "high" | "medium";
    businessName?: "high" | "medium";
    website?: "high" | "medium";
    timezone?: "high" | "medium";
  };
  /** Operator-facing reason — surface in the wizard so wrong guesses are easy to override. */
  rationale: string[];
}

const PHONE_HEADER_KEYWORDS = ["phone", "tel", "mobile", "number", "cell", "phn"];
const NAME_HEADER_KEYWORDS = ["name", "fullname", "contact", "person"];
const BUSINESS_HEADER_KEYWORDS = ["business", "company", "organization", "org", "biz", "account"];
const WEBSITE_HEADER_KEYWORDS = ["website", "url", "site", "domain", "web"];
const TZ_HEADER_KEYWORDS = ["timezone", "tz", "time_zone"];

export function autoDetectMapping(parsed: CsvParseResult): AutoDetectResult {
  const rationale: string[] = [];
  const mapping: LeadColumnMapping = { phone: "" };
  const confidence: AutoDetectResult["confidence"] = { phone: "none" };

  const headersLower = parsed.headers.map((h) => h.toLowerCase().replace(/[\s_-]+/g, ""));

  // Phone: name-match + data-shape scoring.
  let bestPhone: { col: string; score: number; reason: string } | null = null;
  for (let i = 0; i < parsed.headers.length; i++) {
    const header = parsed.headers[i];
    const lowered = headersLower[i];
    const nameMatch = PHONE_HEADER_KEYWORDS.some((k) => lowered.includes(k));
    const valid = countValidPhones(parsed.rows, header);
    const shareValid = parsed.rows.length > 0 ? valid / parsed.rows.length : 0;
    let score = 0;
    const reasons: string[] = [];
    if (nameMatch) {
      score += 50;
      reasons.push(`header name "${header}" matches a phone keyword`);
    }
    if (shareValid >= 0.6) {
      score += Math.round(shareValid * 50);
      reasons.push(`${Math.round(shareValid * 100)}% of values normalize to E.164`);
    }
    if (score > 0 && (!bestPhone || score > bestPhone.score)) {
      bestPhone = { col: header, score, reason: reasons.join(" + ") };
    }
  }
  if (bestPhone) {
    mapping.phone = bestPhone.col;
    confidence.phone = bestPhone.score >= 90 ? "high" : bestPhone.score >= 50 ? "medium" : "low";
    rationale.push(`phone → "${bestPhone.col}" (${bestPhone.reason})`);
  } else {
    rationale.push(
      `phone → none. No header matched a phone keyword AND no column had majority-valid phones. Operator must pick the phone column manually.`,
    );
  }

  // Name / business / website / timezone — name-match only, in priority
  // order so a header named "businessName" doesn't also win the "name"
  // slot. We claim each header at most once.
  const claimed = new Set<string>();
  if (mapping.phone) claimed.add(mapping.phone);

  const matchByKeyword = (
    keywords: string[],
    field: keyof Omit<LeadColumnMapping, "phone">,
  ): void => {
    for (let i = 0; i < parsed.headers.length; i++) {
      const header = parsed.headers[i];
      if (claimed.has(header)) continue;
      const lowered = headersLower[i];
      if (keywords.some((k) => lowered.includes(k))) {
        mapping[field] = header;
        confidence[field] = "high";
        claimed.add(header);
        rationale.push(`${String(field)} → "${header}" (header keyword match)`);
        return;
      }
    }
  };

  matchByKeyword(BUSINESS_HEADER_KEYWORDS, "businessName");
  matchByKeyword(NAME_HEADER_KEYWORDS, "name");
  matchByKeyword(WEBSITE_HEADER_KEYWORDS, "website");
  matchByKeyword(TZ_HEADER_KEYWORDS, "timezone");

  return { mapping, confidence, rationale };
}

function countValidPhones(rows: Array<Record<string, string>>, header: string): number {
  let n = 0;
  // Sample at most 200 rows for speed; the heuristic doesn't need to be exact.
  const sampleSize = Math.min(rows.length, 200);
  for (let i = 0; i < sampleSize; i++) {
    if (normalizeToE164(rows[i][header] ?? "")) n++;
  }
  // Extrapolate to the full row count for the share calculation.
  return rows.length > 0 ? Math.round((n / sampleSize) * rows.length) : 0;
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
