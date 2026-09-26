import { test } from "node:test";
import { strict as assert } from "node:assert";
import { PROOF_REQUIRED_STATUS, STATUS_VALUES, type StatusField } from "./domain.js";
import {
  checkFilingStatusChange,
  checkStatusChange,
  isZeroRevenueOnlyReason,
  type DocLookup,
  type FilingStatusInput,
} from "./guards.js";
import { RecordsError } from "./validate.js";

const BUSINESS = "11111111-1111-4111-8111-111111111111";
const OTHER_BUSINESS = "22222222-2222-4222-8222-222222222222";
const DOC_ID = "33333333-3333-4333-8333-333333333333";

const CURRENT_DOC: DocLookup = { id: DOC_ID, business_id: BUSINESS, replaced_by: null };
const OTHER_BUSINESS_DOC: DocLookup = { id: DOC_ID, business_id: OTHER_BUSINESS, replaced_by: null };
const REPLACED_DOC: DocLookup = { id: DOC_ID, business_id: BUSINESS, replaced_by: "44444444-4444-4444-8444-444444444444" };

function codeOf(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof RecordsError ? err.code : "NOT_A_RECORDS_ERROR";
  }
}

// ---- Rule 1: statuses that need proof ----

const PROOF_CASES: Array<[StatusField, string]> = [
  ["legal", "active"],
  ["legal", "dissolved"],
  ["tax_account", "open"],
  ["tax_account", "final_return_filed"],
  ["tax_account", "account_closed"],
];

test("the proof-only list is exactly the five values the design names", () => {
  const listed = (Object.keys(PROOF_REQUIRED_STATUS) as StatusField[]).flatMap((f) =>
    PROOF_REQUIRED_STATUS[f].map((v) => `${f}:${v}`),
  );
  assert.deepEqual(listed.sort(), PROOF_CASES.map(([f, v]) => `${f}:${v}`).sort());
});

for (const [field, value] of PROOF_CASES) {
  for (const kind of ["user_reported", "agent_inference"]) {
    test(`${field} ${value} is refused from a ${kind} source`, () => {
      assert.equal(
        codeOf(() =>
          checkStatusChange({ field, value, businessId: BUSINESS, source: { kind, documentId: DOC_ID }, doc: CURRENT_DOC }),
        ),
        "EPROOF_REQUIRED",
      );
    });
  }

  test(`${field} ${value} is refused from a document source with no documentId`, () => {
    assert.equal(
      codeOf(() => checkStatusChange({ field, value, businessId: BUSINESS, source: { kind: "document" }, doc: null })),
      "EPROOF_REQUIRED",
    );
  });

  test(`${field} ${value} is refused when the document does not exist in this company`, () => {
    assert.equal(
      codeOf(() =>
        checkStatusChange({ field, value, businessId: BUSINESS, source: { kind: "document", documentId: DOC_ID }, doc: null }),
      ),
      "EPROOF_REQUIRED",
    );
  });

  test(`${field} ${value} is refused when the document belongs to another business`, () => {
    assert.equal(
      codeOf(() =>
        checkStatusChange({
          field,
          value,
          businessId: BUSINESS,
          source: { kind: "external_confirmation", documentId: DOC_ID },
          doc: OTHER_BUSINESS_DOC,
        }),
      ),
      "EPROOF_REQUIRED",
    );
  });

  test(`${field} ${value} is refused when the document has been replaced`, () => {
    assert.equal(
      codeOf(() =>
        checkStatusChange({ field, value, businessId: BUSINESS, source: { kind: "document", documentId: DOC_ID }, doc: REPLACED_DOC }),
      ),
      "EPROOF_REQUIRED",
    );
  });

  for (const kind of ["document", "external_confirmation"]) {
    test(`${field} ${value} is allowed from a ${kind} source citing a current document of the same business`, () => {
      assert.equal(
        codeOf(() =>
          checkStatusChange({ field, value, businessId: BUSINESS, source: { kind, documentId: DOC_ID }, doc: CURRENT_DOC }),
        ),
        null,
      );
    });
  }
}

