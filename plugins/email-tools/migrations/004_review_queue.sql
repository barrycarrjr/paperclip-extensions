-- The triage review queue: senders the triage routine surfaced for a
-- decision, waiting for the operator to give them a rule or dismiss them.
--
-- This used to be a Review queue section that each triage run appended to a
-- Markdown document on a rules-home issue. An issue is a unit of work, not a
-- place to keep standing data: the document grew by a section per run,
-- nothing could query it, and it never learned that a sender had since been
-- given a rule. Kept here, next to email_sender_rules, a rule written by any
-- path clears the entries it settles, and an entry not seen for the
-- configured number of days drops out.
--
-- sender holds the same forms a rule can match on, lowercased: a full
-- address, or an @domain when the routine queued a whole domain.
--
-- message_ids holds the identities of the messages already counted (the
-- Message-ID, or uid:N for a message without one), so a message seen by
-- several runs is counted once. The worker keeps only the newest 500.

CREATE TABLE plugin_email_tools_7cbee3fdf3.email_review_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  mailbox_key text NOT NULL,
  sender text NOT NULL,
  display_name text,
  last_subject text,
  note text,
  suggested_rule text CHECK (suggested_rule IN ('auto-triage','keep-always','mute')),
  message_count integer NOT NULL DEFAULT 0,
  message_ids text[] NOT NULL DEFAULT '{}',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX email_review_queue_lookup
  ON plugin_email_tools_7cbee3fdf3.email_review_queue (company_id, mailbox_key, sender);

-- Mail an agent moved into the triage folder itself. The poll loop learns an
-- auto-triage rule from every new message in that folder, which is right for
-- mail the operator dragged there and wrong for the agent moving an unknown
-- sender in loose mode: that would turn the agent guess into a rule and clear
-- the very entry it had just queued for the operator. message_key is the
-- Message-ID, or uid:N for the message in the triage folder. Rows are pruned
-- after a fortnight, long after the poll loop has looked.

CREATE TABLE plugin_email_tools_7cbee3fdf3.email_agent_triage_moves (
  mailbox_key text NOT NULL,
  message_key text NOT NULL,
  company_id uuid NOT NULL,
  moved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mailbox_key, message_key)
);
