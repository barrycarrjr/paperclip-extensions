-- Retains sender address, subject (200 chars), free-form note (300 chars, possibly mail content),
-- Message-ID and routing identity indefinitely. Terminal tombstones prevent duplicate routing.
CREATE TABLE IF NOT EXISTS plugin_email_tools_7cbee3fdf3.email_routing (
  id uuid PRIMARY KEY,
  mailbox_key text NOT NULL,
  message_key text NOT NULL,
  source_company_id uuid NOT NULL,
  mailbox_binding text NOT NULL,
  folder text NOT NULL,
  uid bigint NOT NULL,
  uid_validity text NOT NULL,
  message_id text,
  status text NOT NULL CHECK (status IN ('claimed', 'routed', 'waiting', 'dismissed', 'handled')),
  claim_token uuid,
  claimed_at timestamptz,
  attempt_started boolean NOT NULL DEFAULT false,
  destination jsonb,
  actor jsonb NOT NULL,
  sender text NOT NULL DEFAULT '',
  subject text NOT NULL DEFAULT '',
  received_at text NOT NULL DEFAULT '',
  candidate_keys jsonb NOT NULL DEFAULT '[]',
  note text NOT NULL DEFAULT '',
  issue_id uuid,
  issue_identifier text,
  handoff_origin_id text,
  wake_state text NOT NULL DEFAULT 'pending',
  wake_attempt integer NOT NULL DEFAULT 0,
  audit_state text NOT NULL DEFAULT 'pending',
  last_error text,
  handled_by_user_id text,
  handled_at timestamptz,
  followups_checked_by_user_id text,
  followups_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mailbox_key, message_key),
  UNIQUE (mailbox_binding, message_key),
  CHECK (NOT attempt_started OR destination IS NOT NULL),
  CHECK ((followups_checked_at IS NULL) = (followups_checked_by_user_id IS NULL)),
  CHECK (followups_checked_at IS NULL OR (status='routed' AND issue_id IS NOT NULL AND handoff_origin_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS email_routing_review_idx
  ON plugin_email_tools_7cbee3fdf3.email_routing (source_company_id, mailbox_key, status, updated_at DESC, id);

-- Conservative reservation, including attempts which later fail. No long transaction around IMAP/RPC.
CREATE TABLE IF NOT EXISTS plugin_email_tools_7cbee3fdf3.email_routing_rate (
  mailbox_key text PRIMARY KEY,
  hour_start timestamptz NOT NULL,
  reservations integer NOT NULL CHECK (reservations BETWEEN 1 AND 25)
);
