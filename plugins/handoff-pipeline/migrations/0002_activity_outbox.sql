CREATE TABLE plugin_handoff_dcdb27ff5a.activity_outbox (
  company_id uuid NOT NULL,
  event_id text NOT NULL,
  event jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, event_id)
);
