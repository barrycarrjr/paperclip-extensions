-- One Clippy conversation per Slack thread rather than per DM channel. A new
-- top-level DM starts a fresh conversation, and replies in its thread continue
-- it. Keyed by channel, every new message used to continue one long chat and
-- answer from its old context. Replaces inbound_dm_sessions, which is left in
-- place unused because plugin migrations cannot drop tables.
CREATE TABLE plugin_slack_tools_92b3e80d25.inbound_thread_sessions (
  workspace_key text NOT NULL,
  channel_id text NOT NULL,
  thread_ts text NOT NULL,
  slack_user_id text NOT NULL,
  chat_session_id text NOT NULL,
  last_ts text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_key, channel_id, thread_ts)
);
