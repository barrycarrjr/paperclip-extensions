-- One reviewed Paperclip issue may be created from each support case.
-- A lease prevents concurrent requests from creating duplicate host issues.
CREATE TABLE plugin_customer_support_0c69412611.support_issue_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  case_id uuid NOT NULL REFERENCES plugin_customer_support_0c69412611.support_cases (id),
  project_id uuid NOT NULL,
  issue_kind text NOT NULL CHECK (issue_kind IN ('bug', 'feature', 'followup')),
  title text NOT NULL,
  evidence text NOT NULL,
  issue_id uuid,
  lease_token uuid,
  lease_until timestamptz,
  activity_logged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, case_id)
);

CREATE UNIQUE INDEX support_issue_links_issue_uq
  ON plugin_customer_support_0c69412611.support_issue_links (company_id, issue_id)
  WHERE issue_id IS NOT NULL;
