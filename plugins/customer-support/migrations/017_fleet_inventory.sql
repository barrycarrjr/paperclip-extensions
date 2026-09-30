CREATE TABLE plugin_customer_support_0c69412611.support_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  identity_key text NOT NULL,
  identity_strength text NOT NULL CHECK(identity_strength IN ('windows_hardware','target_only')),
  identity_conflict boolean NOT NULL DEFAULT false,
  snapshot jsonb NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id,identity_key), UNIQUE(company_id,id)
);
CREATE TABLE plugin_customer_support_0c69412611.support_asset_aliases (
  company_id uuid NOT NULL,
  address text NOT NULL,
  asset_id uuid NOT NULL,
  source text NOT NULL CHECK(source IN ('authenticated_target','reported_name','reported_address')),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,address),
  FOREIGN KEY(company_id,asset_id) REFERENCES plugin_customer_support_0c69412611.support_assets(company_id,id)
);
ALTER TABLE plugin_customer_support_0c69412611.support_devices ADD COLUMN asset_id uuid;
ALTER TABLE plugin_customer_support_0c69412611.support_devices ADD FOREIGN KEY(company_id,asset_id)
  REFERENCES plugin_customer_support_0c69412611.support_assets(company_id,id);
CREATE TABLE plugin_customer_support_0c69412611.support_fleet_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
  user_id text NOT NULL, chat_session_id text NOT NULL, network_id text NOT NULL,
  discovery_at timestamptz NOT NULL, status text NOT NULL CHECK(status IN ('planning','active','completed','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id,id)
);
CREATE UNIQUE INDEX support_fleet_one_active_conversation ON plugin_customer_support_0c69412611.support_fleet_checks(company_id,user_id,chat_session_id) WHERE status IN ('planning','active');
CREATE TABLE plugin_customer_support_0c69412611.support_fleet_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, fleet_id uuid NOT NULL,
  ordinal integer NOT NULL, discovered_address text NOT NULL, target_address text,
  status text NOT NULL CHECK(status IN ('pending','running','succeeded','failed','skipped','interrupted')),
  reason text, case_id uuid REFERENCES plugin_customer_support_0c69412611.support_cases(id),
  asset_id uuid, result jsonb, started_at timestamptz, completed_at timestamptz,
  UNIQUE(fleet_id,ordinal),
  FOREIGN KEY(company_id,fleet_id) REFERENCES plugin_customer_support_0c69412611.support_fleet_checks(company_id,id),
  FOREIGN KEY(company_id,asset_id) REFERENCES plugin_customer_support_0c69412611.support_assets(company_id,id)
);
CREATE UNIQUE INDEX support_fleet_one_running ON plugin_customer_support_0c69412611.support_fleet_items(company_id,fleet_id) WHERE status='running';
