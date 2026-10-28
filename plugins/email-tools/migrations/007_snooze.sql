-- Snoozed mail: a message the operator hid until a chosen time.
--
-- Snoozing moves the message out of its folder into the snooze folder on the
-- mail server, so every mail program sees it gone, and records it here. A job
-- moves it back and marks it unread once wake_at has passed. Nothing is
-- deleted: the message itself always lives in exactly one folder on the server.
--
-- snooze_uid is the UID in the snooze folder (it changes on a move, so the
-- original UID is not kept). message_id is the Message-ID header, used to find
-- the message again if the server renumbered the folder. folder is where the
-- message goes back to.

CREATE TABLE plugin_email_tools_7cbee3fdf3.email_snoozes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  mailbox_key text NOT NULL,
  folder text NOT NULL,
  snooze_folder text NOT NULL,
  snooze_uid integer NOT NULL,
  message_id text,
  subject text,
  sender text,
  wake_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX email_snoozes_due
  ON plugin_email_tools_7cbee3fdf3.email_snoozes (wake_at);
CREATE INDEX email_snoozes_lookup
  ON plugin_email_tools_7cbee3fdf3.email_snoozes (company_id, mailbox_key);
