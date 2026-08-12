/**
 * Unit tests for the personal to-do list.
 *
 * The first suite is the important one. This plugin has no company filter, so
 * `user_id = $1` in every builder is the whole access control model. If a
 * future edit drops that clause from any builder, one operator's list becomes
 * readable by another, and nothing else in the codebase would catch it.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  SORT_ORDER_STEP,
  TITLE_MAX,
  buildClearDone,
  buildDelete,
  buildGetQuery,
  buildInsert,
  buildListQuery,
  buildMarkPromoted,
  buildNextSortOrderQuery,
  buildUpdate,
  findByTitleMatch,
  fromDateInputValue,
  isOverdue,
  midpointSortOrder,
  normalizeTitle,
  parseDueAt,
  partitionTodos,
  rowToApi,
  tableName,
  toDateInputValue,
  type SqlStatement,
  type TodoApi,
  type TodoRow,
} from "./todos.js";

const NS = "plugin_todolist_d9adb30a71";
const USER = "user-1";
const OTHER = "user-2";
const TODO_ID = "11111111-1111-1111-1111-111111111111";

// ---- Access control: every builder is scoped to the owner ----

/**
 * Every statement this plugin can issue, built with the same user. Any new
 * builder must be added here, which is the point: the test is a checklist that
 * fails loudly when someone adds a query that forgets the owner.
 */
const ALL_BUILDERS: Array<{ name: string; stmt: SqlStatement }> = [
  { name: "list", stmt: buildListQuery(NS, USER) },
  { name: "list (open only)", stmt: buildListQuery(NS, USER, { includeDone: false }) },
  { name: "get", stmt: buildGetQuery(NS, USER, TODO_ID) },
  { name: "nextSortOrder", stmt: buildNextSortOrderQuery(NS, USER) },
  {
    name: "insert",
    stmt: buildInsert(NS, USER, { id: TODO_ID, title: "x", dueAt: null, sortOrder: 1000 }),
  },
  { name: "update", stmt: buildUpdate(NS, USER, TODO_ID, { title: "x" })! },
  { name: "update (done)", stmt: buildUpdate(NS, USER, TODO_ID, { done: true })! },
  { name: "delete", stmt: buildDelete(NS, USER, TODO_ID) },
  { name: "clearDone", stmt: buildClearDone(NS, USER) },
  { name: "markPromoted", stmt: buildMarkPromoted(NS, USER, TODO_ID, "issue-1") },
];

test("every builder filters by user_id and binds it as $1", () => {
  for (const { name, stmt } of ALL_BUILDERS) {
    assert.ok(
      stmt.text.includes("user_id = $1") || stmt.text.includes("$1,"),
      `${name}: statement does not scope to user_id = $1 -> ${stmt.text}`,
    );
    assert.equal(stmt.params[0], USER, `${name}: first bound parameter must be the owner`);
  }
});

test("no builder mentions company, which would split the list per company", () => {
  for (const { name, stmt } of ALL_BUILDERS) {
    assert.ok(
      !stmt.text.toLowerCase().includes("company"),
      `${name}: must not reference a company -> ${stmt.text}`,
    );
  }
});

test("every builder targets this plugin's own namespace", () => {
  for (const { name, stmt } of ALL_BUILDERS) {
    assert.ok(stmt.text.includes(tableName(NS)), `${name}: must target ${tableName(NS)}`);
  }
});

test("insert binds the owner rather than taking it from the row payload", () => {
  const stmt = buildInsert(NS, USER, {
    id: TODO_ID,
    title: "call the accountant",
    dueAt: null,
    sortOrder: 2000,
  });
  assert.equal(stmt.params[0], USER);
  // $1 is the user slot in the VALUES list, so a caller cannot smuggle an owner
  // in through the row object.
  assert.ok(stmt.text.includes("VALUES ($2, $1,"));
});

