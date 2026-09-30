CREATE UNIQUE INDEX support_cases_company_id_idx ON plugin_customer_support_0c69412611.support_cases(company_id,id);
CREATE TABLE plugin_customer_support_0c69412611.support_equipment_events (
  id uuid NOT NULL,
  company_id uuid NOT NULL,
  equipment_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('fault','consumable','service')),
  occurred_at timestamptz NOT NULL,
  code text NOT NULL,
  notes text NOT NULL,
  case_id uuid,
  content_sha256 text NOT NULL,
  recorded_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id),
  FOREIGN KEY(company_id,equipment_id) REFERENCES plugin_customer_support_0c69412611.support_directory(company_id,id),
  FOREIGN KEY(company_id,case_id) REFERENCES plugin_customer_support_0c69412611.support_cases(company_id,id)
);
CREATE INDEX support_equipment_events_recent_idx ON plugin_customer_support_0c69412611.support_equipment_events(company_id,equipment_id,occurred_at DESC);
