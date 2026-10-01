CREATE TABLE plugin_unifi_tools_206a16fd6c.restart_actions (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  user_id text NOT NULL,
  chat_session_id text NOT NULL,
  account_key text NOT NULL,
  site_id uuid NOT NULL,
  device_id uuid NOT NULL,
  resource_sha256 text NOT NULL,
  config_sha256 text NOT NULL,
  plan_sha256 text NOT NULL,
  plan jsonb NOT NULL,
  baseline jsonb NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','running','accepted','verified','not_sent','unknown','acknowledged')),
  expires_at timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  verification jsonb,
  reconciliation jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX restart_actions_one_unsettled_device_idx ON plugin_unifi_tools_206a16fd6c.restart_actions(resource_sha256) WHERE status IN ('running','accepted','unknown');
