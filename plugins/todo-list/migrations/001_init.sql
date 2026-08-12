-- Personal to-do list.
--
-- READ THIS BEFORE ADDING A company_id COLUMN.
--
-- There is deliberately no company_id here. A row belongs to one person and is
-- found by user_id alone. Requests still carry a companyId, because the host
-- requires every board-auth plugin route to resolve a company before it will
-- run, but that company is used only to prove the caller is a legitimate board
-- user. It is never used to filter rows.
--
-- The point of the feature is one list that is the same no matter which company
-- is selected. Adding a company filter "for consistency" would silently split
-- the list into a different one per company, which is the single most likely
-- way to break this plugin. See the same warning in src/todos.ts.
--
-- The namespace below is derived by the host as
-- plugin_<namespaceSlug>_<first 10 hex of sha256(pluginId)>, so for pluginId
-- "todo-list" with namespaceSlug "todolist" it is fixed at the literal below.

CREATE TABLE plugin_todolist_d9adb30a71.todos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The owner, and the only access key. Sourced from the request actor on the
  -- server, never from anything the browser sends.
  user_id text NOT NULL,

  -- The text is the whole entity, so an empty one is unreachable in the UI
  -- (nothing to click) and is rejected here as well as in the worker.
  title text NOT NULL CONSTRAINT todos_title_not_blank_ck CHECK (length(btrim(title)) > 0),

  -- NULL means not done. One nullable timestamp rather than a boolean plus a
  -- date, so the two can never disagree.
  completed_at timestamptz,

  -- Optional. NULL means no date, which is the common case.
  due_at timestamptz,

  -- Fractional index, the same scheme core issues use: a reorder rewrites only
  -- the moved row, to the midpoint of its new neighbours. Meaningful only
  -- within one user's list.
  sort_order double precision NOT NULL DEFAULT 0,

  -- Set when an item is turned into a real issue. The to-do is kept afterwards
  -- so it can still be ticked off and so the trail survives.
  promoted_issue_id uuid,
  promoted_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The only query shape this table has: one person's list, in order.
CREATE INDEX todos_user_sort_idx
  ON plugin_todolist_d9adb30a71.todos (user_id, sort_order);
