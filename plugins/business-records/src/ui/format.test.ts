import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  allStatusesUnknown,
  attentionByBusiness,
  daysUntil,
  describeDue,
  describeHistory,
  describeRenewal,
  describeSource,
  dueTone,
  formatDate,
  formatDateTime,
  humanize,
  isFilingOverdue,
  legalStatusSummary,
  preparerLabel,
  relativeDays,
  renewalTone,
  roleLabel,
  sortFilingsByDue,
} from "./format.js";

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

test("dates read as words, and unparseable input is left alone", () => {
  assert.equal(formatDate("2026-10-19"), "Oct 19, 2026");
  assert.equal(formatDate("2026-01-05"), "Jan 5, 2026");
  assert.equal(formatDate(null), "");
  assert.equal(formatDate("soon"), "soon");
  assert.equal(formatDateTime(new Date(2026, 8, 26, 14, 4, 18)), "Sep 26, 2026, 2:04 PM");
  assert.equal(formatDateTime(new Date(2026, 0, 1, 0, 7)), "Jan 1, 2026, 12:07 AM");
  assert.equal(formatDateTime("not a date"), "not a date");
});

test("relative days use everyday words", () => {
  assert.equal(relativeDays("2026-09-26", TODAY), "today");
  assert.equal(relativeDays("2026-09-27", TODAY), "tomorrow");
  assert.equal(relativeDays("2026-09-25", TODAY), "yesterday");
  assert.equal(relativeDays("2026-10-19", TODAY), "in 23 days");
  assert.equal(relativeDays("2026-09-01", TODAY), "25 days ago");
});

test("due dates say how far away they are, and overdue open filings say so", () => {
  assert.equal(describeDue({ status: "upcoming", effectiveDueDate: "2026-10-19" }, TODAY), "Due Oct 19, 2026 (in 23 days)");
  assert.equal(describeDue({ status: "upcoming", effectiveDueDate: "2026-09-14" }, TODAY), "Due Sep 14, 2026 (12 days overdue)");
  assert.equal(describeDue({ status: "upcoming", effectiveDueDate: "2026-09-25" }, TODAY), "Due Sep 25, 2026 (1 day overdue)");
  assert.equal(describeDue({ status: "filed", effectiveDueDate: "2026-09-14" }, TODAY), "Due Sep 14, 2026 (12 days ago)");
  assert.equal(dueTone({ status: "upcoming", effectiveDueDate: "2026-09-14" }, TODAY), "bad");
  assert.equal(dueTone({ status: "upcoming", effectiveDueDate: "2026-10-03" }, TODAY), "warn");
  assert.equal(dueTone({ status: "upcoming", effectiveDueDate: "2026-10-04" }, TODAY), null);
  assert.equal(dueTone({ status: "filed", effectiveDueDate: "2026-09-14" }, TODAY), null);
  assert.equal(describeRenewal("2026-11-01", TODAY), "Renews Nov 1, 2026 (in 36 days)");
  assert.equal(describeRenewal("2026-09-01", TODAY), "Lapsed Sep 1, 2026 (25 days ago)");
});

test("labels are plain words, not raw keys", () => {
  assert.equal(roleLabel("case:notice"), "Notice");
  assert.equal(roleLabel("case:wind-down"), "Wind-down");
  assert.equal(roleLabel("records"), "Records");
  assert.equal(roleLabel("case:acquisition-review"), "Acquisition review");
  assert.equal(preparerLabel("cpa"), "CPA");
  assert.equal(preparerLabel("agent_drafts"), "agent drafts");
  assert.equal(preparerLabel(null), "");
  assert.deepEqual(legalStatusSummary("active"), { text: "Active", tone: "good" });
  assert.deepEqual(legalStatusSummary("unknown"), { text: "Status not yet proven", tone: "unknown" });
  assert.deepEqual(legalStatusSummary("not_yet_formed"), { text: "Not yet formed", tone: "warn" });
});

