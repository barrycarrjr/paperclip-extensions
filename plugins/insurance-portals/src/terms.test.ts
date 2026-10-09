import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { pdfText } from "./pdfText.js";
import { assignTerms, existingFileFor, fileNameFor, findTerm, termFromName, toIso } from "./terms.js";

test("finds the policy period in the wordings declarations pages use", () => {
  assert.deepEqual(findTerm("Policy Period: 08/01/2026 to 08/01/2027 12:01 AM standard time"), { from: "2026-08-01", to: "2027-08-01" });
  assert.deepEqual(findTerm("POLICY PERIOD From 08/01/26 12:01 A.M. To 08/01/27"), { from: "2026-08-01", to: "2027-08-01" });
  assert.deepEqual(findTerm("Policy Term 9/5/2024 - 9/5/2025"), { from: "2024-09-05", to: "2025-09-05" });
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
    { policy: P, title: "RENEWAL", posted: "2026-06-29", term: { from: "2026-08-01", to: "2027-08-01" } },
    { policy: P, title: "RENEWAL", posted: "2025-06-27", term: { from: "2025-08-01", to: "2026-08-01" } },
    { policy: P, title: "NEW BUSINESS", posted: "2024-09-05", term: { from: "2024-08-01", to: "2025-08-01" } },
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
      { policy: P, title: "RENEWAL", posted: "2026-06-29", term: null },
      { policy: P, title: "NOTICE", posted: "2026-06-29", term: null },
    ],
    "2026-10-09",
  );
  assert.deepEqual(out.map((d) => d.current), [true, true, false]);
});

test("no readable term dates anywhere: posted dates decide", () => {
  const P = "Policy 2";
  const out = assignTerms(
    [
      { policy: P, title: "RENEWAL", posted: "2026-06-29", term: null },
      { policy: P, title: "RENEWAL", posted: "2025-06-27", term: null },
      { policy: P, title: "NEW BUSINESS", posted: "2024-09-05", term: null },
    ],
    "2026-10-09",
  );
  assert.deepEqual(out.map((d) => d.current), [true, false, false]);
});

test("file names carry the term dates", () => {
  assert.equal(
    fileNameFor("Foremost", { policy: "12 Oak St - Policy 1234567", title: "RENEWAL", posted: "2026-06-29", term: { from: "2026-08-01", to: "2027-08-01" } }),
    "Foremost - 12 Oak St - Policy 1234567 - Term 2026-08-01 to 2027-08-01 - RENEWAL (posted 2026-06-29)",
  );
  assert.equal(fileNameFor("Selective", { policy: "", title: "Declarations Page", posted: null, term: null }), "Selective - Declarations Page");
});

test("Foremost declarations layout: dates side by side, far from the label", () => {
  const text =
    "FOREMOST BASICS DECLARATIONS PAGE POLICY NUMBER POLICY PERIOD BEGINNING YOUR POLICY IS SERVICED BY - - NON PARTICIPATING 100 1234567 03 100- 1234567 -02 09/05/26 09/05/27 12:01 A.M. STANDARD TIME OAK LLC";
  assert.deepEqual(findTerm(text), { from: "2026-09-05", to: "2027-09-05" });
  assert.equal(findTerm("Payment schedule 09/05/26 10/05/26 12:01 AM"), null, "a one-month pair is not a term");
});

test("already-saved documents are recognised by policy, document and posted date", () => {
  const names = [
    "Foremost - 12 Oak St - Policy 1234567 - Term 2026-09-05 to 2027-09-05 - RENEWAL (posted 2026-06-29).pdf",
    "Foremost - 12 Oak St - Policy 1234567 - RENEWAL (posted 2025-06-27) (2).pdf",
  ];
  const P = "12 Oak St - Policy 1234567";
  assert.equal(existingFileFor(names, "Foremost", { policy: P, title: "RENEWAL", posted: "2026-06-29" }), names[0]);
  assert.equal(existingFileFor(names, "Foremost", { policy: P, title: "RENEWAL", posted: "2025-06-27" }), null, "a name without term dates is fetched again");
  assert.equal(existingFileFor(names, "Foremost", { policy: P, title: "NEW BUSINESS", posted: "2024-09-05" }), null);
  assert.equal(existingFileFor(names, "Foremost", { policy: "9 Elm St - Policy 7654321", title: "RENEWAL", posted: "2026-06-29" }), null);
  assert.equal(existingFileFor(names, "Foremost", { policy: P, title: "RENEWAL", posted: null }), null, "no posted date: never assume");
  assert.deepEqual(termFromName(names[0]), { from: "2026-09-05", to: "2027-09-05" });
});
