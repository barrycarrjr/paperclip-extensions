ALTER TABLE plugin_customer_support_0c69412611.support_messages
  ADD COLUMN automation_eligible boolean NOT NULL DEFAULT false;
CREATE TABLE plugin_customer_support_0c69412611.support_ticket_jobs (
  company_id uuid NOT NULL,
  case_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  policy_hash text NOT NULL,
  latest_message_id uuid NOT NULL,
  latest_message_at timestamptz NOT NULL,
  wake_message_id uuid,
  issue_id uuid,
  run_id uuid,
  dispatch_generation integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','investigating','waiting_requester','awaiting_approval','needs_operator','vendor_escalation','resolved')),
  target_address text,
  lease_token uuid,
  lease_until timestamptz,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,case_id),
  FOREIGN KEY(company_id,case_id) REFERENCES plugin_customer_support_0c69412611.support_cases(company_id,id)
);
ALTER TABLE plugin_customer_support_0c69412611.support_outbound ADD COLUMN policy_authorization jsonb;
