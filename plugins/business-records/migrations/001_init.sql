-- business-records initial schema.
--
-- The namespace name is derived by the host from the plugin key
-- (business-records) and the manifest namespaceSlug (business_records), as
-- plugin_<slug>_<first 10 hex of sha256(pluginKey)>. It is hardcoded here
-- because plugin migrations must use fully qualified names.
--
-- Every table carries company_id and every runtime query filters on it.
-- Keep quote characters out of these comments. The host validator strips
-- quoted strings before it strips comments, so a stray apostrophe here
-- would make it misread the statement.

CREATE TABLE plugin_business_records_95a607b2ab.businesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  other_names text[] NOT NULL DEFAULT '{}',
  relationship text NOT NULL CHECK (relationship IN ('owned', 'prospect', 'former', 'other')),
  legal_form text,
  formation_state text,
  registration_states text[] NOT NULL DEFAULT '{}',
  tax_classification text,
  tax_classification_effective date,
  linked_company_ids uuid[] NOT NULL DEFAULT '{}',
  contacts jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes text,
  tax_id_last4 char(4) CHECK (tax_id_last4 IS NULL OR tax_id_last4 ~ '^[0-9]{4}$'),
  operating_status text NOT NULL DEFAULT 'unknown'
    CHECK (operating_status IN ('not_yet_operating', 'operating', 'ceased', 'unknown')),
  operating_status_as_of date,
  operating_status_source jsonb,
  legal_status text NOT NULL DEFAULT 'unknown'
    CHECK (legal_status IN ('not_yet_formed', 'formation_filed', 'active', 'dissolution_filed', 'dissolved', 'unknown')),
  legal_status_as_of date,
  legal_status_source jsonb,
  tax_account_status text NOT NULL DEFAULT 'unknown'
    CHECK (tax_account_status IN ('not_yet_registered', 'open', 'final_return_filed', 'account_closed', 'unknown')),
  tax_account_status_as_of date,
  tax_account_status_source jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX businesses_company_name_uq
  ON plugin_business_records_95a607b2ab.businesses (company_id, lower(name));

CREATE TABLE plugin_business_records_95a607b2ab.business_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  business_id uuid NOT NULL REFERENCES plugin_business_records_95a607b2ab.businesses (id),
  doc_type text NOT NULL CHECK (doc_type IN (
    'articles_of_organization', 'certificate_of_organization', 'operating_agreement', 'bylaws',
    'tax_id_letter', 's_corp_election', 's_corp_acceptance', 'state_registration',
    'fictitious_name', 'license_or_permit', 'annual_report', 'insurance_certificate',
    'bank_resolution', 'tax_return', 'filing_confirmation', 'government_notice',
    'extension_confirmation', 'compliance_review', 'professional_advice', 'other'
  )),
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  issuing_body text,
  document_date date,
  renewal_date date,
  issue_id uuid NOT NULL,
  attachment_ref text,
  replaced_by uuid REFERENCES plugin_business_records_95a607b2ab.business_documents (id),
  idempotency_key text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX business_documents_business_idx
  ON plugin_business_records_95a607b2ab.business_documents (company_id, business_id);

-- Adding the same attachment twice as the same kind of document returns the
-- first row instead of creating a second one.
CREATE UNIQUE INDEX business_documents_attachment_uq
  ON plugin_business_records_95a607b2ab.business_documents (business_id, issue_id, doc_type, attachment_ref)
  WHERE attachment_ref IS NOT NULL;

CREATE UNIQUE INDEX business_documents_idempotency_uq
  ON plugin_business_records_95a607b2ab.business_documents (business_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE plugin_business_records_95a607b2ab.business_filings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  business_id uuid NOT NULL REFERENCES plugin_business_records_95a607b2ab.businesses (id),
  filing text NOT NULL CHECK (length(btrim(filing)) > 0),
  authority text NOT NULL CHECK (length(btrim(authority)) > 0),
  period_label text NOT NULL CHECK (length(btrim(period_label)) > 0),
  period_start date,
  period_end date,
  due_date date NOT NULL,
  extended_due_date date,
  preparer text CHECK (preparer IS NULL OR preparer IN ('cpa', 'barry', 'agent_drafts', 'other')),
  status text NOT NULL DEFAULT 'upcoming'
    CHECK (status IN ('upcoming', 'in_preparation', 'extension_filed', 'filed', 'accepted', 'not_required')),
  proof_document_id uuid REFERENCES plugin_business_records_95a607b2ab.business_documents (id),
  not_required_reason text,
  not_required_source jsonb,
  issue_id uuid,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row per filing per period. Rolling the calendar forward twice cannot
-- create a duplicate, because the second insert hits this index.
CREATE UNIQUE INDEX business_filings_period_uq
  ON plugin_business_records_95a607b2ab.business_filings (business_id, lower(filing), lower(authority), period_label);

CREATE INDEX business_filings_company_due_idx
  ON plugin_business_records_95a607b2ab.business_filings (company_id, due_date);

CREATE TABLE plugin_business_records_95a607b2ab.business_issue_links (
  company_id uuid NOT NULL,
  business_id uuid NOT NULL REFERENCES plugin_business_records_95a607b2ab.businesses (id),
  issue_id uuid NOT NULL,
  role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, issue_id)
);

CREATE INDEX business_issue_links_company_idx
  ON plugin_business_records_95a607b2ab.business_issue_links (company_id, business_id);

-- Append-only. The plugin never updates or deletes a history row.
-- subject_id names the filing or document a row is about (null for rows
-- about the business record itself).
CREATE TABLE plugin_business_records_95a607b2ab.business_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  business_id uuid NOT NULL REFERENCES plugin_business_records_95a607b2ab.businesses (id),
  kind text NOT NULL CHECK (kind IN (
    'status_change', 'filing_status_change', 'document_added', 'document_replaced',
    'business_created', 'business_updated'
  )),
  subject_id uuid,
  field text,
  old_value text,
  new_value text,
  as_of date,
  source jsonb,
  actor jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX business_history_business_idx
  ON plugin_business_records_95a607b2ab.business_history (company_id, business_id, created_at);