test("history rows read as sentences", () => {
  assert.equal(
    describeHistory({ kind: "business_created", field: null, oldValue: null, newValue: "Example Widgets LLC", asOf: null }),
    'Business record created for "Example Widgets LLC"',
  );
  assert.equal(
    describeHistory({ kind: "status_change", field: "legal", oldValue: "unknown", newValue: "active", asOf: "2026-09-20" }),
    "Legal status changed from unknown to active (as of Sep 20, 2026)",
  );
  assert.equal(
    describeHistory({ kind: "document_added", field: "government_notice", oldValue: null, newValue: "IRS notice", asOf: "2026-09-20" }),
    'Document added: "IRS notice" (government notice) (as of Sep 20, 2026)',
  );
  assert.equal(
    describeHistory({ kind: "document_replaced", field: "government_notice", oldValue: "IRS notice", newValue: "IRS notice", asOf: null }),
    '"IRS notice" replaced by a newer copy',
  );
  assert.equal(
    describeHistory({ kind: "document_replaced", field: null, oldValue: "Old", newValue: "New", asOf: null }),
    '"Old" replaced by "New"',
  );
  assert.equal(
    describeHistory({ kind: "filing_status_change", field: "Form 1120-S", oldValue: "upcoming", newValue: "filed", asOf: null }),
    '"Form 1120-S" moved from upcoming to filed',
  );
  assert.equal(
    describeHistory({ kind: "business_updated", field: "notes", oldValue: null, newValue: "Hello", asOf: null }),
    'Notes set to "Hello"',
  );
});

test("statuses can be collapsed when nothing is proven, and attention counts group by business", () => {
  const unknown = { value: "unknown", asOf: null, source: null };
  assert.equal(allStatusesUnknown({ statuses: { operating: unknown, legal: unknown, tax_account: unknown } }), true);
  assert.equal(
    allStatusesUnknown({ statuses: { operating: unknown, legal: { ...unknown, value: "active" }, tax_account: unknown } }),
    false,
  );
  assert.deepEqual(
    attentionByBusiness({
      overdueFilings: [{ businessId: "a" }, { businessId: "a" }],
      filingsDueSoon: [{ businessId: "b" }],
      documentsRenewingSoon: [{ businessId: "a" }],
    }),
    { a: { overdue: 2, dueSoon: 0, renewals: 1 }, b: { overdue: 0, dueSoon: 1, renewals: 0 } },
  );
});

test("page edits read plainly in the history", () => {
  assert.equal(
    describeHistory({ kind: "document_updated", field: "type, title", oldValue: "2025 P - L", newValue: "2025 Profit & Loss", asOf: null }),
    'Document "2025 P - L" renamed to "2025 Profit & Loss" (type, title)',
  );
  assert.equal(
    describeHistory({ kind: "document_updated", field: "renewal date", oldValue: "Lease", newValue: "Lease", asOf: null }),
    'Document "Lease" edited (renewal date)',
  );
  assert.equal(describeHistory({ kind: "document_removed", field: "other", oldValue: "Old copy", newValue: null, asOf: null }), 'Document removed: "Old copy"');
});

test("a new document's title starts from the file name, and the viewer knows what it can show", async () => {
  const { titleFromFilename } = await import("./forms.js");
  const { previewKind } = await import("./viewer.js");
  assert.equal(titleFromFilename("2025 P - L.pdf"), "2025 P - L");
  assert.equal(titleFromFilename("notes.v2.txt"), "notes.v2");
  assert.equal(titleFromFilename(null), "");
  assert.equal(previewKind("application/pdf"), "pdf");
  assert.equal(previewKind("image/png"), "image");
  assert.equal(previewKind("text/csv; charset=utf-8"), "text");
  assert.equal(previewKind("application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "none");
});

test("history written before input was cleaned shows plain characters, not HTML entities", () => {
  assert.equal(
    describeHistory({ kind: "document_added", field: "other", oldValue: null, newValue: "2025 Profit &amp; Loss", asOf: null }),
    'Document added: "2025 Profit & Loss" (other)',
  );
});

test("a refusal written for the agent reads plainly on the page", async () => {
  const { readableError } = await import("./api.js");
  const agentText =
    '[EPROOF_REQUIRED] legal status active can only be set from a document on file. A user_reported source cannot set it. Upload the proof (for example the state approval) to the business records issue, add it with business_add_document, then call again with source {kind: "document", documentId}.';
  assert.equal(
    readableError(agentText),
    "Legal status active can only be set from a document on file. Your own word cannot set it. Add the proof under Documents first, then choose it here.",
  );
  assert.equal(readableError("[EDOCUMENT_IN_USE] it is the proof for the filing X (2026)."), "It is the proof for the filing X (2026).");
  assert.equal(readableError("Request failed (500)"), "Request failed (500)");
});

test("a one-sentence refusal loses its tool name but keeps its meaning", async () => {
  const { readableError } = await import("./api.js");
  assert.equal(
    readableError(
      "[EPROOF_REQUIRED] status filed needs proofDocumentId: the filed return confirmation, the acceptance, or the extension confirmation, added first with business_add_document.",
    ),
    "Status filed needs the filed return confirmation, the acceptance, or the extension confirmation. Add the proof under Documents first, then choose it here.",
  );
});
