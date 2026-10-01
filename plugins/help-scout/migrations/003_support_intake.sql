CREATE TABLE plugin_help_scout_dcee45a1d3.support_intake_routes (
 route_sha256 text PRIMARY KEY,company_id uuid NOT NULL,
 cursor_at timestamptz NOT NULL,pending_until timestamptz,pending_conversations jsonb NOT NULL DEFAULT '[]',pending_offset integer NOT NULL DEFAULT 0,
 lease_id uuid,lease_until timestamptz,last_error text,last_completed_at timestamptz,updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE plugin_help_scout_dcee45a1d3.support_intake_threads (
 route_sha256 text NOT NULL REFERENCES plugin_help_scout_dcee45a1d3.support_intake_routes(route_sha256),
 company_id uuid NOT NULL,conversation_id text NOT NULL,thread_id text NOT NULL,
 delivered_version integer NOT NULL DEFAULT 0,delivered_secret_ref uuid,
 pending_version integer,pending_secret_ref uuid,
 PRIMARY KEY(route_sha256,conversation_id,thread_id)
);