test("two users produce identical SQL but different bound owners", () => {
  const mine = buildListQuery(NS, USER);
  const theirs = buildListQuery(NS, OTHER);
  assert.equal(mine.text, theirs.text);
  assert.notDeepEqual(mine.params, theirs.params);
});

// ---- Sort order ----

test("midpoint between two neighbours lands halfway", () => {
  assert.equal(midpointSortOrder(1000, 2000), 1500);
});

test("midpoint at the top of the list steps below the first item", () => {
  assert.equal(midpointSortOrder(null, 1000), 0);
});

test("midpoint at the bottom of the list steps past the last item", () => {
  assert.equal(midpointSortOrder(3000, null), 4000);
});

test("midpoint into an empty list is the first step", () => {
  assert.equal(midpointSortOrder(null, null), SORT_ORDER_STEP);
});

test("repeated midpoints stay strictly between their neighbours", () => {
  let before = 1000;
  const after = 2000;
  for (let i = 0; i < 20; i++) {
    const mid = midpointSortOrder(before, after);
    assert.ok(mid > before && mid < after, `iteration ${i}: ${mid} escaped (${before}, ${after})`);
    before = mid;
  }
});

test("next sort order appends a full step past the current maximum", () => {
  const stmt = buildNextSortOrderQuery(NS, USER);
  assert.ok(stmt.text.includes(`COALESCE(MAX(sort_order), 0) + ${SORT_ORDER_STEP}`));
});

// ---- Title validation ----

