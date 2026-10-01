CREATE TABLE plugin_customer_support_0c69412611.support_daily_summaries (
  company_id uuid NOT NULL,
  report_day date NOT NULL,
  timezone text NOT NULL,
  config_sha256 text NOT NULL,
  connection_id text NOT NULL,
  channel_id text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','not_sent','unknown')),
  external_reference text,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,report_day)
);
