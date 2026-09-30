ALTER TABLE plugin_customer_support_0c69412611.support_cases ADD COLUMN source_account_id text;
CREATE TABLE plugin_customer_support_0c69412611.support_outbound (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  case_id uuid NOT NULL REFERENCES plugin_customer_support_0c69412611.support_cases(id),
  case_review_version integer NOT NULL,
  provider text NOT NULL CHECK (provider IN ('slack-tools','email-tools')),
  account text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('slack_reply','vendor_email')),
  destination jsonb NOT NULL,
  body text NOT NULL,
  content_sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending','sent','not_sent','unknown')),
  created_by_user_id text NOT NULL,
  approved_by_user_id text,
  approved_at timestamptz,
  expires_at timestamptz,
  external_reference text,
  delivery_code text,
  retry_of_id uuid REFERENCES plugin_customer_support_0c69412611.support_outbound(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX support_outbound_draft_idx ON plugin_customer_support_0c69412611.support_outbound(company_id,case_id,case_review_version,content_sha256) WHERE retry_of_id IS NULL;
CREATE UNIQUE INDEX support_outbound_retry_idx ON plugin_customer_support_0c69412611.support_outbound(company_id,retry_of_id) WHERE retry_of_id IS NOT NULL;
