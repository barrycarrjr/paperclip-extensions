ALTER TABLE plugin_customer_support_0c69412611.support_messages
  ADD COLUMN protected_source_ref uuid,
  ADD COLUMN source_protection_version integer NOT NULL DEFAULT 0;
CREATE INDEX support_messages_unprotected_idx
  ON plugin_customer_support_0c69412611.support_messages(company_id, occurred_at)
  WHERE source_protection_version = 0;
