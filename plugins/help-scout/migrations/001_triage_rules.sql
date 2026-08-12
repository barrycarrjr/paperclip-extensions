-- Help Scout triage rules.
--
-- These used to live in a Markdown document on a "rules home" issue, hand
-- edited by the operator and parsed by the triage skill on every run. Moving
-- them here makes them queryable, keeps them out of prose that can drift, and
-- lets the UI write them from a button.
--
-- Two differences from the email-tools equivalent, both deliberate:
--
--  * mailbox_id is nullable. A Help Scout account hosts several mailboxes and
--    a routine may scope to one, so NULL means "every mailbox in this account"
--    and a value means "this mailbox only". The unique index uses NULLS NOT
--    DISTINCT so an account-wide rule collides with itself on re-insert
--    instead of silently duplicating (Postgres otherwise treats every NULL as
--    distinct).
--
--  * sender_pattern carries four forms, not three: a full address, an
--    @domain, `subject:<text>`, and `sender:<display name>`. The last has no
--    email-tools counterpart, because Help Scout conversations routinely carry
--    a useful display name where the address is a no-reply.

CREATE TABLE plugin_help_scout_dcee45a1d3.helpscout_triage_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  account_key text NOT NULL,
  mailbox_id text,
  sender_pattern text NOT NULL,
  rule_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX helpscout_triage_rules_lookup
  ON plugin_help_scout_dcee45a1d3.helpscout_triage_rules
     (company_id, account_key, mailbox_id, sender_pattern)
  NULLS NOT DISTINCT;

CREATE INDEX helpscout_triage_rules_by_type
  ON plugin_help_scout_dcee45a1d3.helpscout_triage_rules
     (company_id, account_key, rule_type);
