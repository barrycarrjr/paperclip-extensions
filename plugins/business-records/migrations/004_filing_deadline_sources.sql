-- Existing dates keep their value and get an unknown basis, never inferred proof.
ALTER TABLE plugin_business_records_95a607b2ab.business_documents
  ADD CONSTRAINT business_documents_company_business_id_uq UNIQUE (company_id, business_id, id);

ALTER TABLE plugin_business_records_95a607b2ab.business_filings
  ADD COLUMN due_date_kind text NOT NULL DEFAULT 'unknown',
  ADD COLUMN due_date_source_document_id uuid,
  ADD COLUMN extended_due_date_kind text NOT NULL DEFAULT 'unknown',
  ADD COLUMN extended_due_date_source_document_id uuid,
  ADD CONSTRAINT filing_due_date_basis_check CHECK (
    (due_date_kind = 'statutory' AND due_date_source_document_id IS NOT NULL)
    OR (due_date_kind IN ('internal_planned', 'unknown') AND due_date_source_document_id IS NULL)
  ),
  ADD CONSTRAINT filing_extended_date_basis_check CHECK (
    (extended_due_date_kind = 'statutory' AND extended_due_date IS NOT NULL AND extended_due_date_source_document_id IS NOT NULL)
    OR (extended_due_date_kind IN ('internal_planned', 'unknown') AND extended_due_date_source_document_id IS NULL)
  ),
  ADD CONSTRAINT filing_due_date_source_fk FOREIGN KEY (company_id, business_id, due_date_source_document_id)
    REFERENCES plugin_business_records_95a607b2ab.business_documents (company_id, business_id, id),
  ADD CONSTRAINT filing_extended_date_source_fk FOREIGN KEY (company_id, business_id, extended_due_date_source_document_id)
    REFERENCES plugin_business_records_95a607b2ab.business_documents (company_id, business_id, id);

ALTER TABLE plugin_business_records_95a607b2ab.business_filings
  ALTER COLUMN due_date_kind DROP DEFAULT;
