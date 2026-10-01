ALTER TABLE plugin_customer_support_0c69412611.support_directory DROP CONSTRAINT support_directory_kind_check;
ALTER TABLE plugin_customer_support_0c69412611.support_directory ADD CONSTRAINT support_directory_kind_check CHECK(kind IN ('vendor','owner','equipment','route','brand','connection','file_root'));
