CREATE TABLE plugin_email_tools_7cbee3fdf3.support_delivery_receipts (
  company_id uuid NOT NULL,
  delivery_id uuid NOT NULL,
  content_sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending','sent','not_sent','unknown')),
  reference text,
  code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,delivery_id)
);
