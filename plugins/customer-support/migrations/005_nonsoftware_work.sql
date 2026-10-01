-- IT, equipment, and operational issues need not be tied to a code project.
ALTER TABLE plugin_customer_support_0c69412611.support_issue_links
  ALTER COLUMN project_id DROP NOT NULL;
