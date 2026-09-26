/**
 * Input validation primitives. Pure, no I/O.
 *
 * Every function either returns a clean value or throws a RecordsError whose
 * message starts with the [ECODE] agents and skills pattern-match on. Error
 * messages name the FIELD that was wrong, never the value, because a value
 * might be the very tax id the plugin is refusing to store.
 */

import type { Contact, StatusSource } from "./domain.js";
import { NOT_REQUIRED_SOURCE_KINDS, STATUS_SOURCE_KINDS } from "./domain.js";

export class RecordsError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.code = code;
    this.name = "RecordsError";
  }
}

export function invalid(message: string): RecordsError {
  return new RecordsError("EINVALID_INPUT", message);
}

// ---- Sensitive ids ----

/**
 * Shapes of a full tax id or social security number.
 *
 * Deliberately narrower than "any nine digits with optional dashes". The
 * loose form `\d{3}-?\d{2}-?\d{4}` also matches a ZIP+4 postcode
 * (19103-1234 reads as 191 03 -1234), which would refuse every note that
 * contains an address. So separators have to be consistent:
 *
 *   123-45-6789   SSN, dashed
 *   123 45 6789   SSN, spaced
 *   12-3456789    EIN, dashed
 *   123456789     nine digits standing alone, which could be either
 *
 * Phone numbers (3-3-4), dates (4-2-2 or 2/2/4), ZIP+4 (5-4), money with
 * thousands separators and longer or shorter digit runs do not match. See
 * validate.test.ts for the full list of positives and negatives.
 */
export const SENSITIVE_ID_PATTERNS: readonly RegExp[] = [
  /\b\d{3}-\d{2}-\d{4}\b/,
  /\b\d{3} \d{2} \d{4}\b/,
  /\b\d{2}-\d{7}\b/,
  /\b\d{9}\b/,
];

export function looksLikeFullTaxId(text: string): boolean {
  return SENSITIVE_ID_PATTERNS.some((re) => re.test(text));
}

/** Keys whose values are ids or dates the plugin generated or validated, never free text. */
const NOT_FREE_TEXT_KEYS = new Set([
  "id",
  "businessId",
  "documentId",
  "replacesDocumentId",
  "proofDocumentId",
  "filingId",
  "issueId",
  "linkedCompanyIds",
  "companyId",
  "asOf",
  "since",
  "dueDate",
  "extendedDueDate",
  "periodStart",
  "periodEnd",
  "documentDate",
  "renewalDate",
  "taxClassificationEffective",
  "taxIdLast4",
]);

/**
 * Walk an input object and return the path of the first free-text string that
 * looks like a full tax id, or null. Ids and dates are skipped because they are
 * validated for their own shape separately.
 */
export function findSensitiveField(value: unknown, path = ""): string | null {
  if (typeof value === "string") {
    return looksLikeFullTaxId(value) ? path || "(value)" : null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findSensitiveField(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (NOT_FREE_TEXT_KEYS.has(key)) continue;
      const hit = findSensitiveField(child, path ? `${path}.${key}` : key);
      if (hit) return hit;
    }
  }
  return null;
}

export function assertNoSensitiveIds(input: unknown): void {
  const field = findSensitiveField(input);
  if (field) {
    throw new RecordsError(
      "ESENSITIVE_ID",
      `${field} contains something shaped like a full tax id or social security number. Only the last four digits of a tax id may be stored (taxIdLast4); keep the full number in the original document.`,
    );
  }
}

export function parseTaxIdLast4(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string" || !/^\d{4}$/.test(raw)) {
    throw new RecordsError(
      "ESENSITIVE_ID",
      "taxIdLast4 must be exactly the last four digits of the tax id, for example \"0000\". Never send the full number.",
    );
  }
  return raw;
}

// ---- Dates ----

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date written YYYY-MM-DD (2026-02-30 is false). */
export function isDateOnly(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  const m = DATE_ONLY_RE.exec(raw);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function parseDate(raw: unknown, field: string): string {
  if (!isDateOnly(raw)) {
    throw invalid(`${field} must be a real date written YYYY-MM-DD.`);
  }
  return raw;
}

/** undefined = not given, null = clear it, string = a validated date. */
export function parseOptionalDate(raw: unknown, field: string): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  return parseDate(raw, field);
}

/** Local calendar date of the worker, YYYY-MM-DD. */
export function todayLocal(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** An ISO 8601 timestamp (for `since` filters). Returns it normalised to UTC. */
export function parseTimestamp(raw: unknown, field: string): string {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(raw)) {
    throw invalid(`${field} must be an ISO 8601 timestamp such as 2026-09-01T00:00:00Z.`);
  }
  const ms = Date.parse(raw.length === 10 ? `${raw}T00:00:00Z` : raw);
  if (Number.isNaN(ms)) {
    throw invalid(`${field} must be an ISO 8601 timestamp such as 2026-09-01T00:00:00Z.`);
  }
  return new Date(ms).toISOString();
}

// ---- Scalars ----

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(raw: unknown): raw is string {
  return typeof raw === "string" && UUID_RE.test(raw);
}

export function parseUuid(raw: unknown, field: string): string {
  if (!isUuid(raw)) throw invalid(`${field} must be a UUID.`);
  return raw.toLowerCase();
}

export function parseOptionalUuid(raw: unknown, field: string): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  return parseUuid(raw, field);
}

export function parseText(raw: unknown, field: string, max = 2000): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw invalid(`${field} is required and must be non-empty text.`);
  }
  const trimmed = raw.trim();
  if (trimmed.length > max) throw invalid(`${field} is longer than ${max} characters.`);
  return trimmed;
}

