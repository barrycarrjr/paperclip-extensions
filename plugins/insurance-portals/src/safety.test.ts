import { test } from "node:test";
import assert from "node:assert/strict";
import {
  currentTerm,
  emailDomain,
  findDate,
  policyAddresses,
  policyNumberIn,
  extractLoginCode,
  isDangerous,
  isDocumentLink,
  isNavigationLink,
  isPolicySelector,
  isReadOnlyLookup,
  isSafeNavigationUrl,
  namedDocument,
  streetAddressesIn,
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
  assert.equal(isNavigationLink("Policy documents policy documents for policy 1234567"), true);
  assert.equal(isDocumentLink("Policy documents policy documents for policy 1234567"), false, "a list page, not a document");
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

test("Foremost's policy menu counts as navigation; icon words are ignored", () => {
  assert.equal(isNavigationLink("Policies Select policy from dropdown"), true);
  assert.equal(isNavigationLink("Policies"), true);
  assert.equal(isNavigationLink("Select a policy"), true);
  assert.equal(isNavigationLink("Payments"), false);
  assert.equal(isNavigationLink("Policy change request"), false);
  assert.equal(isNavigationLink("My profile"), false);
});

test("PDF-marked list entries are documents; current term is kept", () => {
  assert.equal(isDocumentLink("RENEWAL 05/14/2026", "", true), true);
  assert.equal(isDocumentLink("RENEWAL 05/14/2026", "", false), false);
  assert.equal(isDocumentLink("Pay bill", "", true), false);
  assert.equal(isDocumentLink("View policy documents", "", true), false);
  const docs = [
    { text: "RENEWAL 05/14/2026" },
    { text: "RENEWAL 05/12/2025" },
    { text: "NEW BUSINESS 07/20/2024" },
    { text: "ENDORSEMENT 08/01/2026" },
    { text: "ENDORSEMENT 01/10/2026" },
  ];
  assert.deepEqual(currentTerm(docs).map((d) => d.text), ["RENEWAL 05/14/2026", "ENDORSEMENT 08/01/2026"]);
  assert.deepEqual(currentTerm([{ text: "NOTICE 01/02/2026" }, { text: "NOTICE 03/04/2026" }]).map((d) => d.text), ["NOTICE 03/04/2026"]);
  assert.equal(findDate("posted 6/9/2026"), "2026-06-09");
});

test("policy numbers are matched to the address shown with them", () => {
  const map = policyAddresses([
    "#100 - 1234567 Managed policies 12 Oak St policy number 1234567",
    "#100 - 7654321 Managed policies 900 W Elm Avenue policy number 7654321",
    "Pay bill for policy 1234567",
  ]);
  assert.deepEqual(map, { "1234567": "12 Oak St", "7654321": "900 W Elm Avenue" });
  assert.equal(policyNumberIn("policy documents for policy 1234567"), "1234567");
  assert.equal(policyNumberIn("Homepage"), null);
});

test("policy numbers with letters and dashes; phones and dates are not policy numbers", () => {
  assert.equal(policyNumberIn("View policy documents for H37-291-123456-40"), "H37-291-123456-40");
  assert.equal(policyNumberIn("Auto policy AOS2911234564 details"), "AOS2911234564");
  assert.equal(policyNumberIn("#100 - 4012345678 Rental Dwelling"), "4012345678");
  assert.equal(policyNumberIn("Call us at 555-010-0199"), null);
  assert.equal(policyNumberIn("Call 1-800-555-1212 today"), null);
  assert.equal(policyNumberIn("Posted 2026-05-14"), null);
  assert.equal(policyNumberIn("Card ending •••• 0000"), null);
  assert.deepEqual(policyAddresses(["Homeowners policy H37-291-123456-40 at 12 Oak St"]), { "H37-291-123456-40": "12 Oak St" });
});

test("Selective's table-style code email (made-up code)", () => {
  const body = [
    "| |", "| MySelective Password Reset |", "| |", "| MySelective |", "| One-Time Code |", "| |", "|   |",
    "| Here is the One-Time Code. |", "|   |", "| 7302 |", "|   |",
    "| This is a single use code that expires in 10 minutes. |", "|   |",
    "| If you did not request this code, please contact us immediately at 800-555-0100 [](18005550100) . |",
    "| Copyright 2025 Example Ins. Group, Inc., 1 Main Ave., Springfield, NJ 07000. |",
  ].join("\n");
  assert.equal(extractLoginCode("Here is Your MySelective One Time-Code", body), "7302");
  // A phone number or a year near the word "code" is never taken as the code.
  assert.equal(extractLoginCode("Code request", "If you did not request this code, call 800-555-0100."), null);
  assert.equal(extractLoginCode("Your code", "Code valid until 2026-05-14 only."), null);
});

test("Liberty Mutual 'View / print' buttons: named documents, never a settings change", () => {
  assert.equal(isDocumentLink("View / print Open your Renewal document in a new tab"), true);
  assert.equal(isDocumentLink("View / print Open your Policy change document in a new tab"), true);
  assert.equal(isDocumentLink("View / print Open proof of insurance for current policy period"), true);
  assert.equal(isDocumentLink("View / print"), false);
  assert.equal(isDocumentLink("Change how policy documents are sent"), false);
  assert.equal(isDocumentLink("Paperless settings Go to paperless settings"), false);
  assert.equal(isDocumentLink("Open your Renewal document and pay now in a new tab"), false);
  assert.equal(namedDocument("View / print Open your Policy change document in a new tab"), "Policy change");
  assert.equal(namedDocument("View / print Open proof of insurance for current policy period"), "Proof of insurance");
  assert.equal(namedDocument("View policy info"), null);
});

test("policy list control: 'Select another policy' yes, change or switch wording never", () => {
  assert.equal(isPolicySelector("Select another policy"), true);
  assert.equal(isPolicySelector("< Select another policy"), true);
  assert.equal(isPolicySelector("Choose a different policy"), true);
  assert.equal(isPolicySelector("Change policy"), false);
  assert.equal(isPolicySelector("Switch policy"), false);
  assert.equal(isPolicySelector("Select another policy to cancel"), false);
});

test("street addresses in capitals are recognised, lower-case words are not", () => {
  assert.deepEqual(streetAddressesIn("Policy OK0000001 12 TEST AVE"), ["12 TEST AVE"]);
  assert.deepEqual(streetAddressesIn("Billing account 70000000001 34 W 5TH ST"), ["34 W 5TH ST"]);
  assert.deepEqual(streetAddressesIn("call 3 times a day st"), []);
  assert.deepEqual(policyAddresses(["Policy OK0000002 34 SAMPLE ST"]), { OK0000002: "34 SAMPLE ST" });
});

test("no source file holds a stray control character (a broken '\\b' once disabled a date rule)", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const dir = new URL(".", import.meta.url);
  for (const f of (await readdir(dir)).filter((x) => x.endsWith(".ts"))) {
    const text = await readFile(new URL(f, dir), "utf8");
    assert.equal(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text), false, f);
  }
});

test("request guard: read-only Get lookups pass, anything that changes stays blocked", () => {
  const svc = "https://portal.example.com/services/Service3/";
  for (const name of ["GetBillPaySummary", "GetClaimsByPolicy", "GetScheduledPayments", "GetLastPayments", "GetNextPayments", "GetPolicyDocuments"]) {
    assert.equal(shouldBlockRequest("POST", svc + name), false, name);
  }
  for (const name of ["MakePayment", "SubmitClaim", "UpdatePaperless", "GetPayNow", "GetAndUpdatePolicy", "SchedulePayment", "CancelPolicy", "getpayment"]) {
    assert.equal(shouldBlockRequest("POST", svc + name), true, name);
  }
  assert.equal(isReadOnlyLookup("/services/Get"), false);
  assert.equal(shouldBlockRequest("PUT", svc + "GetBillPaySummary"), true);
  assert.equal(shouldBlockRequest("DELETE", svc + "GetPolicyDocuments"), true);
});
