import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { pdfText } from "./pdfText.js";
import { assignTerms, documentRevision, existingFileFor, fileNameFor, findChangeEffective, findRevision, findTerm, termFromName, toIso } from "./terms.js";

test("finds the policy period in the wordings declarations pages use", () => {
  assert.deepEqual(findTerm("Policy Period: 08/01/2026 to 08/01/2027 12:01 AM standard time"), { from: "2026-08-01", to: "2027-08-01" });
  assert.deepEqual(findTerm("POLICY PERIOD From 08/01/26 12:01 A.M. To 08/01/27"), { from: "2026-08-01", to: "2027-08-01" });
  assert.deepEqual(findTerm("Policy Term 7/20/2024 - 7/20/2025"), { from: "2024-07-20", to: "2025-07-20" });
  assert.deepEqual(findTerm("Effective Date: 01/15/2026  Expiration Date: 01/15/2027"), { from: "2026-01-15", to: "2027-01-15" });
  assert.deepEqual(findTerm("Coverage period: March 3, 2026 through March 3, 2027"), { from: "2026-03-03", to: "2027-03-03" });
  assert.equal(findTerm("Your premium is due 08/01/2026."), null);
  assert.equal(findTerm("Policy Period: 08/01/2027 to 08/01/2026"), null, "backwards dates are refused");
  assert.equal(toIso("8/1/26"), "2026-08-01");
});

test("reads text out of a real PDF", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("DECLARATIONS", { x: 50, y: 700, font, size: 14 });
  page.drawText("Policy Period: 08/01/2026 to 08/01/2027", { x: 50, y: 680, font, size: 10 });
  const text = await pdfText(Buffer.from(await doc.save()));
  assert.deepEqual(findTerm(text), { from: "2026-08-01", to: "2027-08-01" });
  assert.equal(await pdfText(Buffer.from("%PDF-1.4 not really a pdf")), "", "a broken PDF gives no text, not an error");
});

test("sorts documents into current and prior terms", () => {
  const P = "12 Oak St - Policy 1234567";
  const docs = [
    { policy: P, title: "RENEWAL", posted: "2026-05-14", term: { from: "2026-08-01", to: "2027-08-01" } },
    { policy: P, title: "RENEWAL", posted: "2025-05-12", term: { from: "2025-08-01", to: "2026-08-01" } },
    { policy: P, title: "NEW BUSINESS", posted: "2024-07-20", term: { from: "2024-08-01", to: "2025-08-01" } },
    { policy: P, title: "ENDORSEMENT", posted: "2026-09-10", term: null },
    { policy: P, title: "ENDORSEMENT", posted: "2026-02-01", term: null },
  ];
  const out = assignTerms(docs, "2026-10-09");
  assert.deepEqual(
    out.map((d) => [d.title, d.term?.from ?? null, d.current]),
    [
      ["RENEWAL", "2026-08-01", true],
      ["RENEWAL", "2025-08-01", false],
      ["NEW BUSINESS", "2024-08-01", false],
      ["ENDORSEMENT", "2026-08-01", true],
      ["ENDORSEMENT", "2025-08-01", false],
    ],
  );
});

test("a renewal posted before its term starts, with no readable dates, still counts as current", () => {
  const P = "Policy 1";
  const out = assignTerms(
    [
      { policy: P, title: "DECLARATIONS", posted: "2026-07-01", term: { from: "2026-08-01", to: "2027-08-01" } },
      { policy: P, title: "RENEWAL", posted: "2026-06-18", term: null },
      { policy: P, title: "NOTICE", posted: "2026-06-18", term: null },
    ],
    "2026-10-09",
  );
  assert.deepEqual(out.map((d) => d.current), [true, true, false]);
});

test("no readable term dates anywhere: posted dates decide", () => {
  const P = "Policy 2";
  const out = assignTerms(
    [
      { policy: P, title: "RENEWAL", posted: "2026-05-14", term: null },
      { policy: P, title: "RENEWAL", posted: "2025-05-12", term: null },
      { policy: P, title: "NEW BUSINESS", posted: "2024-07-20", term: null },
    ],
    "2026-10-09",
  );
  assert.deepEqual(out.map((d) => d.current), [true, false, false]);
});

