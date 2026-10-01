ALTER TABLE plugin_customer_support_0c69412611.support_escalations DROP CONSTRAINT support_escalations_destination_kind_check;
ALTER TABLE plugin_customer_support_0c69412611.support_escalations ADD CONSTRAINT support_escalations_destination_kind_check CHECK(destination_kind IN ('email','jira_form','built_in'));
ALTER TABLE plugin_customer_support_0c69412611.support_directory DROP CONSTRAINT support_directory_kind_check;
ALTER TABLE plugin_customer_support_0c69412611.support_directory ADD CONSTRAINT support_directory_kind_check CHECK(kind IN ('vendor','owner','equipment','route','brand','connection','file_root','sync_check','preflight'));
CREATE TABLE plugin_customer_support_0c69412611.support_preflight_results (
  company_id uuid NOT NULL,
  id uuid NOT NULL,
  profile_id uuid NOT NULL,
  profile_version integer NOT NULL,
  software_name text NOT NULL,
  file_reference text NOT NULL,
  provider_report_reference text NOT NULL,
  checked_at timestamptz NOT NULL,
  findings jsonb NOT NULL,
  content_sha256 text NOT NULL,
  recorded_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id),
  FOREIGN KEY(company_id,profile_id) REFERENCES plugin_customer_support_0c69412611.support_directory(company_id,id)
);
