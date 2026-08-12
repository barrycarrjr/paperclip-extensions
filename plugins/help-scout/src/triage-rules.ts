/**
 * Help Scout triage rules: what a valid rule looks like, and how to lift the
 * old hand-written Markdown into rows.
 *
 * Kept free of I/O so the parsing (which has to be forgiving of years of
 * hand-edited prose) is unit-testable without a database.
 */

export type HelpScoutRuleType = "auto-noise" | "keep-active";

export const RULE_TYPES: readonly HelpScoutRuleType[] = ["auto-noise", "keep-active"];

export function isRuleType(value: unknown): value is HelpScoutRuleType {
  return typeof value === "string" && (RULE_TYPES as readonly string[]).includes(value);
}

const FULL_ADDRESS_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const DOMAIN_RE = /^@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const SUBJECT_RE = /^subject:\s*\S/i;
/**
 * Display-name matching. Help Scout has no email-tools counterpart for this,
 * because support mail routinely arrives from a no-reply address whose only
 * distinguishing feature is the name attached to it.
 */
const SENDER_RE = /^sender:\s*\S/i;

/**
 * Normalise a pattern for storage: trimmed, and lowercased except for the
 * free-text tail of `subject:` / `sender:` forms, which are matched
 * case-insensitively anyway but read better preserved.
 */
export function normalizeRulePattern(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const prefixed = /^(subject|sender):\s*(.*)$/i.exec(trimmed);
  if (prefixed) return `${prefixed[1]!.toLowerCase()}: ${prefixed[2]!.trim()}`;
  return trimmed.toLowerCase();
}

/** The four accepted forms. Anything else is a typo, not a rule. */
export function isValidRulePattern(pattern: string): boolean {
  const p = pattern.trim();
  if (!p) return false;
  return (
    FULL_ADDRESS_RE.test(p) || DOMAIN_RE.test(p) || SUBJECT_RE.test(p) || SENDER_RE.test(p)
  );
}

export interface ParsedRule {
  senderPattern: string;
  ruleType: HelpScoutRuleType;
}

/**
 * Section headers as they appear in the retired document. Keep-active is
 * listed first because the importer processes sections in order and the first
 * writer wins, which matches how the skill evaluates them: keep-active beats
 * auto-noise when a pattern is contradictorily listed under both.
 */
const SECTIONS: ReadonlyArray<{ header: string; ruleType: HelpScoutRuleType }> = [
  { header: "## Keep-active senders / subjects", ruleType: "keep-active" },
  { header: "## Keep-active", ruleType: "keep-active" },
  { header: "## Auto-noise senders / subjects", ruleType: "auto-noise" },
  { header: "## Auto-noise", ruleType: "auto-noise" },
];

function sectionBody(doc: string, header: string): string | null {
  const at = doc.indexOf(header);
  if (at === -1) return null;
  const after = at + header.length;
  const nextHeader = doc.indexOf("\n## ", after);
  return doc.slice(after, nextHeader === -1 ? doc.length : nextHeader);
}

/**
 * Pull rules out of a rules-home document body.
 *
 * Skips comment lines, headings, and blank lines, tolerates bullet prefixes,
 * and drops anything that is not one of the four forms rather than importing
 * a line of prose as a rule. A pattern already seen under an earlier section
 * is not re-added, which is what makes keep-active win.
 */
export function parseRulesDocument(body: string): ParsedRule[] {
  const out: ParsedRule[] = [];
  const seen = new Set<string>();

  for (const { header, ruleType } of SECTIONS) {
    const section = sectionBody(body, header);
    if (section === null) continue;
    for (const rawLine of section.split("\n")) {
      const line = rawLine.replace(/^[-*+]\s+/, "").trim();
      if (!line || line.startsWith("<!--") || line.startsWith("-->") || line.startsWith("#")) {
        continue;
      }
      // Entries sometimes carry a trailing " | note" or " - note".
      const candidate = line.split(/\s*\|\s*/)[0]!.trim();
      if (!isValidRulePattern(candidate)) continue;
      const senderPattern = normalizeRulePattern(candidate);
      if (seen.has(senderPattern)) continue;
      seen.add(senderPattern);
      out.push({ senderPattern, ruleType });
    }
  }

  return out;
}

export interface ConversationMatchable {
  /** Sender email address, if known. */
  fromEmail: string | null;
  /** Sender display name, if known. */
  fromName: string | null;
  subject: string;
}

/** Case-insensitive match of one pattern against one conversation. */
export function matchesRule(conversation: ConversationMatchable, pattern: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (!p) return false;

  const subjectPrefix = /^subject:\s*/i.exec(p);
  if (subjectPrefix) {
    const needle = p.slice(subjectPrefix[0].length).trim();
    return needle.length > 0 && conversation.subject.toLowerCase().includes(needle);
  }

  const senderPrefix = /^sender:\s*/i.exec(p);
  if (senderPrefix) {
    const needle = p.slice(senderPrefix[0].length).trim();
    if (!needle) return false;
    return (conversation.fromName ?? "").toLowerCase().includes(needle);
  }

  const addr = (conversation.fromEmail ?? "").trim().toLowerCase();
  if (!addr) return false;

  if (p.startsWith("@")) {
    // A domain rule covers subdomains, because alerting services send from
    // things like noreply@alerts.rollbar.com and the operator wrote
    // "@rollbar.com". Matched on the domain part rather than by substring, so
    // "@rollbar.com" does not also swallow "billing@notrollbar.com".
    const at = addr.lastIndexOf("@");
    if (at < 0) return false;
    const domain = addr.slice(at + 1);
    const target = p.slice(1);
    return domain === target || domain.endsWith(`.${target}`);
  }

  return addr === p;
}
