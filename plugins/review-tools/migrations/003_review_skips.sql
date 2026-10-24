-- "Don't reply": a person chose to leave this review unanswered, usually
-- because a reply months late would do more harm than none. skipped_at is
-- set by the Reviews page and cleared by "Reply after all", or by the sync
-- when the customer edits their review (it is then a different review from
-- the one the person decided about). A skipped review is not counted as
-- needing a reply, and the agent reply tool refuses it.
ALTER TABLE plugin_review_tools_5de9bb9335.reviews ADD COLUMN IF NOT EXISTS skipped_at timestamptz;
ALTER TABLE plugin_review_tools_5de9bb9335.reviews ADD COLUMN IF NOT EXISTS skipped_by_user_id text;

CREATE INDEX IF NOT EXISTS idx_reviews_needs_reply ON plugin_review_tools_5de9bb9335.reviews(location_key) WHERE reply_text IS NULL AND skipped_at IS NULL;