test("file names carry the term dates", () => {
  assert.equal(
    fileNameFor("Foremost", { policy: "12 Oak St - Policy 1234567", title: "RENEWAL", posted: "2026-05-14", term: { from: "2026-08-01", to: "2027-08-01" } }),
    "Foremost - 12 Oak St - Policy 1234567 - Term 2026-08-01 to 2027-08-01 - RENEWAL (posted 2026-05-14)",
  );
  assert.equal(fileNameFor("Selective", { policy: "", title: "Declarations Page", posted: null, term: null }), "Selective - Declarations Page");
});

test("Foremost declarations layout: dates side by side, far from the label", () => {
  const text =
    "FOREMOST BASICS DECLARATIONS PAGE POLICY NUMBER POLICY PERIOD BEGINNING YOUR POLICY IS SERVICED BY - - NON PARTICIPATING 100 1234567 03 100- 1234567 -02 07/20/26 07/20/27 12:01 A.M. STANDARD TIME OAK LLC";
  assert.deepEqual(findTerm(text), { from: "2026-07-20", to: "2027-07-20" });
  assert.equal(findTerm("Payment schedule 07/20/26 10/05/26 12:01 AM"), null, "a one-month pair is not a term");
});

test("already-saved documents are recognised by policy, document and posted date", () => {
  const names = [
    "Foremost - 12 Oak St - Policy 1234567 - Term 2026-07-20 to 2027-07-20 - RENEWAL (posted 2026-05-14).pdf",
    "Foremost - 12 Oak St - Policy 1234567 - RENEWAL (posted 2025-05-12) (2).pdf",
  ];
  const P = "12 Oak St - Policy 1234567";
  assert.equal(existingFileFor(names, "Foremost", { policy: P, title: "RENEWAL", posted: "2026-05-14" }), names[0]);
  assert.equal(existingFileFor(names, "Foremost", { policy: P, title: "RENEWAL", posted: "2025-05-12" }), null, "a name without term dates is fetched again");
  assert.equal(existingFileFor(names, "Foremost", { policy: P, title: "NEW BUSINESS", posted: "2024-07-20" }), null);
  assert.equal(existingFileFor(names, "Foremost", { policy: "9 Elm St - Policy 7654321", title: "RENEWAL", posted: "2026-05-14" }), null);
  assert.equal(existingFileFor(names, "Foremost", { policy: P, title: "RENEWAL", posted: null }), null, "no posted date: never assume");
  assert.deepEqual(termFromName(names[0]), { from: "2026-07-20", to: "2027-07-20" });
});

test("Liberty Mutual declarations: month names in capitals, labels before the dates", () => {
  assert.deepEqual(findTerm("DESCRIBED LOCATION: 12 TEST AVE POLICY PERIOD FROM: TO: MARCH 3 2026 MARCH 3 2027 MORTGAGEE: EXAMPLE BANK"), {
    from: "2026-03-03",
    to: "2027-03-03",
  });
  assert.deepEqual(findTerm("POLICY PERIOD FROM: MARCH 3 2025 TO: MARCH 3 2026 1ST MORTGAGEE"), { from: "2025-03-03", to: "2026-03-03" });
  assert.deepEqual(findTerm("POLICY PERIOD FROM: TO: CHANGED AS OF: MARCH 3 2026 MARCH 3 2027 APRIL 9 2026"), { from: "2026-03-03", to: "2027-03-03" });
  assert.equal(toIso("JUNE 30 2026"), "2026-06-30");
  assert.equal(toIso("TERM 30 2026"), null);
});

test("Liberty Mutual new policy: 'Coverage begins ... Coverage will expire' wording", () => {
  assert.deepEqual(
    findTerm(
      "OCCUPANCY: TENANT POLICY PERIOD: Coverage begins at the later of: (1) 12:01 AM on 05/02/2026; or (2) The time that the application for insurance is submitted and the policy is bound. No coverage is provided prior to the policy being bound. Coverage will expire at 12:01 AM on 05/02/2027. AGENT: EXAMPLE AGENCY",
    ),
    { from: "2026-05-02", to: "2027-05-02" },
  );
});

