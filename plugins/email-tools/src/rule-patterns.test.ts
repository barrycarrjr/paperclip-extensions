/**
 * Tests for sender rule patterns.
 *
 * `email.set-rule` used to store whatever string it was given, so a typo
 * became a rule that could never match. That is the worst kind of failure
 * here, because the operator believes the noise is handled and it isn't.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  describeInvalidPattern,
  isRuleType,
  isValidRulePattern,
  normalizeRulePattern,
} from "./rule-patterns.js";

test("accepts the three real forms", () => {
  for (const good of [
    "noreply@example.com",
    "first.last+tag@mail.example.co.uk",
    "@example.com",
    "@mail.example.co.uk",
    "subject: Daily Summary",
    "subject:Daily Summary",
  ]) {
    assert.ok(isValidRulePattern(good), `expected valid: ${good}`);
  }
});

test("rejects the near-misses that would silently never match", () => {
  for (const bad of [
    "",
    "   ",
    "example.com", // domain without the @
    "@example", // no TLD
    "@", // nothing at all
    "subject:", // no text to match
    "noreply@", // truncated address
    "Rollbar Notification", // a display name, which this plugin has no form for
  ]) {
    assert.ok(!isValidRulePattern(bad), `expected invalid: ${JSON.stringify(bad)}`);
  }
});

test("normalizes addresses and domains but keeps subject text readable", () => {
  assert.equal(normalizeRulePattern("  NoReply@Example.COM "), "noreply@example.com");
  assert.equal(normalizeRulePattern("@Example.COM"), "@example.com");
  assert.equal(normalizeRulePattern("Subject:   Daily Summary  "), "subject: Daily Summary");
  assert.equal(normalizeRulePattern(""), "");
});

test("the rejection message points at the likely mistake", () => {
  // Forgetting the @ on a domain is the common slip, so say so specifically.
  assert.match(describeInvalidPattern("example.com"), /full address|domain|subject/i);
  assert.match(describeInvalidPattern("@example"), /domain/i);
  assert.match(describeInvalidPattern("noreply@"), /email address/i);
  assert.match(describeInvalidPattern(""), /match on/i);
});

test("isRuleType admits exactly the three stored types", () => {
  for (const good of ["auto-triage", "keep-always", "mute"]) assert.ok(isRuleType(good));
  for (const bad of ["auto-noise", "keep-active", "", null, 7]) {
    assert.ok(!isRuleType(bad), `expected rejected: ${JSON.stringify(bad)}`);
  }
});
