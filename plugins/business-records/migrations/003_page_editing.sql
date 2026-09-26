-- Editing from the Corporate Operations page.
--
-- Documents can now be removed from the record. Removal is soft: the row
-- stays, so history and any old reference still resolve, but it no longer
-- shows or counts. The file itself stays on its issue.
--
-- History gains two kinds for the new actions.
--
-- Text written with HTML entities (an ampersand stored as the five
-- characters of its entity) is turned back into plain characters. Plugin
-- migrations may only hold DDL, so this is done by ALTER COLUMN TYPE with a
-- USING expression rather than an UPDATE. New input is cleaned in code.
-- Keep quote characters out of these comments.

ALTER TABLE plugin_business_records_95a607b2ab.business_documents
  ADD COLUMN removed_at timestamptz;

ALTER TABLE plugin_business_records_95a607b2ab.business_documents
  ADD COLUMN removed_reason text;

ALTER TABLE plugin_business_records_95a607b2ab.business_history
  DROP CONSTRAINT business_history_kind_check;

ALTER TABLE plugin_business_records_95a607b2ab.business_history
  ADD CONSTRAINT business_history_kind_check CHECK (kind IN (
    'status_change', 'filing_status_change', 'document_added', 'document_replaced',
    'business_created', 'business_updated', 'document_updated', 'document_removed'
  ));

ALTER TABLE plugin_business_records_95a607b2ab.business_documents
  ALTER COLUMN title TYPE text
  USING replace(replace(replace(replace(replace(title, '&lt;', '<'), '&gt;', '>'), '&quot;', chr(34)), '&#39;', chr(39)), '&amp;', '&');

ALTER TABLE plugin_business_records_95a607b2ab.business_documents
  ALTER COLUMN notes TYPE text
  USING replace(replace(replace(replace(replace(notes, '&lt;', '<'), '&gt;', '>'), '&quot;', chr(34)), '&#39;', chr(39)), '&amp;', '&');

ALTER TABLE plugin_business_records_95a607b2ab.businesses
  ALTER COLUMN notes TYPE text
  USING replace(replace(replace(replace(replace(notes, '&lt;', '<'), '&gt;', '>'), '&quot;', chr(34)), '&#39;', chr(39)), '&amp;', '&');

ALTER TABLE plugin_business_records_95a607b2ab.business_filings
  ALTER COLUMN notes TYPE text
  USING replace(replace(replace(replace(replace(notes, '&lt;', '<'), '&gt;', '>'), '&quot;', chr(34)), '&#39;', chr(39)), '&amp;', '&');
