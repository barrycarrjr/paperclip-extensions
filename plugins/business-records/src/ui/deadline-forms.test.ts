import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FilingForm, FilingStatusForm } from "./forms.js";
import { describeDue } from "./format.js";
import { readableError } from "./api.js";
import { filingToApi, type BusinessApi, type DocumentApi, type FilingRow } from "../domain.js";

const business = { id: "business-1" } as BusinessApi;
const documents = [{ id: "deadline-source", title: "Official deadline instructions", docType: "government_notice" }, { id: "filing-proof", title: "Extension submitted", docType: "extension_confirmation" }] as DocumentApi[];
const noop = () => {};
const filing = filingToApi({ id: "filing-1", business_id: business.id, filing: "Annual filing", authority: "Example", period_label: "2026", due_date: "2026-10-01",
  due_date_kind: "statutory", due_date_source_document_id: "deadline-source", extended_due_date: "2027-01-01", extended_due_date_kind: "statutory", extended_due_date_source_document_id: "deadline-source",
  proof_document_id: "filing-proof", status: "extension_filed", created_at: "2026-01-01", updated_at: "2026-01-01" } as FilingRow);

test("the actual filing form requires explicit classification and offers same-business document sources", () => {
  const fresh = renderToStaticMarkup(createElement(FilingForm, { companyId: "company-1", business, documents, onSaved: noop, onCancel: noop }));
  assert.match(fresh, /Choose a date basis/);
  assert.match(fresh, /Internal planned date/);
  assert.match(fresh, /Statutory deadline/);
  assert.doesNotMatch(fresh, /value="unknown"/);
  const edit = renderToStaticMarkup(createElement(FilingForm, { companyId: "company-1", business, documents, filing, onSaved: noop, onCancel: noop }));
  assert.match(edit, /Deadline source document/);
  assert.match(edit, /Official deadline instructions/);
  assert.match(edit, /value="deadline-source" selected/);
  const legacy = renderToStaticMarkup(createElement(FilingForm, { companyId: "company-1", business, documents, filing: { ...filing, dueDateKind: "unknown", dueDateSourceDocumentId: null }, onSaved: noop, onCancel: noop }));
  assert.match(legacy, /Legacy date, basis unknown/);
  const replaced = renderToStaticMarkup(createElement(FilingForm, { companyId: "company-1", business, documents: [], filing, onSaved: noop, onCancel: noop }));
  assert.match(replaced, /Saved source, no longer current/);
  assert.match(replaced, /value="deadline-source" selected/);
});

test("the actual extension form exposes independent submission proof and deadline source selections", () => {
  const markup = renderToStaticMarkup(createElement(FilingStatusForm, { companyId: "company-1", filing, documents, onSaved: noop, onCancel: noop }));
  assert.match(markup, /Proof on file/);
  assert.match(markup, /Extension deadline source document/);
  assert.match(markup, /value="filing-proof" selected/);
  assert.match(markup, /value="deadline-source" selected/);
  assert.match(markup, /does not claim a legal extension deadline/);
});

test("display and refusals distinguish statutory, internal and unknown dates without inventing evidence", () => {
  for (const [kind, label] of [["statutory", "Statutory deadline"], ["internal_planned", "Internal planned date"], ["unknown", "Legacy date, basis unknown"]] as const) {
    assert.match(describeDue({ ...filing, effectiveDueDateKind: kind }, "2026-10-01"), new RegExp(`^${label}:`));
  }
  const message = readableError("[EDEADLINE_SOURCE_REQUIRED] dueDateSourceDocumentId is required when saving a new statutory deadline.");
  assert.match(message, /deadline source document/i);
  assert.match(message, /Add the deadline source under Documents first/);
  assert.doesNotMatch(message, /dueDateSourceDocumentId|business_/);
});
