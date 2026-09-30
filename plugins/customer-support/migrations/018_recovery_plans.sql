ALTER TABLE plugin_customer_support_0c69412611.support_cases ADD UNIQUE(company_id,id);
CREATE TABLE plugin_customer_support_0c69412611.support_recovery_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL, case_id uuid NOT NULL, target_address text NOT NULL,
  case_review_version integer NOT NULL,
  script_sha256 text NOT NULL, verification_sha256 text NOT NULL,
  prior_state jsonb NOT NULL, recovery jsonb NOT NULL,
  created_by_user_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id,case_id,script_sha256,verification_sha256),
  FOREIGN KEY(company_id,case_id) REFERENCES plugin_customer_support_0c69412611.support_cases(company_id,id)
);
