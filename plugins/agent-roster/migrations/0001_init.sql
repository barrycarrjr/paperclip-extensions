-- Agents the board chose to keep although the roster flags them as idle or
-- barely used, such as a seasonal agent. One mark per agent; removing the mark
-- deletes the row.
CREATE TABLE plugin_roster_6cd9f5bcfd.keep_marks (
  company_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  note text NOT NULL DEFAULT '',
  marked_by text,
  marked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, agent_id)
);
