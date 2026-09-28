-- Reviewed service routing is separate from the category supplied by a source form.
ALTER TABLE plugin_customer_support_0c69412611.support_cases
  ADD COLUMN service_domain text NOT NULL DEFAULT 'unclassified'
    CHECK (service_domain IN ('unclassified', 'software', 'it', 'equipment', 'shipping', 'production', 'facilities', 'general')),
  ADD COLUMN work_kind text NOT NULL DEFAULT 'unclassified'
    CHECK (work_kind IN ('unclassified', 'question', 'incident', 'bug', 'feature', 'task')),
  ADD COLUMN asset_ref text,
  ADD COLUMN order_ref text,
  ADD COLUMN vendor_ref text,
  ADD COLUMN resolution_summary text,
  ADD COLUMN reviewed_by_user_id text,
  ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN review_version integer NOT NULL DEFAULT 0;

CREATE INDEX support_cases_company_domain_idx
  ON plugin_customer_support_0c69412611.support_cases
  (company_id, service_domain, last_message_at DESC);
