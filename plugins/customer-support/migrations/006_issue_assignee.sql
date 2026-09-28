-- A reviewed work item may name a company agent without starting a run automatically.
ALTER TABLE plugin_customer_support_0c69412611.support_issue_links
  ADD COLUMN assignee_agent_id uuid;
