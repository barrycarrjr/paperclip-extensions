ALTER TABLE plugin_customer_support_0c69412611.support_cases
  DROP CONSTRAINT support_cases_source_check;

ALTER TABLE plugin_customer_support_0c69412611.support_cases
  ADD CONSTRAINT support_cases_source_check
  CHECK (source IN ('slack', 'helpscout', 'email', 'whmcs', 'other'));
