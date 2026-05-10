CREATE TABLE plugin_backup_tools_b0b416b59f.backups (
  id uuid PRIMARY KEY,
  archive_uuid uuid NOT NULL UNIQUE,
  cadence text NOT NULL,
  schedule_id text,
  status text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  size_bytes bigint,
  manifest_json jsonb,
  triggered_by_actor_id uuid,
  triggered_by_agent_id uuid,
  error_summary text
);

CREATE INDEX backups_started_at_idx ON plugin_backup_tools_b0b416b59f.backups (started_at DESC);

CREATE INDEX backups_cadence_status_idx ON plugin_backup_tools_b0b416b59f.backups (cadence, status, started_at DESC);

CREATE TABLE plugin_backup_tools_b0b416b59f.backup_destination_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  backup_id uuid NOT NULL REFERENCES plugin_backup_tools_b0b416b59f.backups(id) ON DELETE CASCADE,
  destination_id text NOT NULL,
  destination_kind text NOT NULL,
  status text NOT NULL,
  remote_key text,
  size_bytes bigint,
  upload_started_at timestamptz,
  upload_completed_at timestamptz,
  error_code text,
  error_message text
);

CREATE INDEX backup_destination_results_backup_id_idx ON plugin_backup_tools_b0b416b59f.backup_destination_results (backup_id);

CREATE INDEX backup_destination_results_dest_idx ON plugin_backup_tools_b0b416b59f.backup_destination_results (destination_id, status, upload_started_at DESC);

CREATE TABLE plugin_backup_tools_b0b416b59f.schedule_state (
  schedule_id text PRIMARY KEY,
  cadence text NOT NULL,
  next_run_after timestamptz NOT NULL,
  last_run_at timestamptz,
  last_run_status text,
  consecutive_failures integer NOT NULL DEFAULT 0
);

CREATE TABLE plugin_backup_tools_b0b416b59f.restore_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_destination_id text NOT NULL,
  source_archive_key text NOT NULL,
  archive_uuid uuid NOT NULL,
  conflict_mode text NOT NULL,
  status text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  triggered_by_actor_id uuid NOT NULL,
  rows_written_json jsonb,
  error_summary text
);

CREATE INDEX restore_runs_started_at_idx ON plugin_backup_tools_b0b416b59f.restore_runs (started_at DESC);
