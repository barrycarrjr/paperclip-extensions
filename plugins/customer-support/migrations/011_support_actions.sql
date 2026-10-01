CREATE TABLE plugin_customer_support_0c69412611.support_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  case_id uuid NOT NULL REFERENCES plugin_customer_support_0c69412611.support_cases(id),
  case_review_version integer NOT NULL,
  target_address text NOT NULL,
  script_text text NOT NULL,
  script_sha256 text NOT NULL,
  verification_text text NOT NULL,
  verification_sha256 text NOT NULL,
  expected_effect text NOT NULL,
  recovery_notes text NOT NULL,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN (
    'proposed', 'approved', 'rejected', 'running', 'verified', 'repair_failed',
    'verification_failed', 'unknown'
  )),
  proposed_by_user_id text NOT NULL,
  approved_by_user_id text,
  approved_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  repair_run_id text,
  verification_run_id text,
  repair_exit_code integer,
  verification_exit_code integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id)
);

CREATE INDEX support_actions_case_idx
  ON plugin_customer_support_0c69412611.support_actions(company_id, case_id, created_at DESC);
