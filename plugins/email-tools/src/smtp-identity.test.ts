/**
 * Tests for the outgoing-identity defaulting.
 *
 * The behaviour worth pinning: a settings field the operator opened and left
 * empty must default exactly like a field they never touched. It did not, and
 * the result was a mailbox that sent with no sender address, which Gmail
 * refuses with a 550 that names nothing the operator could act on.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  deriveSmtpHost,
  nonBlank,
  resolveOwnAddress,
  resolveSmtpFrom,
  resolveSmtpHost,
  resolveSmtpUser,
  withoutOwnAddress,
} from "./smtp-identity.js";

const ACCOUNT = { user: "barry.c@example.com", imapHost: "imap.example.com" };

test("an unset From address falls back to the account address", () => {
  assert.equal(resolveSmtpFrom(ACCOUNT), "barry.c@example.com");
});

test("a From address cleared to empty falls back too, rather than sending blank", () => {
  // This is the bug: `??` only fires on undefined, so a saved "" went out as
  // an empty envelope sender.
  assert.equal(resolveSmtpFrom({ ...ACCOUNT, smtpFrom: "" }), "barry.c@example.com");
  assert.equal(resolveSmtpFrom({ ...ACCOUNT, smtpFrom: "   " }), "barry.c@example.com");
});

test("a From address that is set is used as given, trimmed", () => {
  assert.equal(
    resolveSmtpFrom({ ...ACCOUNT, smtpFrom: "  billing@example.com " }),
    "billing@example.com",
  );
});

test("the SMTP username defaults the same way", () => {
  assert.equal(resolveSmtpUser(ACCOUNT), "barry.c@example.com");
  assert.equal(resolveSmtpUser({ ...ACCOUNT, smtpUser: "" }), "barry.c@example.com");
  assert.equal(resolveSmtpUser({ ...ACCOUNT, smtpUser: "relay-user" }), "relay-user");
});

test("the SMTP host defaults the same way", () => {
  assert.equal(resolveSmtpHost(ACCOUNT), "smtp.example.com");
  assert.equal(resolveSmtpHost({ ...ACCOUNT, smtpHost: "" }), "smtp.example.com");
  assert.equal(resolveSmtpHost({ ...ACCOUNT, smtpHost: "mail.example.com" }), "mail.example.com");
});

test("a host that does not start with imap. is used unchanged", () => {
  assert.equal(deriveSmtpHost("mail.example.com"), "mail.example.com");
  assert.equal(deriveSmtpHost("imap.example.com"), "smtp.example.com");
});

test("reply-all drops our own address and keeps everyone else", () => {
  const own = resolveOwnAddress(ACCOUNT);
  assert.deepEqual(
    withoutOwnAddress(["a@example.com", "Barry.C@example.com", "b@example.com"], own),
    ["a@example.com", "b@example.com"],
  );
});

test("reply-all keeps every recipient when our own address is unknown", () => {
  // An empty needle makes `includes` match everything, so filtering on it used
  // to empty the cc list instead of removing one entry from it.
  const own = resolveOwnAddress({ user: "", smtpFrom: "" });
  assert.equal(own, "");
  assert.deepEqual(withoutOwnAddress(["a@example.com", "b@example.com"], own), [
    "a@example.com",
    "b@example.com",
  ]);
});

test("nonBlank treats whitespace and non-strings as not set", () => {
  assert.equal(nonBlank("  x "), "x");
  assert.equal(nonBlank(""), undefined);
  assert.equal(nonBlank("   "), undefined);
  assert.equal(nonBlank(undefined), undefined);
  assert.equal(nonBlank(42), undefined);
});
