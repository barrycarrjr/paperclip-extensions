-- Review records synced from GBP API.
-- review_name is the full GBP resource name and serves as the stable PK.
CREATE TABLE IF NOT EXISTS plugin_gbp_reviews_6e35570847.reviews (
  review_name text PRIMARY KEY,
  location_key text NOT NULL,
  company_id text NOT NULL,
  reviewer_name text NOT NULL DEFAULT 'Anonymous',
  star_rating integer NOT NULL CHECK (star_rating BETWEEN 1 AND 5),
  review_text text,
  reply_text text,
  review_time text NOT NULL,
  reply_time text,
  paperclip_issue_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reviews_location ON plugin_gbp_reviews_6e35570847.reviews(location_key);
CREATE INDEX IF NOT EXISTS idx_reviews_company ON plugin_gbp_reviews_6e35570847.reviews(company_id);
CREATE INDEX IF NOT EXISTS idx_reviews_time ON plugin_gbp_reviews_6e35570847.reviews(review_time);
CREATE INDEX IF NOT EXISTS idx_reviews_unreplied ON plugin_gbp_reviews_6e35570847.reviews(location_key) WHERE reply_text IS NULL;
