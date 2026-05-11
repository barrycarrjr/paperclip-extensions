CREATE TABLE plugin_email_tools_7cbee3fdf3.email_triaged (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  mailbox_key text NOT NULL,
  folder text NOT NULL,
  uid integer NOT NULL,
  uid_validity bigint NOT NULL,
  action text NOT NULL,
  triaged_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX email_triaged_lookup
  ON plugin_email_tools_7cbee3fdf3.email_triaged (mailbox_key, uid_validity, uid);

CREATE INDEX email_triaged_company
  ON plugin_email_tools_7cbee3fdf3.email_triaged (company_id, mailbox_key, folder);