test("a blank or whitespace-only title is rejected before it reaches the database", () => {
  for (const bad of ["", "   ", "\t\n  "]) {
    const result = normalizeTitle(bad);
    assert.equal(result.ok, false, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test("a title is trimmed rather than stored with padding", () => {
  const result = normalizeTitle("  call the accountant  ");
  assert.deepEqual(result, { ok: true, value: "call the accountant" });
});

test("a non-string title is rejected", () => {
  assert.equal(normalizeTitle(42).ok, false);
  assert.equal(normalizeTitle(null).ok, false);
  assert.equal(normalizeTitle(undefined).ok, false);
});

test("an over-long title is rejected", () => {
  assert.equal(normalizeTitle("a".repeat(TITLE_MAX)).ok, true);
  assert.equal(normalizeTitle("a".repeat(TITLE_MAX + 1)).ok, false);
});

// ---- Due dates ----

test("an omitted due date leaves the existing one alone", () => {
  assert.deepEqual(parseDueAt(undefined), { ok: true, value: undefined });
});

test("an explicit null clears the due date", () => {
  assert.deepEqual(parseDueAt(null), { ok: true, value: null });
  assert.deepEqual(parseDueAt(""), { ok: true, value: null });
});

test("a valid timestamp is normalized to ISO", () => {
  const result = parseDueAt("2026-08-20T09:00:00.000Z");
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value, "2026-08-20T09:00:00.000Z");
});

test("an unparseable due date is rejected", () => {
  assert.equal(parseDueAt("next tuesday").ok, false);
  assert.equal(parseDueAt(12345).ok, false);
});

test("clearing a due date is distinguishable from not mentioning it", () => {
  const cleared = buildUpdate(NS, USER, TODO_ID, { dueAt: null });
  const untouched = buildUpdate(NS, USER, TODO_ID, { title: "x" });
  assert.ok(cleared!.text.includes("due_at = $"));
  assert.ok(!untouched!.text.includes("due_at"));
});

// ---- Update semantics ----

test("an empty patch produces no statement", () => {
  assert.equal(buildUpdate(NS, USER, TODO_ID, {}), null);
});

test("ticking an item stamps the completion server-side, not from the client", () => {
  const stmt = buildUpdate(NS, USER, TODO_ID, { done: true })!;
  assert.ok(stmt.text.includes("completed_at = now()"));
  assert.ok(!stmt.params.includes(true));
});

test("unticking an item clears the completion", () => {
  const stmt = buildUpdate(NS, USER, TODO_ID, { done: false })!;
  assert.ok(stmt.text.includes("completed_at = NULL"));
});

test("toggling done never rewrites sort_order, so an unticked item returns to its place", () => {
  for (const done of [true, false]) {
    const stmt = buildUpdate(NS, USER, TODO_ID, { done })!;
    assert.ok(!stmt.text.includes("sort_order"), `done=${done} must not touch sort_order`);
  }
});

test("every update refreshes updated_at", () => {
  const stmt = buildUpdate(NS, USER, TODO_ID, { title: "x" })!;
  assert.ok(stmt.text.includes("updated_at = now()"));
});

test("a multi-field patch numbers its placeholders correctly", () => {
  const stmt = buildUpdate(NS, USER, TODO_ID, {
    title: "renew insurance",
    dueAt: "2026-09-01T00:00:00.000Z",
    sortOrder: 1500,
  })!;
  assert.deepEqual(stmt.params, [
    USER,
    TODO_ID,
    "renew insurance",
    "2026-09-01T00:00:00.000Z",
    1500,
  ]);
  assert.ok(stmt.text.includes("title = $3"));
  assert.ok(stmt.text.includes("due_at = $4"));
  assert.ok(stmt.text.includes("sort_order = $5"));
});

// ---- Clearing done ----

test("clear-done removes only completed rows", () => {
  const stmt = buildClearDone(NS, USER);
  assert.ok(stmt.text.includes("completed_at IS NOT NULL"));
  assert.ok(stmt.text.startsWith("DELETE"));
});

// ---- Shaping ----

function row(overrides: Partial<TodoRow> = {}): TodoRow {
  return {
    id: TODO_ID,
    user_id: USER,
    title: "call the accountant",
    completed_at: null,
    due_at: null,
    sort_order: 1000,
    promoted_issue_id: null,
    promoted_at: null,
    created_at: "2026-08-12T10:00:00.000Z",
    updated_at: "2026-08-12T10:00:00.000Z",
    ...overrides,
  };
}

test("done is derived from the completion timestamp, not stored separately", () => {
  assert.equal(rowToApi(row()).done, false);
  assert.equal(rowToApi(row({ completed_at: "2026-08-12T11:00:00.000Z" })).done, true);
});

test("the owner is never exposed to the browser", () => {
  const api = rowToApi(row()) as unknown as Record<string, unknown>;
  assert.ok(!("userId" in api));
  assert.ok(!("user_id" in api));
});

test("partition keeps open and done items in their given order", () => {
  const rows: TodoApi[] = [
    rowToApi(row({ id: "a", sort_order: 1000 })),
    rowToApi(row({ id: "b", sort_order: 2000, completed_at: "2026-08-12T11:00:00.000Z" })),
    rowToApi(row({ id: "c", sort_order: 3000 })),
  ];
  const { open, done } = partitionTodos(rows);
  assert.deepEqual(open.map((t) => t.id), ["a", "c"]);
  assert.deepEqual(done.map((t) => t.id), ["b"]);
});

// ---- Overdue ----

const NOW = new Date("2026-08-12T12:00:00.000Z");

test("an item due in the past is overdue", () => {
  assert.equal(isOverdue(rowToApi(row({ due_at: "2026-08-11T12:00:00.000Z" })), NOW), true);
});

test("an item due in the future is not overdue", () => {
  assert.equal(isOverdue(rowToApi(row({ due_at: "2026-08-13T12:00:00.000Z" })), NOW), false);
});

test("an item with no due date is never overdue", () => {
  assert.equal(isOverdue(rowToApi(row()), NOW), false);
});

test("a done item is never overdue, however late it was ticked off", () => {
  const late = rowToApi(
    row({ due_at: "2026-01-01T00:00:00.000Z", completed_at: "2026-08-12T11:00:00.000Z" }),
  );
  assert.equal(isOverdue(late, NOW), false);
});

test("an unparseable due date does not crash the overdue check", () => {
  assert.equal(isOverdue(rowToApi(row({ due_at: "not a date" })), NOW), false);
});

// ---- Finding an item by what it was called ----

function named(...titles: string[]): TodoApi[] {
  return titles.map((title, i) => rowToApi(row({ id: `id-${i}`, title })));
}

test("a single substring hit resolves", () => {
  const result = findByTitleMatch(named("call the accountant", "renew insurance"), "accountant");
  assert.equal(result.kind, "one");
  assert.equal(result.kind === "one" && result.todo.title, "call the accountant");
});

test("matching is case-insensitive and ignores surrounding spaces", () => {
  const result = findByTitleMatch(named("Call The Accountant"), "  ACCOUNTANT  ");
  assert.equal(result.kind, "one");
});

test("no hit reports none rather than guessing", () => {
  assert.equal(findByTitleMatch(named("call the accountant"), "dentist").kind, "none");
});

test("an empty needle never matches everything", () => {
  assert.equal(findByTitleMatch(named("a", "b"), "   ").kind, "none");
});

test("an ambiguous match reports every candidate instead of picking one", () => {
  // The regression this guards: ticking off the wrong item because the tool
  // silently took the first hit.
  const result = findByTitleMatch(named("call the accountant", "call the dentist"), "call the");
  assert.equal(result.kind, "many");
  assert.equal(result.kind === "many" && result.candidates.length, 2);
});

test("an exact match beats a longer partial one, so a caller can disambiguate", () => {
  const result = findByTitleMatch(named("call bob", "call bob about the invoice"), "call bob");
  assert.equal(result.kind, "one");
  assert.equal(result.kind === "one" && result.todo.title, "call bob");
});

test("duplicate exact titles are reported as ambiguous", () => {
  const result = findByTitleMatch(named("call bob", "call bob"), "call bob");
  assert.equal(result.kind, "many");
});

// ---- Date picker round trip ----

test("a picked date round-trips back to the same day in local time", () => {
  // The regression this guards: slicing the ISO string instead of reading local
  // date parts shows the UTC day, so anyone west of Greenwich sees the date they
  // picked land a day late.
  for (const picked of ["2026-08-12", "2026-01-01", "2026-12-31", "2026-02-28"]) {
    const stored = fromDateInputValue(picked);
    assert.ok(stored, `${picked} should parse`);
    assert.equal(toDateInputValue(stored), picked, `${picked} did not round-trip`);
  }
});

test("a due date is not overdue until the end of its day", () => {
  const stored = fromDateInputValue("2026-08-12")!;
  const todo = rowToApi(row({ due_at: stored }));
  const startOfDay = new Date(2026, 7, 12, 0, 1, 0);
  const middleOfDay = new Date(2026, 7, 12, 14, 0, 0);
  const nextMorning = new Date(2026, 7, 13, 9, 0, 0);
  assert.equal(isOverdue(todo, startOfDay), false, "not overdue just after midnight");
  assert.equal(isOverdue(todo, middleOfDay), false, "not overdue during the day");
  assert.equal(isOverdue(todo, nextMorning), true, "overdue the next morning");
});

test("an empty picker value clears the date", () => {
  assert.equal(fromDateInputValue(""), null);
  assert.equal(toDateInputValue(null), "");
});

test("a malformed picker value is rejected rather than guessed at", () => {
  assert.equal(fromDateInputValue("12/08/2026"), null);
  assert.equal(fromDateInputValue("2026-8-12"), null);
  assert.equal(fromDateInputValue("not a date"), null);
});

test("an impossible calendar date is rejected rather than rolled over", () => {
  // new Date(2026, 1, 30) silently becomes 2 March. Returning a date the user
  // did not pick is worse than refusing the input.
  assert.equal(fromDateInputValue("2026-02-30"), null);
  assert.equal(fromDateInputValue("2026-13-01"), null);
});

test("an unparseable stored timestamp does not crash the picker", () => {
  assert.equal(toDateInputValue("not a date"), "");
});