test("Selective declarations: dates side by side before the certificate's name", () => {
  assert.deepEqual(
    findTerm("JANE SAMPLE 12 TEST AVE ANYTOWN, PA 00000 H 0000001 03A PA 00-00000-00000 05/02/2026 05/02/2027 AGENT: BILL ACCT. NO.: 000 HOMEOWNERS CONTINUOUS RENEWAL CERTIFICATE EXAMPLE AGENCY 04/01/2026"),
    { from: "2026-05-02", to: "2027-05-02" },
  );
  // Two dates a year apart with no form name nearby are not taken.
  assert.equal(findTerm("Payment history 05/02/2026 05/02/2027 paid in full"), null);
});

test("Selective auto and umbrella declarations: dates followed by AGENT:", () => {
  assert.deepEqual(findTerm("JANE SAMPLE ANYTOWN, PA 00000 PCL0000001 03A PA 00-00000-00000 05/02/2026 05/02/2027 AGENT: BILL ACCT. NO.: 000 PERSONAL UMBRELLA POLICY"), {
    from: "2026-05-02",
    to: "2027-05-02",
  });
});

test("same-day endorsements are told apart by the form's revision code", () => {
  assert.equal(findRevision("JANE SAMPLE ANYTOWN, PA 00000 F 0000001 - 01D PA 00-00000-00000 03/30/2024 03/30/2025 AGENT:"), "01D");
  assert.equal(findRevision("H 0000002 03A PA 00-00000-00000 05/02/2026"), "03A");
  assert.equal(findRevision("Policy Period: 08/01/2026 to 08/01/2027"), null);
  const term = { from: "2024-03-30", to: "2025-03-30" };
  const name = fileNameFor("Selective", { policy: "Policy 0000001", title: "Endorsement", posted: "2024-03-30", term, revision: "01D" });
  assert.equal(name, "Selective - Policy 0000001 - Term 2024-03-30 to 2025-03-30 - Endorsement 01D (posted 2024-03-30)");
  // Already saved, with or without the code: not downloaded again.
  const d = { policy: "Policy 0000001", title: "Endorsement", posted: "2024-03-30" };
  assert.equal(existingFileFor([`${name}.pdf`], "Selective", d), `${name}.pdf`);
  const old = "Selective - Policy 0000001 - Term 2024-03-30 to 2025-03-30 - Endorsement (posted 2024-03-30).pdf";
  assert.equal(existingFileFor([old], "Selective", d), old);
  // A different document whose title ends the same way is not a match.
  assert.equal(existingFileFor(["Selective - Policy 0000001 - Term 2024-03-30 to 2025-03-30 - Auto Endorsement (posted 2024-03-30).pdf"], "Selective", d), null);
});

test("Liberty Mutual policy changes are told apart by the date each took effect", () => {
  const change = "We have made the following changes to your policy: - The following mortgage servicing company is replaced by: EXAMPLE BANK This change is effective May 20, 2026 . Please place this letter with your insurance policy.";
  assert.equal(findChangeEffective(change), "effective 2026-05-20");
  assert.equal(documentRevision("Policy change", change), "effective 2026-05-20");
  assert.equal(findChangeEffective("The following first mortgagee is deleted: EXAMPLE LLC These changes are effective February 20, 2026. Please place"), "effective 2026-02-20");
  // Selective's code wins where there is one; other documents get none.
  assert.equal(documentRevision("Endorsement", "F 0000001 - 01D PA 00-00000-00000 This change is effective May 20, 2026"), "01D");
  assert.equal(documentRevision("Renewal", change), null);
  const term = { from: "2026-03-30", to: "2027-03-30" };
  assert.equal(
    fileNameFor("Liberty Mutual", { policy: "12 TEST AVE - Policy OK0000001", title: "Policy change", posted: null, term, revision: "effective 2026-05-20" }),
    "Liberty Mutual - 12 TEST AVE - Policy OK0000001 - Term 2026-03-30 to 2027-03-30 - Policy change effective 2026-05-20",
  );
});
