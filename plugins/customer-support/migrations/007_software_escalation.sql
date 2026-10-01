-- Software reports become reviewed outbound drafts for a vendor support channel.
CREATE TABLE plugin_customer_support_0c69412611.support_escalations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  case_id uuid NOT NULL REFERENCES plugin_customer_support_0c69412611.support_cases (id),
  route_id text NOT NULL,
  product_name text NOT NULL,
  destination_kind text NOT NULL CHECK (destination_kind IN ('email', 'jira_form')),
  destination text NOT NULL,
  title text NOT NULL,
  evidence text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted')),
  external_ticket_ref text,
  reviewed_by_user_id text NOT NULL,
  submitted_by_user_id text,
  submitted_at timestamptz,
  activity_logged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, case_id)
);
