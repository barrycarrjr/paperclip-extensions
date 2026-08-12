/**
 * Tests for Help Scout triage rules.
 *
 * The import path is the one that matters most: these rules exist only in a
 * hand-written Markdown document until it runs, so a pattern it silently drops
 * is a rule the operator loses. The fixture below is deliberately messy in the
 * ways real documents are (comments, bullets, trailing notes, blank lines, a
 * line of prose that is not a rule at all).
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  isRuleType,
  isValidRulePattern,
  matchesRule,
  normalizeRulePattern,
  parseRulesDocument,
} from "./triage-rules.js";

const DOC = `# Help Scout triage rules - mailbox: support

last-run: 2026-08-11T06:00:00Z

## Auto-noise senders / subjects

<!-- One rule per line. Match is case-insensitive substring. -->
<!--   noreply@example.com           - full email match against From -->
- noreply@rollbar.com
- @statuspage.io
- subject: Daily Summary
- sender: Rollbar Notification
- noreply@billing.example.com | duplicate of the portal notice
these words are not a rule

## Keep-active senders / subjects

<!-- Same syntax. Beats Auto-noise if both match. -->
- boss@acme.com
- @keycustomer.com

## Review queue

- 5 conversations from someone@random.test
`;

test("parseRulesDocument lifts every valid form out of a messy document", () => {
  const rules = parseRulesDocument(DOC);
  const byType = (t: string) =>
    rules.filter((r) => r.ruleType === t).map((r) => r.senderPattern);

  assert.deepEqual(byType("auto-noise"), [
    "noreply@rollbar.com",
    "@statuspage.io",
    "subject: Daily Summary",
    "sender: Rollbar Notification",
    "noreply@billing.example.com",
  ]);
  assert.deepEqual(byType("keep-active"), ["boss@acme.com", "@keycustomer.com"]);
});

test("parseRulesDocument ignores comments, prose and the review queue", () => {
  const patterns = parseRulesDocument(DOC).map((r) => r.senderPattern);
  assert.ok(!patterns.some((p) => p.includes("these words")));
  assert.ok(!patterns.some((p) => p.includes("One rule per line")));
  // The review queue is a worklist, not policy, and must never become a rule.
  assert.ok(!patterns.includes("someone@random.test"));
});

test("keep-active wins when a pattern is listed under both sections", () => {
  const conflicted = `## Auto-noise senders / subjects
- alerts@acme.com

## Keep-active senders / subjects
- alerts@acme.com
`;
  const rules = parseRulesDocument(conflicted);
  assert.equal(rules.length, 1);
  assert.equal(rules[0]!.ruleType, "keep-active");
});

test("a document with no rule sections imports nothing rather than throwing", () => {
  assert.deepEqual(parseRulesDocument("# Retired\n\nnothing here\n"), []);
  assert.deepEqual(parseRulesDocument(""), []);
});

test("isValidRulePattern accepts the four forms and rejects the rest", () => {
  for (const good of [
    "noreply@acme.com",
    "@acme.com",
    "@mail.acme.co.uk",
    "subject: Daily Summary",
    "subject:Daily Summary",
    "sender: Rollbar Notification",
  ]) {
    assert.ok(isValidRulePattern(good), `expected valid: ${good}`);
  }
  for (const bad of ["", "   ", "acme.com", "@acme", "subject:", "sender:", "just words", "@"]) {
    assert.ok(!isValidRulePattern(bad), `expected invalid: ${JSON.stringify(bad)}`);
  }
});

test("normalizeRulePattern lowercases addresses but preserves free text", () => {
  assert.equal(normalizeRulePattern("  NoReply@Acme.COM "), "noreply@acme.com");
  assert.equal(normalizeRulePattern("@Acme.COM"), "@acme.com");
  assert.equal(normalizeRulePattern("Subject:  Daily Summary  "), "subject: Daily Summary");
  assert.equal(normalizeRulePattern("SENDER: Rollbar Bot"), "sender: Rollbar Bot");
});

test("isRuleType only admits the two real types", () => {
  assert.ok(isRuleType("auto-noise"));
  assert.ok(isRuleType("keep-active"));
  for (const bad of ["auto-triage", "keep-always", "mute", "", null, 3]) {
    assert.ok(!isRuleType(bad), `expected rejected: ${JSON.stringify(bad)}`);
  }
});

const CONV = {
  fromEmail: "noreply@alerts.rollbar.com",
  fromName: "Rollbar Notification",
  subject: "Daily Summary for acme-web",
};

test("matchesRule handles all four forms case-insensitively", () => {
  assert.ok(matchesRule(CONV, "noreply@alerts.rollbar.com"));
  assert.ok(matchesRule(CONV, "NOREPLY@ALERTS.ROLLBAR.COM"));
  assert.ok(matchesRule(CONV, "@rollbar.com"));
  assert.ok(matchesRule(CONV, "subject: daily summary"));
  assert.ok(matchesRule(CONV, "sender: rollbar"));
});

test("a domain rule covers subdomains but not lookalike domains", () => {
  // Alerting services send from a subdomain while the operator writes the
  // registrable domain, so this has to match.
  assert.ok(matchesRule(CONV, "@rollbar.com"));
  assert.ok(matchesRule({ ...CONV, fromEmail: "x@rollbar.com" }, "@rollbar.com"));
  assert.ok(matchesRule({ ...CONV, fromEmail: "x@a.b.rollbar.com" }, "@rollbar.com"));
  // But a substring match would also swallow these, and must not.
  assert.ok(!matchesRule({ ...CONV, fromEmail: "x@notrollbar.com" }, "@rollbar.com"));
  assert.ok(!matchesRule({ ...CONV, fromEmail: "x@rollbar.com.evil.test" }, "@rollbar.com"));
});

test("matchesRule does not match on the wrong field", () => {
  // A domain rule must not be satisfied by the subject or the display name.
  assert.ok(!matchesRule(CONV, "@acme.com"));
  assert.ok(!matchesRule(CONV, "subject: weekly"));
  assert.ok(!matchesRule(CONV, "sender: pagerduty"));
  // An address rule is exact, not a substring, so a lookalike domain misses.
  assert.ok(!matchesRule(CONV, "noreply@rollbar.com"));
});

test("matchesRule copes with a conversation missing an address or name", () => {
  const anon = { fromEmail: null, fromName: null, subject: "Daily Summary" };
  assert.ok(matchesRule(anon, "subject: daily"));
  assert.ok(!matchesRule(anon, "@acme.com"));
  assert.ok(!matchesRule(anon, "sender: anyone"));
  assert.ok(!matchesRule(anon, "someone@acme.com"));
});