/** undefined = not given, null = clear it. */
export function parseOptionalText(raw: unknown, field: string, max = 2000): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string") throw invalid(`${field} must be text.`);
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) throw invalid(`${field} is longer than ${max} characters.`);
  return trimmed;
}

export function parseEnum<T extends string>(raw: unknown, allowed: readonly T[], field: string): T {
  if (typeof raw !== "string" || !(allowed as readonly string[]).includes(raw)) {
    throw invalid(`${field} must be one of: ${allowed.join(", ")}.`);
  }
  return raw as T;
}

export function parseOptionalEnum<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  field: string,
): T | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  return parseEnum(raw, allowed, field);
}

export function parseStringArray(raw: unknown, field: string, maxItems = 50, maxLen = 200): string[] | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return [];
  if (!Array.isArray(raw)) throw invalid(`${field} must be an array of text.`);
  if (raw.length > maxItems) throw invalid(`${field} has more than ${maxItems} items.`);
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") throw invalid(`${field} must be an array of text.`);
    const t = item.trim();
    if (!t) continue;
    if (t.length > maxLen) throw invalid(`${field} has an item longer than ${maxLen} characters.`);
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

export function parseUuidArray(raw: unknown, field: string): string[] | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return [];
  if (!Array.isArray(raw)) throw invalid(`${field} must be an array of UUIDs.`);
  const out: string[] = [];
  for (const item of raw) {
    const id = parseUuid(item, field);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

export function parsePositiveInt(raw: unknown, field: string, max: number): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > max) {
    throw invalid(`${field} must be a whole number from 0 to ${max}.`);
  }
  return raw;
}

// ---- Structured values ----

const CONTACT_KEYS = ["role", "name", "email", "phone", "notes"] as const;

/**
 * Contacts are stored in a fixed key order with empty fields dropped, so the
 * same input always produces the same stored value (which is what lets a
 * repeated upsert detect "nothing changed").
 */
export function parseContacts(raw: unknown): Contact[] | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return [];
  if (!Array.isArray(raw)) throw invalid("contacts must be an array of {role, name, email, phone, notes}.");
  if (raw.length > 50) throw invalid("contacts has more than 50 entries.");
  return raw.map((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw invalid(`contacts[${i}] must be an object.`);
    }
    const obj = item as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (!(CONTACT_KEYS as readonly string[]).includes(key)) {
        throw invalid(`contacts[${i}] has an unknown field ${key}. Allowed: ${CONTACT_KEYS.join(", ")}.`);
      }
    }
    const contact: Contact = { role: parseText(obj.role, `contacts[${i}].role`, 100) };
    for (const key of ["name", "email", "phone", "notes"] as const) {
      const v = parseOptionalText(obj[key], `contacts[${i}].${key}`, 500);
      if (v) contact[key] = v;
    }
    return contact;
  });
}

/** Canonical form of contacts read back from jsonb, for comparison. */
export function canonicalContacts(raw: unknown): Contact[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((c) => {
    const obj = (c ?? {}) as Record<string, unknown>;
    const out: Contact = { role: String(obj.role ?? "") };
    for (const key of ["name", "email", "phone", "notes"] as const) {
      if (typeof obj[key] === "string" && obj[key]) out[key] = obj[key] as string;
    }
    return out;
  });
}

function parseSourceObject(raw: unknown, field: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalid(`${field} must be an object like {"kind": "document", "documentId": "<uuid>"}.`);
  }
  return raw as Record<string, unknown>;
}

/** Source of a status change. Whether it is ENOUGH for the value is decided in guards.ts. */
export function parseStatusSource(raw: unknown, field = "source"): StatusSource {
  const obj = parseSourceObject(raw, field);
  const kind = parseEnum(obj.kind, STATUS_SOURCE_KINDS, `${field}.kind`);
  const source: StatusSource = { kind };
  const documentId = parseOptionalUuid(obj.documentId, `${field}.documentId`);
  if (documentId) source.documentId = documentId;
  const url = parseOptionalText(obj.url, `${field}.url`, 1000);
  if (url) source.url = url;
  const note = parseOptionalText(obj.note, `${field}.note`, 1000);
  if (note) source.note = note;
  return source;
}

/**
 * Source for a `not_required` filing. The kind is checked here only for being
 * text; the guard decides whether it is an acceptable kind so that the refusal
 * carries the right error code.
 */
export function parseNotRequiredSource(raw: unknown, field = "source"): StatusSource {
  const obj = parseSourceObject(raw, field);
  if (typeof obj.kind !== "string" || !obj.kind) {
    throw invalid(`${field}.kind is required: one of ${NOT_REQUIRED_SOURCE_KINDS.join(", ")}.`);
  }
  const source: StatusSource = { kind: obj.kind };
  const documentId = parseOptionalUuid(obj.documentId, `${field}.documentId`);
  if (documentId) source.documentId = documentId;
  const url = parseOptionalText(obj.url, `${field}.url`, 1000);
  if (url) source.url = url;
  const note = parseOptionalText(obj.note, `${field}.note`, 1000);
  if (note) source.note = note;
  return source;
}

/** Link roles are short slugs such as case:notice or records. */
export function parseRole(raw: unknown): string {
  const role = parseText(raw, "role", 64).toLowerCase();
  if (!/^[a-z][a-z0-9:_-]*$/.test(role)) {
    throw invalid("role must be a short slug such as case:notice, case:formation, case:wind-down, records or filing.");
  }
  return role;
}

export function readParams(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}
