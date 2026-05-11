CREATE TABLE plugin_backup_tools_b0b416b59f.instance_keys (
  key_id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  key_hex text NOT NULL
);
