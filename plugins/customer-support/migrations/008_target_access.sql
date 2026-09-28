-- Record where an IT or equipment case will be investigated, without storing credentials.
ALTER TABLE plugin_customer_support_0c69412611.support_cases
  ADD COLUMN target_address text,
  ADD COLUMN access_method text NOT NULL DEFAULT 'unknown'
    CHECK (access_method IN ('unknown', 'winrm', 'ssh', 'smb', 'rmm', 'local', 'other'));
