CREATE TABLE plugin_customer_support_0c69412611.support_devices (
  company_id uuid NOT NULL,
  target_address text NOT NULL,
  snapshot jsonb NOT NULL,
  last_case_id uuid NOT NULL REFERENCES plugin_customer_support_0c69412611.support_cases(id),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,target_address)
);
CREATE TABLE plugin_customer_support_0c69412611.support_knowledge (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  title text NOT NULL,
  topic text NOT NULL,
  body text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('environment','procedure','verified_fix')),
  source_case_id uuid REFERENCES plugin_customer_support_0c69412611.support_cases(id),
  verified_action_id uuid REFERENCES plugin_customer_support_0c69412611.support_actions(id),
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_knowledge_company_idx ON plugin_customer_support_0c69412611.support_knowledge(company_id,created_at DESC);
