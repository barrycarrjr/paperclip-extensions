CREATE TABLE plugin_customer_support_0c69412611.support_directory (
  id uuid NOT NULL,
  company_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('vendor','owner','equipment','route','brand','connection')),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 150),
  details jsonb NOT NULL CHECK(jsonb_typeof(details) = 'object'),
  history jsonb NOT NULL CHECK(jsonb_typeof(history) = 'array'),
  version integer NOT NULL DEFAULT 1 CHECK(version > 0),
  vendor_id uuid,
  owner_id uuid,
  equipment_id uuid,
  brand_id uuid,
  updated_by_user_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,id),
  FOREIGN KEY(company_id,vendor_id) REFERENCES plugin_customer_support_0c69412611.support_directory(company_id,id),
  FOREIGN KEY(company_id,owner_id) REFERENCES plugin_customer_support_0c69412611.support_directory(company_id,id),
  FOREIGN KEY(company_id,equipment_id) REFERENCES plugin_customer_support_0c69412611.support_directory(company_id,id),
  FOREIGN KEY(company_id,brand_id) REFERENCES plugin_customer_support_0c69412611.support_directory(company_id,id)
);
CREATE INDEX support_directory_company_kind_idx ON plugin_customer_support_0c69412611.support_directory(company_id,kind,name);
