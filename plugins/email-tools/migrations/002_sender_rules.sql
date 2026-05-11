CREATE TABLE plugin_email_tools_7cbee3fdf3.email_sender_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  mailbox_key text NOT NULL,
  sender_pattern text NOT NULL,
  rule_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX email_sender_rules_lookup
  ON plugin_email_tools_7cbee3fdf3.email_sender_rules (company_id, mailbox_key, sender_pattern);

CREATE INDEX email_sender_rules_by_type
  ON plugin_email_tools_7cbee3fdf3.email_sender_rules (company_id, mailbox_key, rule_type);
