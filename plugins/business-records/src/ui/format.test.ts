import { test } from "node:test";
import { strict as assert } from "node:assert";
import { daysUntil, describeSource, humanize, isFilingOverdue, renewalTone, sortFilingsByDue } from "./format.js";

const TODAY = "2026-09-26";

test("renewal dates within 60 days are highlighted, lapsed ones marked, later ones plain", () => {
  assert.equal(renewalTone(null, TODAY), null);
  assert.equal(renewalTone("2026-09-25", TODAY), "bad");
  assert.equal(renewalTone("2026-09-26", TODAY), "warn");
  assert.equal(renewalTone("2026-11-25", TODAY), "warn");
  assert.equal(renewalTone("2026-11-26", TODAY), null);
});

test("a filing is overdue only when it is still open and past its effective due date", () => {
  assert.equal(isFilingOverdue({ status: "upcoming", effectiveDueDate: "2026-09-25" }, TODAY), true);
  assert.equal(isFilingOverdue({ status: "extension_filed", effectiveDueDate: "2026-09-25" }, TODAY), true);
  assert.equal(isFilingOverdue({ status: "upcoming", effectiveDueDate: TODAY }, TODAY), false);
  assert.equal(isFilingOverdue({ status: "filed", effectiveDueDate: "2026-01-01" }, TODAY), false);
  assert.equal(isFilingOverdue({ status: "not_required", effectiveDueDate: "2026-01-01" }, TODAY), false);
});

test("filings sort next due first", () => {
  const sorted = sortFilingsByDue([
    { filing: "B", effectiveDueDate: "2026-12-01" },
    { filing: "A", effectiveDueDate: "2026-10-01" },
    { filing: "C", effectiveDueDate: "2026-10-01" },
  ]);
  assert.deepEqual(sorted.map((f) => f.filing), ["A", "C", "B"]);
});

test("small display helpers", () => {
  assert.equal(humanize("final_return_filed"), "Final return filed");
  assert.equal(daysUntil("2026-10-06", TODAY), 10);
  assert.equal(describeSource(null, {}), "no source recorded");
  assert.equal(
    describeSource({ kind: "document", documentId: "d1" }, { d1: "Certificate of organization" }),
    'Document, "Certificate of organization"',
  );
});
