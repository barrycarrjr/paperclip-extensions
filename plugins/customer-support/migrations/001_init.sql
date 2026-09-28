-- The namespace is derived from the customer-support plugin id.
-- Every row carries a company id and runtime queries always filter by it.
CREATE TABLE plugin_customer_support_0c69412611.support_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  connection_id text NOT NULL,
  source text NOT NULL CHECK (source IN ('slack', 'helpscout', 'whmcs', 'other')),
  external_route_id text NOT NULL,
  external_conversation_id text NOT NULL,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'triage', 'waiting', 'resolved')),
  external_url text,
  first_message_at timestamptz NOT NULL,
  last_message_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, connection_id, external_route_id, external_conversation_id)
);

CREATE INDEX support_cases_company_recent_idx
  ON plugin_customer_support_0c69412611.support_cases (company_id, last_message_at DESC);

CREATE TABLE plugin_customer_support_0c69412611.support_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  case_id uuid NOT NULL REFERENCES plugin_customer_support_0c69412611.support_cases (id),
  connection_id text NOT NULL,
  external_route_id text NOT NULL,
  external_conversation_id text NOT NULL,
  external_message_id text NOT NULL,
  author_kind text NOT NULL CHECK (author_kind IN ('customer', 'reseller', 'staff', 'bot')),
  body text NOT NULL,
  occurred_at timestamptz NOT NULL,
  activity_logged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, connection_id, external_route_id, external_conversation_id, external_message_id)
);

CREATE INDEX support_messages_case_time_idx
  ON plugin_customer_support_0c69412611.support_messages (company_id, case_id, occurred_at);