test("every other status value can be set from a user report or an agent inference", () => {
  for (const field of Object.keys(STATUS_VALUES) as StatusField[]) {
    for (const value of STATUS_VALUES[field]) {
      if (PROOF_REQUIRED_STATUS[field].includes(value)) continue;
      for (const kind of ["user_reported", "agent_inference"]) {
        assert.equal(
          codeOf(() => checkStatusChange({ field, value, businessId: BUSINESS, source: { kind }, doc: null })),
          null,
          `${field} ${value} from ${kind}`,
        );
      }
    }
  }
});

test("ceased operating and dissolution filed do not need proof (ceased is not dissolved)", () => {
  assert.equal(
    codeOf(() => checkStatusChange({ field: "operating", value: "ceased", businessId: BUSINESS, source: { kind: "user_reported" }, doc: null })),
    null,
  );
  assert.equal(
    codeOf(() =>
      checkStatusChange({ field: "legal", value: "dissolution_filed", businessId: BUSINESS, source: { kind: "user_reported" }, doc: null }),
    ),
    null,
  );
});

test("a value that belongs to another status field is refused", () => {
  assert.equal(
    codeOf(() => checkStatusChange({ field: "operating", value: "dissolved", businessId: BUSINESS, source: { kind: "document", documentId: DOC_ID }, doc: CURRENT_DOC })),
    "EINVALID_INPUT",
  );
});

test("a document source for a non-proof value must still cite a real document", () => {
  assert.equal(
    codeOf(() => checkStatusChange({ field: "operating", value: "operating", businessId: BUSINESS, source: { kind: "document", documentId: DOC_ID }, doc: null })),
    "EDOCUMENT_NOT_FOUND",
  );
  assert.equal(
    codeOf(() => checkStatusChange({ field: "operating", value: "operating", businessId: BUSINESS, source: { kind: "document" }, doc: null })),
    "EINVALID_INPUT",
  );
});

// ---- Rule 2: filings ----

function filing(over: Partial<FilingStatusInput>): FilingStatusInput {
  return {
    status: "filed",
    businessId: BUSINESS,
    dueDate: "2026-03-15",
    proofDocumentId: null,
    proofDoc: null,
    extendedDueDate: null,
    reason: null,
    source: null,
    sourceDoc: null,
    hasNextPeriod: false,
    ...over,
  };
}

for (const status of ["filed", "accepted", "extension_filed"] as const) {
  test(`filing ${status} is refused without a proof document`, () => {
    assert.equal(codeOf(() => checkFilingStatusChange(filing({ status, extendedDueDate: status === "extension_filed" ? "2026-09-15" : null }))), "EPROOF_REQUIRED");
  });
  test(`filing ${status} is refused when the proof document is missing, another business's, or replaced`, () => {
    for (const proofDoc of [null, OTHER_BUSINESS_DOC, REPLACED_DOC]) {
      assert.equal(
        codeOf(() =>
          checkFilingStatusChange(
            filing({ status, proofDocumentId: DOC_ID, proofDoc, extendedDueDate: status === "extension_filed" ? "2026-09-15" : null }),
          ),
        ),
        "EPROOF_REQUIRED",
      );
    }
  });
}

test("filed and accepted pass with a current proof document of the same business", () => {
  for (const status of ["filed", "accepted"] as const) {
    assert.equal(codeOf(() => checkFilingStatusChange(filing({ status, proofDocumentId: DOC_ID, proofDoc: CURRENT_DOC }))), null);
  }
});

test("extension_filed needs an extended due date later than the original", () => {
  const base = { status: "extension_filed" as const, proofDocumentId: DOC_ID, proofDoc: CURRENT_DOC };
  assert.equal(codeOf(() => checkFilingStatusChange(filing(base))), "EINVALID_INPUT");
  assert.equal(codeOf(() => checkFilingStatusChange(filing({ ...base, extendedDueDate: "2026-03-15" }))), "EINVALID_INPUT");
  assert.equal(codeOf(() => checkFilingStatusChange(filing({ ...base, extendedDueDate: "2026-03-01" }))), "EINVALID_INPUT");
  assert.equal(codeOf(() => checkFilingStatusChange(filing({ ...base, extendedDueDate: "2026-09-15" }))), null);
});

test("an extended due date without the extension status is refused", () => {
  assert.equal(
    codeOf(() => checkFilingStatusChange(filing({ proofDocumentId: DOC_ID, proofDoc: CURRENT_DOC, extendedDueDate: "2026-09-15" }))),
    "EINVALID_INPUT",
  );
});

