CREATE TABLE plugin_customer_support_0c69412611.support_observations (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  directory_id uuid NOT NULL,
  directory_version integer NOT NULL,
  created_by_user_id text NOT NULL,
  chat_session_id text NOT NULL,
  provider text NOT NULL,
  request_sha256 text NOT NULL,
  request jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','available','unavailable','expired')),
  findings jsonb,
  observed_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(company_id,directory_id) REFERENCES plugin_customer_support_0c69412611.support_directory(company_id,id)
);
CREATE INDEX support_observations_company_idx ON plugin_customer_support_0c69412611.support_observations(company_id,created_at DESC);
