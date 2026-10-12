-- One Clippy conversation per Slack DM conversation (workspace + channel), so
-- the operator's messages keep their context like the in-app drawer does.
CREATE TABLE plugin_slack_tools_92b3e80d25.inbound_dm_sessions (
  workspace_key text NOT NULL,
  channel_id text NOT NULL,
  slack_user_id text NOT NULL,
  chat_session_id text NOT NULL,
  last_ts text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_key, channel_id)
);
