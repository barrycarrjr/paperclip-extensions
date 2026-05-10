-- backup-tools v0.1.0 — initial schema.
-- Plugin-owned namespace (host derives the schema name from the plugin key).
-- All tables are inside the plugin's own namespace.

CREATE TABLE backups (
  id UUID PRIMARY KEY,
  archive_uuid UUID NOT NULL UNIQUE,
  cadence TEXT NOT NULL,                -- 'manual' | 'hourly' | 'daily' | 'weekly' | 'monthly'
  schedule_id TEXT,                      -- nullable for manual runs
  status TEXT NOT NULL,                  -- 'queued' | 'running' | 'succeeded' | 'failed' | 'partial'
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  size_bytes BIGINT,
  manifest_json JSONB,                   -- envelope, sans HMAC, for diagnostics
  triggered_by_actor_id UUID,
  triggered_by_agent_id UUID,
  error_summary TEXT
);
CREATE INDEX backups_started_at_idx ON backups (started_at DESC);
CREATE INDEX backups_cadence_status_idx ON backups (cadence, status, started_at DESC);

CREATE TABLE backup_destination_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  backup_id UUID NOT NULL REFERENCES backups(id) ON DELETE CASCADE,
  destination_id TEXT NOT NULL,
  destination_kind TEXT NOT NULL,
  status TEXT NOT NULL,                  -- 'queued' | 'uploading' | 'succeeded' | 'failed'
  remote_key TEXT,
  size_bytes BIGINT,
  upload_started_at TIMESTAMPTZ,
  upload_completed_at TIMESTAMPTZ,
  error_code TEXT,
  error_message TEXT
);
CREATE INDEX backup_destination_results_backup_id_idx ON backup_destination_results (backup_id);
CREATE INDEX backup_destination_results_dest_idx ON backup_destination_results (destination_id, status, upload_started_at DESC);

CREATE TABLE schedule_state (
  schedule_id TEXT PRIMARY KEY,
  cadence TEXT NOT NULL,
  next_run_after TIMESTAMPTZ NOT NULL,
  last_run_at TIMESTAMPTZ,
  last_run_status TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE restore_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_destination_id TEXT NOT NULL,
  source_archive_key TEXT NOT NULL,
  archive_uuid UUID NOT NULL,
  conflict_mode TEXT NOT NULL,
  status TEXT NOT NULL,                  -- 'preview' | 'running' | 'succeeded' | 'failed' | 'aborted'
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  triggered_by_actor_id UUID NOT NULL,
  rows_written_json JSONB,
  error_summary TEXT
);
CREATE INDEX restore_runs_started_at_idx ON restore_runs (started_at DESC);
