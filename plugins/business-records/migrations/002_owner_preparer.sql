-- Rename the preparer value for the business owner to a neutral owner.
--
-- Plugin migrations may only hold DDL, so existing rows are converted by
-- ALTER COLUMN TYPE with a USING expression rather than an UPDATE. The old
-- check is dropped first so the converted value is not refused, then the
-- new check is added. Keep quote characters out of these comments.

ALTER TABLE plugin_business_records_95a607b2ab.business_filings
  DROP CONSTRAINT business_filings_preparer_check;

ALTER TABLE plugin_business_records_95a607b2ab.business_filings
  ALTER COLUMN preparer TYPE text
  USING (CASE WHEN preparer = 'barry' THEN 'owner' ELSE preparer END);

ALTER TABLE plugin_business_records_95a607b2ab.business_filings
  ADD CONSTRAINT business_filings_preparer_check
  CHECK (preparer IS NULL OR preparer IN ('cpa', 'owner', 'agent_drafts', 'other'));
