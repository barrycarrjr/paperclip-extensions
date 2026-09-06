-- Where a reply came from ('human' from the Reviews page, 'agent' from the
-- reply tool, 'google' when the daily sync first sees a reply the plugin did
-- not post). Nullable and not backfilled: a reply synced before this column
-- existed has no known author, and the list says nothing rather than guessing.
ALTER TABLE plugin_gbp_reviews_6e35570847.reviews ADD COLUMN IF NOT EXISTS reply_source text;

-- One row per attempt to post a reply, written BEFORE the Google call so a
-- crash between the two leaves a 'posting' row that tells the truth instead
-- of nothing. idempotency_key is minted by the caller (the confirm panel, or
-- run:<runId>:<reviewId> for an agent) and reused on retry, so a double click,
-- a second tab or a lost response cannot post twice.
CREATE TABLE IF NOT EXISTS plugin_gbp_reviews_6e35570847.reply_posts (
  idempotency_key text PRIMARY KEY,
  review_name text NOT NULL,
  location_key text NOT NULL,
  company_id text NOT NULL,
  source text NOT NULL CHECK (source IN ('human', 'agent')),
  actor_user_id text,
  actor_agent_id text,
  actor_run_id text,
  reply_text text NOT NULL,
  previous_reply_text text,
  previous_reply_time text,
  status text NOT NULL CHECK (status IN ('posting', 'posted', 'failed', 'unknown')),
  google_update_time text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reply_posts_review ON plugin_gbp_reviews_6e35570847.reply_posts(review_name, created_at DESC);

-- Only one attempt may be in flight per review, whatever key it carries. This
-- is the one layer of the idempotency rule that also holds across two worker
-- processes and across a human and an agent trying at the same moment.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reply_posts_one_in_flight ON plugin_gbp_reviews_6e35570847.reply_posts(review_name) WHERE status = 'posting';
