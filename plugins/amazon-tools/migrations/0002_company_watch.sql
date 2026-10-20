-- Historical 0001 rows have no provable owner. Retain them unchanged.
CREATE TABLE plugin_amazon_d696b53491.watch_state_v2 (
  scope_id text NOT NULL, company_id text NOT NULL, account_key text NOT NULL,
  marketplace_id text NOT NULL, kind text NOT NULL,
  revision integer NOT NULL DEFAULT 0, complete boolean NOT NULL DEFAULT false,
  snapshots jsonb NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (scope_id, marketplace_id, kind)
);
CREATE TABLE plugin_amazon_d696b53491.watch_changes_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scope_id text NOT NULL,
  company_id text NOT NULL, marketplace_id text NOT NULL, sku text NOT NULL,
  asin text, kind text NOT NULL, field text NOT NULL, before jsonb, after jsonb,
  detected_at timestamptz NOT NULL
);
CREATE INDEX watch_changes_scope_time_idx ON plugin_amazon_d696b53491.watch_changes_v2 (scope_id, detected_at, id);
CREATE TABLE plugin_amazon_d696b53491.watch_runs_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scope_id text NOT NULL,
  company_id text NOT NULL, marketplace_id text NOT NULL, kind text NOT NULL,
  started_at timestamptz NOT NULL, finished_at timestamptz NOT NULL,
  ok boolean NOT NULL, listings integer NOT NULL, changes integer NOT NULL, note text NOT NULL
);
CREATE INDEX watch_runs_scope_time_idx ON plugin_amazon_d696b53491.watch_runs_v2 (scope_id, started_at);
