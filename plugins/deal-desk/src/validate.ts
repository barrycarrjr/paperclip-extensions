/**
 * Input validation primitives. Pure, no I/O.
 *
 * Every function either returns a clean value or throws a DealDeskError whose
 * message starts with the [ECODE] agents and skills pattern-match on. Error
 * messages name the FIELD that was wrong, never the value, because a value
 * might be the very tax id or password the plugin is refusing to store.
 *
 * The sensitive-id functions (SENSITIVE_ID_PATTERNS, looksLikeFullTaxId,
 * findSensitiveField, assertNoSensitiveIds) are copied from business-records
 * so the two plugins refuse exactly the same shapes.
 */

export class DealDeskError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.code = code;
    this.name = "DealDeskError";
  }
}

export function invalid(message: string): DealDeskError {
  return new DealDeskError("EINVALID_INPUT", message);
}

// ---- Sensitive ids (copied from business-records) ----

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
  "dealId",
  "businessId",
  "documentId",
  "evidenceDocumentId",
  "adjustmentId",
  "scenarioIds",
  "companyId",
  "periodStart",
  "periodEnd",
  "closingDate",
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
    throw new DealDeskError(
      "ESENSITIVE_ID",
      `${field} contains something shaped like a full tax id or social security number. Deal Desk never stores full tax ids; keep the number in the original document.`,
    );
  }
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
): T | undefined {
  if (raw === undefined || raw === null) return undefined;
  return parseEnum(raw, allowed, field);
}

export function parsePositiveInt(raw: unknown, field: string, max: number): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > max) {
    throw invalid(`${field} must be a whole number from 0 to ${max}.`);
  }
  return raw;
}

// ---- Money ----

/** Largest amount accepted, in cents (one trillion dollars). Keeps every sum a safe integer. */
export const MAX_CENTS = 100_000_000_000_000;

/**
 * A money amount in whole cents. Required: undefined or null is refused with
 * [EINVALID_INPUT] naming the field, never defaulted to zero.
 */
export function parseCents(raw: unknown, field: string, opts: { min?: number; max?: number } = {}): number {
  if (raw === undefined || raw === null) {
    throw invalid(`${field} is required: a whole number of cents (for example 100000000 for $1,000,000.00).`);
  }
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw invalid(`${field} must be a whole number of cents, not ${typeof raw === "number" ? "a fraction" : "text"}.`);
  }
  if (Math.abs(raw) > MAX_CENTS) throw invalid(`${field} is out of range.`);
  if (opts.min !== undefined && raw < opts.min) {
    throw invalid(opts.min === 0 ? `${field} cannot be negative.` : `${field} must be at least ${opts.min} cents.`);
  }
  if (opts.max !== undefined && raw > opts.max) {
    throw invalid(opts.max === 0 ? `${field} cannot be positive.` : `${field} must be at most ${opts.max} cents.`);
  }
  return raw;
}

/** undefined = not given, null = clear it. */
export function parseOptionalCents(
  raw: unknown,
  field: string,
  opts: { min?: number; max?: number } = {},
): number | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  return parseCents(raw, field, opts);
}

export function parseCurrency(raw: unknown, field = "currency"): string {
  if (typeof raw !== "string" || !/^[A-Za-z]{3}$/.test(raw.trim())) {
    throw invalid(`${field} must be a three-letter currency code such as USD.`);
  }
  return raw.trim().toUpperCase();
}

export function readParams(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}
