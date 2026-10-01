ALTER TABLE plugin_customer_support_0c69412611.support_directory DROP CONSTRAINT support_directory_kind_check;
ALTER TABLE plugin_customer_support_0c69412611.support_directory ADD CONSTRAINT support_directory_kind_check CHECK(kind IN ('vendor','owner','equipment','route','brand','connection','file_root','sync_check','preflight','storefront'));
CREATE TABLE plugin_customer_support_0c69412611.support_storefront_checks (
  company_id uuid NOT NULL,
  id uuid NOT NULL,
  profile_id uuid NOT NULL,
  profile_version integer NOT NULL,
  observations jsonb NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id),
  FOREIGN KEY(company_id,profile_id) REFERENCES plugin_customer_support_0c69412611.support_directory(company_id,id)
);
