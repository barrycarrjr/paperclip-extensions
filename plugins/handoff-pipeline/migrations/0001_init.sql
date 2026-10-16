-- State and the append-only event history commit together in one company row.
-- Optimistic versions protect concurrent reviews and idempotent run receipts.
CREATE TABLE plugin_handoff_dcdb27ff5a.pipeline_companies (
  company_id uuid PRIMARY KEY,
  version integer NOT NULL CHECK (version > 0),
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pipeline_company_matches CHECK (state->>'companyId' = company_id::text),
  CONSTRAINT pipeline_version_matches CHECK ((state->>'version')::integer = version)
);
