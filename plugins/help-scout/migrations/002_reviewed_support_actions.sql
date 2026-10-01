CREATE TABLE plugin_help_scout_dcee45a1d3.reviewed_support_actions (
 id uuid PRIMARY KEY,company_id uuid NOT NULL,user_id text NOT NULL,chat_session_id text NOT NULL,
 account_key text NOT NULL,conversation_id text NOT NULL,kind text NOT NULL CHECK(kind IN ('reply','tags','assign')),
 resource_sha256 text NOT NULL,config_sha256 text NOT NULL,baseline_sha256 text NOT NULL,
 plan_sha256 text NOT NULL,plan jsonb NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','sending','accepted','not_sent','unknown','acknowledged')),
 reference text,verification jsonb,reconciliation jsonb,
 expires_at timestamptz NOT NULL,started_at timestamptz,finished_at timestamptz,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX reviewed_support_actions_one_uncertain_idx ON plugin_help_scout_dcee45a1d3.reviewed_support_actions(resource_sha256) WHERE status IN ('sending','unknown');
