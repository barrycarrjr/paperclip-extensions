-- Rename the claimed_by value for the buyer to a neutral owner.
--
-- Plugin migrations may only hold DDL, so existing rows are converted by
-- ALTER COLUMN TYPE with a USING expression rather than an UPDATE. The old
-- check is dropped first so the converted value is not refused, then the
-- new check is added. Keep quote characters out of these comments.

ALTER TABLE plugin_deal_desk_bf83b73d01.earnings_adjustments
  DROP CONSTRAINT earnings_adjustments_claimed_by_check;

ALTER TABLE plugin_deal_desk_bf83b73d01.earnings_adjustments
  ALTER COLUMN claimed_by TYPE text
  USING (CASE WHEN claimed_by = 'barry' THEN 'owner' ELSE claimed_by END);

ALTER TABLE plugin_deal_desk_bf83b73d01.earnings_adjustments
  ADD CONSTRAINT earnings_adjustments_claimed_by_check
  CHECK (claimed_by IN ('seller', 'agent', 'owner', 'cpa', 'other'));
