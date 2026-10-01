CREATE TABLE plugin_customer_support_0c69412611.support_interactive_cases (
  case_id uuid PRIMARY KEY REFERENCES plugin_customer_support_0c69412611.support_cases(id),
  company_id uuid NOT NULL,
  user_id text NOT NULL,
  chat_session_id text NOT NULL,
  target_address text NOT NULL,
  delegated_until timestamptz,
  delegated_review_version integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE plugin_customer_support_0c69412611.support_diagnostics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  case_id uuid NOT NULL REFERENCES plugin_customer_support_0c69412611.support_cases(id),
  check_kind text NOT NULL,
  result jsonb NOT NULL,
  user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_diagnostics_case_idx ON plugin_customer_support_0c69412611.support_diagnostics(company_id, case_id, created_at DESC);
CREATE TABLE plugin_customer_support_0c69412611.support_interactive_attempts (
  company_id uuid NOT NULL,
  case_id uuid NOT NULL REFERENCES plugin_customer_support_0c69412611.support_cases(id),
  fingerprint text NOT NULL,
  review_version integer NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,case_id,fingerprint)
);
CREATE UNIQUE INDEX support_interactive_one_pending_idx
  ON plugin_customer_support_0c69412611.support_interactive_attempts(company_id,case_id,review_version)
  WHERE result IS NULL;