test("not_required needs a written reason", () => {
  assert.equal(
    codeOf(() => checkFilingStatusChange(filing({ status: "not_required", source: { kind: "official_guidance", url: "https://example.gov/rule" } }))),
    "EREASON_SOURCE_REQUIRED",
  );
  assert.equal(
    codeOf(() => checkFilingStatusChange(filing({ status: "not_required", reason: "   ", source: { kind: "official_guidance", url: "https://example.gov/rule" } }))),
    "EREASON_SOURCE_REQUIRED",
  );
});

test("not_required needs a source", () => {
  assert.equal(codeOf(() => checkFilingStatusChange(filing({ status: "not_required", reason: "Below the state filing threshold" }))), "EREASON_SOURCE_REQUIRED");
});

test("not_required refuses user_reported and agent_inference sources", () => {
  for (const kind of ["user_reported", "agent_inference", "external_confirmation"]) {
    assert.equal(
      codeOf(() =>
        checkFilingStatusChange(
          filing({ status: "not_required", reason: "Below the state filing threshold", source: { kind, url: "https://example.gov/rule" } }),
        ),
      ),
      "EREASON_SOURCE_REQUIRED",
      kind,
    );
  }
});

test("not_required needs a document on file or an https url", () => {
  const reason = "Below the state filing threshold";
  assert.equal(codeOf(() => checkFilingStatusChange(filing({ status: "not_required", reason, source: { kind: "official_guidance" } }))), "EREASON_SOURCE_REQUIRED");
  assert.equal(
    codeOf(() => checkFilingStatusChange(filing({ status: "not_required", reason, source: { kind: "official_guidance", url: "http://example.gov/rule" } }))),
    "EREASON_SOURCE_REQUIRED",
  );
  assert.equal(
    codeOf(() => checkFilingStatusChange(filing({ status: "not_required", reason, source: { kind: "professional_advice", documentId: DOC_ID }, sourceDoc: REPLACED_DOC }))),
    "EREASON_SOURCE_REQUIRED",
  );
  assert.equal(
    codeOf(() => checkFilingStatusChange(filing({ status: "not_required", reason, source: { kind: "official_guidance", url: "https://example.gov/rule" } }))),
    null,
  );
  assert.equal(
    codeOf(() => checkFilingStatusChange(filing({ status: "not_required", reason, source: { kind: "professional_advice", documentId: DOC_ID }, sourceDoc: CURRENT_DOC }))),
    null,
  );
});

test("zero revenue on its own is never a reason a filing is not required", () => {
  for (const reason of ["No revenue", "zero revenue this year.", "There was no income", "$0 sales"]) {
    assert.equal(isZeroRevenueOnlyReason(reason), true, reason);
    assert.equal(
      codeOf(() => checkFilingStatusChange(filing({ status: "not_required", reason, source: { kind: "professional_advice", url: "https://example.com/note" } }))),
      "EREASON_SOURCE_REQUIRED",
      reason,
    );
  }
  assert.equal(isZeroRevenueOnlyReason("No revenue, and the entity was dissolved before the period began per the CPA"), false);
});

test("nextPeriod is only allowed when marking filed or accepted", () => {
  assert.equal(codeOf(() => checkFilingStatusChange(filing({ status: "in_preparation", hasNextPeriod: true }))), "EINVALID_INPUT");
  assert.equal(codeOf(() => checkFilingStatusChange(filing({ proofDocumentId: DOC_ID, proofDoc: CURRENT_DOC, hasNextPeriod: true }))), null);
});

test("upcoming and in_preparation need nothing, and refuse proof or reason fields", () => {
  assert.equal(codeOf(() => checkFilingStatusChange(filing({ status: "upcoming" }))), null);
  assert.equal(codeOf(() => checkFilingStatusChange(filing({ status: "in_preparation" }))), null);
  assert.equal(codeOf(() => checkFilingStatusChange(filing({ status: "upcoming", proofDocumentId: DOC_ID, proofDoc: CURRENT_DOC }))), "EINVALID_INPUT");
  assert.equal(codeOf(() => checkFilingStatusChange(filing({ status: "upcoming", reason: "x" }))), "EINVALID_INPUT");
});
