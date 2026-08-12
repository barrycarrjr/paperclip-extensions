/**
 * Pure logic for the personal to-do list.
 *
 * Everything here is free of I/O so it can be unit tested with node:test. The
 * worker is a thin shell that resolves the caller, calls into these builders,
 * and hands the SQL to ctx.db.
 *
 * READ THIS BEFORE CHANGING A QUERY BUILDER.
 *
 * Every builder below takes userId as its FIRST argument and puts
 * `user_id = $1` in the WHERE clause. That is not decoration: it is the entire
 * access control model for this plugin. A row id on its own is never enough to
 * read, change or delete anything. There is deliberately no company filter, so
 * the user_id clause is the only thing standing between one operator's list and
 * another's. `buildersAlwaysBindUser` in todos.test.ts fails the build if any
 * builder stops doing it.
 */

/**
 * Gap left between adjacent items when appending. Matches the scheme core
 * issues use for their own manual ordering, so the midpoint of two neighbours
 * stays representable for a very long time before it needs rebalancing.
 */
export const SORT_ORDER_STEP = 1000;

/** Longest to-do text we accept. Long enough for a sentence, short enough to scan. */
export const TITLE_MAX = 500;

export interface TodoRow {
  id: string;
  user_id: string;
  title: string;
  completed_at: string | null;
  due_at: string | null;
  sort_order: number;
  promoted_issue_id: string | null;
  promoted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TodoApi {
  id: string;
  title: string;
  done: boolean;
  completedAt: string | null;
  dueAt: string | null;
  sortOrder: number;
  promotedIssueId: string | null;
  promotedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SqlStatement {
  text: string;
  params: unknown[];
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

// ---- Shaping ----

export function tableName(namespace: string): string {
  return `${namespace}.todos`;
}

export function rowToApi(row: TodoRow): TodoApi {
  return {
    id: row.id,
    title: row.title,
    done: row.completed_at !== null,
    completedAt: row.completed_at,
    dueAt: row.due_at,
    sortOrder: row.sort_order,
    promotedIssueId: row.promoted_issue_id,
    promotedAt: row.promoted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Split a list into the open items and the done ones. The page shows the open
 * list plainly and tucks the done ones into a collapsed section, so it needs
 * both halves in their existing order rather than a re-sort.
 */
export function partitionTodos(rows: TodoApi[]): { open: TodoApi[]; done: TodoApi[] } {
  const open: TodoApi[] = [];
  const done: TodoApi[] = [];
  for (const row of rows) {
    (row.done ? done : open).push(row);
  }
  return { open, done };
}

/**
 * True when an item has a due date that has already passed and it is not done.
 * A done item is never overdue, however late it was ticked off.
 */
export function isOverdue(todo: TodoApi, now: Date): boolean {
  if (todo.done || !todo.dueAt) return false;
  const due = new Date(todo.dueAt);
  if (Number.isNaN(due.getTime())) return false;
  return due.getTime() < now.getTime();
}

// ---- Validation ----

/**
 * Trim and length-check the text. Returning an error rather than silently
 * coercing means a blank line never reaches the database, where it would hit
 * the CHECK constraint and surface as an opaque 500.
 */
export function normalizeTitle(raw: unknown): Parsed<string> {
  if (typeof raw !== "string") {
    return { ok: false, error: "title must be a string" };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "title cannot be blank" };
  }
  if (trimmed.length > TITLE_MAX) {
    return { ok: false, error: `title cannot be longer than ${TITLE_MAX} characters` };
  }
  return { ok: true, value: trimmed };
}

/**
 * Parse an optional due date.
 *
 * Three outcomes matter and they are all different: the caller did not mention
 * dueAt (leave it alone), the caller sent null (clear it), or the caller sent a
 * timestamp (set it). Collapsing the first two would make it impossible to
 * patch a title without wiping the date.
 */
export function parseDueAt(raw: unknown): Parsed<string | null | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null || raw === "") return { ok: true, value: null };
  if (typeof raw !== "string") {
    return { ok: false, error: "dueAt must be an ISO timestamp string, null, or omitted" };
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return { ok: false, error: `dueAt is not a valid timestamp: ${raw}` };
  }
  return { ok: true, value: parsed.toISOString() };
}

/**
 * Format a stored timestamp for an `<input type="date">`, which wants
 * YYYY-MM-DD.
 *
 * Deliberately uses the local date parts rather than slicing the ISO string.
 * Slicing would show the UTC day, so anyone west of Greenwich would see a due
 * date land a day later than the one they picked.
 */
export function toDateInputValue(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Turn a YYYY-MM-DD picker value back into a timestamp, anchored to the end of
 * that day in local time. A to-do due "on Thursday" is not overdue at one
 * minute past midnight on Thursday.
 */
export function fromDateInputValue(value: string): string | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 23, 59, 59, 999);
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date.toISOString();
}

/**
 * Midpoint between two neighbours, used when an item is dragged into place.
 * A null neighbour means the edge of the list.
 */
export function midpointSortOrder(before: number | null, after: number | null): number {
  if (before === null && after === null) return SORT_ORDER_STEP;
  if (before === null) return (after as number) - SORT_ORDER_STEP;
  if (after === null) return before + SORT_ORDER_STEP;
  return (before + after) / 2;
}

// ---- Finding an item by what the operator called it ----

export type TitleMatch =
  | { kind: "one"; todo: TodoApi }
  | { kind: "none" }
  | { kind: "many"; candidates: TodoApi[] };

/**
 * Find the item somebody meant when they said "tick off the accountant one".
 *
 * Chat callers do not know row ids, so tools accept a fragment of the text.
 * An exact match wins outright, which is what lets a caller disambiguate after
 * being shown the candidates. Otherwise it is a case-insensitive substring
 * search, and anything other than exactly one hit is reported as such rather
 * than resolved by picking the first: silently ticking off the wrong item is
 * worse than asking again.
 */
export function findByTitleMatch(todos: TodoApi[], match: string): TitleMatch {
  const needle = match.trim().toLowerCase();
  if (!needle) return { kind: "none" };

  const exact = todos.filter((t) => t.title.toLowerCase() === needle);
  if (exact.length === 1) return { kind: "one", todo: exact[0]! };
  if (exact.length > 1) return { kind: "many", candidates: exact };

  const partial = todos.filter((t) => t.title.toLowerCase().includes(needle));
  if (partial.length === 0) return { kind: "none" };
  if (partial.length === 1) return { kind: "one", todo: partial[0]! };
  return { kind: "many", candidates: partial };
}

// ---- Query builders ----

/**
 * One person's list, in display order. Done items are returned alongside open
 * ones so the page can render the collapsed section without a second request;
 * pass includeDone false to skip them entirely.
 */
export function buildListQuery(
  namespace: string,
  userId: string,
  opts: { includeDone?: boolean } = {},
): SqlStatement {
  const includeDone = opts.includeDone !== false;
  const doneClause = includeDone ? "" : " AND completed_at IS NULL";
  return {
    text:
      `SELECT * FROM ${tableName(namespace)}` +
      ` WHERE user_id = $1${doneClause}` +
      ` ORDER BY sort_order ASC, created_at ASC` +
      ` LIMIT 1000`,
    params: [userId],
  };
}

/** Read one row back after a write. Still scoped to the owner. */
export function buildGetQuery(namespace: string, userId: string, todoId: string): SqlStatement {
  return {
    text: `SELECT * FROM ${tableName(namespace)} WHERE user_id = $1 AND id = $2`,
    params: [userId, todoId],
  };
}

/**
 * Next sort order at the bottom of this user's list. Two people's sequences are
 * independent because the max is taken within the owner's rows.
 */
export function buildNextSortOrderQuery(namespace: string, userId: string): SqlStatement {
  return {
    text:
      `SELECT COALESCE(MAX(sort_order), 0) + ${SORT_ORDER_STEP} AS next` +
      ` FROM ${tableName(namespace)} WHERE user_id = $1`,
    params: [userId],
  };
}

export function buildInsert(
  namespace: string,
  userId: string,
  todo: { id: string; title: string; dueAt: string | null; sortOrder: number },
): SqlStatement {
  return {
    text:
      `INSERT INTO ${tableName(namespace)} (id, user_id, title, due_at, sort_order)` +
      ` VALUES ($2, $1, $3, $4, $5)`,
    params: [userId, todo.id, todo.title, todo.dueAt, todo.sortOrder],
  };
}

export interface TodoPatch {
  title?: string;
  done?: boolean;
  dueAt?: string | null;
  sortOrder?: number;
}

/**
 * Build a partial update. Returns null when the patch is empty, so the worker
 * can answer 400 rather than issuing an UPDATE that touches only updated_at.
 *
 * Note what is absent: toggling done never writes sort_order. That is what lets
 * an item un-ticked by mistake drop back into the exact place it came from.
 */
export function buildUpdate(
  namespace: string,
  userId: string,
  todoId: string,
  patch: TodoPatch,
): SqlStatement | null {
  const params: unknown[] = [userId, todoId];
  const setClauses: string[] = [];

  if (patch.title !== undefined) {
    params.push(patch.title);
    setClauses.push(`title = $${params.length}`);
  }
  if (patch.done !== undefined) {
    // Stamped server-side. Clients send a boolean and never a timestamp, so a
    // clock-skewed browser cannot backdate a completion.
    setClauses.push(patch.done ? `completed_at = now()` : `completed_at = NULL`);
  }
  if (patch.dueAt !== undefined) {
    params.push(patch.dueAt);
    setClauses.push(`due_at = $${params.length}`);
  }
  if (patch.sortOrder !== undefined) {
    params.push(patch.sortOrder);
    setClauses.push(`sort_order = $${params.length}`);
  }

  if (setClauses.length === 0) return null;
  setClauses.push(`updated_at = now()`);

  return {
    text:
      `UPDATE ${tableName(namespace)} SET ${setClauses.join(", ")}` +
      ` WHERE user_id = $1 AND id = $2`,
    params,
  };
}

export function buildDelete(namespace: string, userId: string, todoId: string): SqlStatement {
  return {
    text: `DELETE FROM ${tableName(namespace)} WHERE user_id = $1 AND id = $2`,
    params: [userId, todoId],
  };
}

/** Remove every ticked-off item for this user. Open items are untouched. */
export function buildClearDone(namespace: string, userId: string): SqlStatement {
  return {
    text: `DELETE FROM ${tableName(namespace)} WHERE user_id = $1 AND completed_at IS NOT NULL`,
    params: [userId],
  };
}

/**
 * Record that an item became a real issue. The to-do itself is kept, so it can
 * still be ticked off and so there is a trail back to where the issue came from.
 */
export function buildMarkPromoted(
  namespace: string,
  userId: string,
  todoId: string,
  issueId: string,
): SqlStatement {
  return {
    text:
      `UPDATE ${tableName(namespace)}` +
      ` SET promoted_issue_id = $3, promoted_at = now(), updated_at = now()` +
      ` WHERE user_id = $1 AND id = $2`,
    params: [userId, todoId, issueId],
  };
}
