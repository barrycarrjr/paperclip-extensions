-- Listing Watch: the latest snapshot of each listing, every change found
-- between two snapshots, and one row per scheduled check.
CREATE TABLE plugin_amazon_d696b53491.listing_snapshots (
  account_key text NOT NULL,
  marketplace_id text NOT NULL,
  sku text NOT NULL,
  kind text NOT NULL,
  asin text,
  data jsonb NOT NULL,
  taken_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_key, marketplace_id, sku, kind)
);

CREATE TABLE plugin_amazon_d696b53491.listing_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_key text NOT NULL,
  marketplace_id text NOT NULL,
  sku text NOT NULL,
  asin text,
  kind text NOT NULL,
  field text NOT NULL,
  before jsonb,
  after jsonb,
  detected_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX listing_changes_account_detected_idx
  ON plugin_amazon_d696b53491.listing_changes (account_key, detected_at);

CREATE TABLE plugin_amazon_d696b53491.listing_watch_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_key text NOT NULL,
  kind text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  ok boolean,
  listings integer,
  changes integer,
  note text
);
