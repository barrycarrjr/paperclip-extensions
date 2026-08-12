/**
 * What a sender rule pattern is allowed to look like.
 *
 * Until now `email.set-rule` accepted whatever string it was handed, so a
 * typo became a stored rule that could never match anything. That fails
 * quietly in the worst way: the operator believes the noise is handled and
 * the mail keeps arriving.
 *
 * Kept free of I/O so the worker and the settings panel can agree without
 * either importing the other.
 */

export const RULE_TYPES = ["auto-triage", "keep-always", "mute"] as const;
export type RuleType = (typeof RULE_TYPES)[number];

export function isRuleType(value: unknown): value is RuleType {
  return typeof value === "string" && (RULE_TYPES as readonly string[]).includes(value);
}

const ADDRESS_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const DOMAIN_RE = /^@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const SUBJECT_RE = /^subject:\s*\S/i;

/** The three accepted forms: full address, @domain, or subject substring. */
export function isValidRulePattern(pattern: string): boolean {
  const p = pattern.trim();
  if (!p) return false;
  return ADDRESS_RE.test(p) || DOMAIN_RE.test(p) || SUBJECT_RE.test(p);
}

/**
 * Normalise for storage. Addresses and domains are lowercased because they are
 * matched case-insensitively anyway; the free text after `subject:` keeps its
 * casing so it reads back the way it was typed.
 */
export function normalizeRulePattern(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const subject = /^subject:\s*(.*)$/i.exec(trimmed);
  if (subject) return `subject: ${subject[1]!.trim()}`;
  return trimmed.toLowerCase();
}

/** Human-readable explanation of why a pattern was rejected. */
export function describeInvalidPattern(raw: string): string {
  const p = raw.trim();
  if (!p) return "A rule needs something to match on.";
  if (p.startsWith("@")) {
    return `"${p}" does not look like a domain. Use a form like @example.com.`;
  }
  if (p.includes("@")) {
    return `"${p}" does not look like an email address.`;
  }
  return (
    `"${p}" is not a recognised rule. Use a full address (someone@example.com), ` +
    `a domain (@example.com), or a subject match (subject: Daily Summary).`
  );
}
