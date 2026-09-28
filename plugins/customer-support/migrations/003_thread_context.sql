-- Keep source thread progress and attachment references in company-scoped cases.
ALTER TABLE plugin_customer_support_0c69412611.support_cases
  ADD COLUMN thread_checked_at timestamptz,
  ADD COLUMN thread_cursor_ts text;

ALTER TABLE plugin_customer_support_0c69412611.support_messages
  ADD COLUMN author_external_id text,
  ADD COLUMN attachments jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX support_cases_thread_scan_idx
  ON plugin_customer_support_0c69412611.support_cases
  (connection_id, thread_checked_at ASC NULLS FIRST, last_message_at DESC)
  WHERE source = 'slack';
