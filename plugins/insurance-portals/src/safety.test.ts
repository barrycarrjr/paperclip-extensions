import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emailDomain,
  extractLoginCode,
  isDangerous,
  isDocumentLink,
  isNavigationLink,
  isSafeNavigationUrl,
  safeFileName,
  senderAllowed,
  shouldBlockRequest,
  splitDrivePath,
} from "./safety.js";

test("document links: declarations and policy documents are picked", () => {
  for (const t of [
    "Declarations Page",
    "View declarations",
    "Download Dec Page",
    "Policy Documents",
    "Full policy packet",
    "View PDF",
    "Auto ID Cards",
    "Evidence of Property Insurance",
  ]) {
    assert.equal(isDocumentLink(t), true, t);
  }
});

test("document links: anything that pays, changes or submits is refused", () => {
  for (const t of [
    "Make a payment",
    "Pay bill",
    "Change policy documents delivery",
    "Update paperless policy documents",
    "Cancel policy",
    "Submit claim documents",
    "Enroll in AutoPay",
    "Sign out",
    "Billing statement",
    "Prior declarations",
    "Expired policy documents",
  ]) {
    assert.equal(isDocumentLink(t), false, t);
  }
});

test("document links: a PDF address alone counts only when it names a policy", () => {
  assert.equal(isDocumentLink("", "https://x.com/docs/declarations-2026.pdf"), true);
  assert.equal(isDocumentLink("", "https://x.com/docs/brochure.pdf"), false);
});

test("navigation links stay away from danger", () => {
  assert.equal(isNavigationLink("Documents"), true);
  assert.equal(isNavigationLink("Policy details"), true);
  assert.equal(isNavigationLink("My Policies"), true);
  assert.equal(isNavigationLink("Make a payment"), false);
  assert.equal(isNavigationLink("Change coverages"), false);
  assert.equal(isNavigationLink("Claims"), false);
});

test("isDangerous catches common write buttons", () => {
  for (const t of ["Pay now", "Submit", "Confirm", "Edit", "Remove vehicle", "Add driver", "Log out", "Go paperless"]) {
    assert.equal(isDangerous(t), true, t);
  }
  for (const t of ["Declarations Page", "View policy", "Download", "Documents"]) {
    assert.equal(isDangerous(t), false, t);
  }
});

test("request guard: reads pass, writes to payment/change endpoints fail", () => {
  assert.equal(shouldBlockRequest("GET", "https://a.com/pay/now"), false);
  assert.equal(shouldBlockRequest("PUT", "https://a.com/api/anything"), true);
  assert.equal(shouldBlockRequest("DELETE", "https://a.com/api/anything"), true);
  assert.equal(shouldBlockRequest("PATCH", "https://a.com/api/anything"), true);
  assert.equal(shouldBlockRequest("POST", "https://a.com/api/payments/submit"), true);
  assert.equal(shouldBlockRequest("POST", "https://a.com/api/policy/endorsement"), true);
  assert.equal(shouldBlockRequest("POST", "https://a.com/api/preferences/paperless"), true);
  assert.equal(shouldBlockRequest("POST", "https://a.com/graphql"), false);
  assert.equal(shouldBlockRequest("POST", "https://a.com/api/documents/search"), false);
});

test("sender check: only listed domains and their subdomains", () => {
  const lm = ["libertymutual.com"];
  assert.equal(senderAllowed("noreply@libertymutual.com", lm), true);
  assert.equal(senderAllowed("Liberty <alerts@email.libertymutual.com>", lm), true);
  assert.equal(senderAllowed("x@libertymutual.com.evil.io", lm), false);
  assert.equal(senderAllowed("x@notlibertymutual.com", lm), false);
  assert.equal(senderAllowed("friend@gmail.com", lm), false);
  assert.equal(senderAllowed("", lm), false);
  assert.equal(emailDomain("A <b@Selective.COM>"), "selective.com");
});

test("login code extraction", () => {
  assert.equal(extractLoginCode("Your verification code", "Your one-time code is 482913. It expires in 10 minutes."), "482913");
  assert.equal(extractLoginCode("Selective login", "Security code: 5521"), "5521");
  assert.equal(extractLoginCode("Your code: 739204", ""), "739204");
  assert.equal(extractLoginCode("Sign in", "Use 902118 to finish signing in."), "902118");
  // Two candidates and no keyword: refuse to guess.
  assert.equal(extractLoginCode("Hello", "Call 555123 or 555124"), null);
  assert.equal(extractLoginCode("Hello", "No digits here"), null);
});

test("Drive path and file name cleaning", () => {
  assert.deepEqual(splitDrivePath("My Drive/Insurance/Liberty Mutual/"), ["Insurance", "Liberty Mutual"]);
  assert.deepEqual(splitDrivePath("Insurance\\2026"), ["Insurance", "2026"]);
  assert.throws(() => splitDrivePath("Insurance/../Secrets"));
  assert.equal(safeFileName('Selective - Dec: "Home" / 2026'), "Selective - Dec Home 2026");
});

test("navigation URLs stay on the carrier's site and off write paths", () => {
  const d = ["selective.com"];
  assert.equal(isSafeNavigationUrl("https://customer.selective.com/apps/policy/123", d), true);
  assert.equal(isSafeNavigationUrl("https://customer.selective.com/apps/billing/pay", d), false);
  assert.equal(isSafeNavigationUrl("https://evil.com/selective.com", d), false);
  assert.equal(isSafeNavigationUrl("http://customer.selective.com/apps/policy", d), false);
  assert.equal(isSafeNavigationUrl("https://customer.selective.com/logout", d), false);
});

test("real carrier senders pass; look-alikes of them fail", () => {
  const foremost = ["foremost.com"];
  const liberty = ["libertymutual.com"];
  const selective = ["selective.com"];
  assert.equal(senderAllowed("AccountVerification@underwritingalerts.selective.com", selective), true);
  assert.equal(senderAllowed("Selective <AccountVerification@underwritingalerts.selective.com>", selective), true);
  assert.equal(senderAllowed("DoNotReply@libertymutual.com", liberty), true);
  assert.equal(senderAllowed("x@policy.foremost.com", foremost), true);
  assert.equal(senderAllowed("x@payments.foremost.com", foremost), true);
  for (const fake of [
    "AccountVerification@underwritingalerts.selective.com.evil.io",
    "AccountVerification@underwritingalerts-selective.com",
    "AccountVerification@notselective.com",
    "AccountVerification@selective.com-alerts.net",
    "AccountVerification@underwritingalerts.selective.co",
    "x@selectivecom.net",
  ]) {
    assert.equal(senderAllowed(fake, selective), false, fake);
  }
  assert.equal(senderAllowed("DoNotReply@libertymutual.co", liberty), false);
  assert.equal(senderAllowed("x@policy.foremost.com.attacker.org", foremost), false);
  assert.equal(senderAllowed("x@myforemost.com", foremost), false);
  // A carrier's domain is never accepted for another carrier.
  assert.equal(senderAllowed("AccountVerification@underwritingalerts.selective.com", liberty), false);
});
