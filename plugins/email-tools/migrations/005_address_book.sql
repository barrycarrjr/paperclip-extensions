CREATE TABLE plugin_email_tools_7cbee3fdf3.email_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  email text NOT NULL,
  name text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX email_contacts_company_email
  ON plugin_email_tools_7cbee3fdf3.email_contacts (company_id, email);

CREATE INDEX email_contacts_by_company
  ON plugin_email_tools_7cbee3fdf3.email_contacts (company_id);
