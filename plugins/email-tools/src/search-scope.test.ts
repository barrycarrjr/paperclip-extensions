/**
 * Tests for mailbox-search folder scoping and result merging.
 *
 * The behaviours worth pinning: an explicit folder never widens into a
 * whole-account search, deleted mail stays out of results unless asked for,
 * a Gmail account does not show every hit twice because it lives in both
 * INBOX and All Mail, and nothing gets dropped without being reported.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  DEFAULT_MAX_FOLDERS,
  isTrashLike,
  mergeSearchResults,
  planFolderScope,
  type FolderInfo,
  type SearchHit,
} from "./search-scope.js";

function folder(path: string, specialUse: string | null = null): FolderInfo {
  return { path, specialUse };
}

const GMAIL_FOLDERS: FolderInfo[] = [
  folder("INBOX", "\\Inbox"),
  folder("[Gmail]/All Mail", "\\All"),
  folder("[Gmail]/Sent Mail", "\\Sent"),
  folder("[Gmail]/Drafts", "\\Drafts"),
  folder("[Gmail]/Spam", "\\Junk"),
  folder("[Gmail]/Trash", "\\Trash"),
  folder("Receipts"),
];

test("an explicit folder is the entire scope", () => {
  const scope = planFolderScope(GMAIL_FOLDERS, { folder: "Receipts" });
  assert.deepEqual(scope.folders, ["Receipts"]);
  assert.deepEqual(scope.skipped, []);
});

test("an explicit folder is honoured even when it is Trash", () => {
  // Asking for Trash by name is a deliberate act; the default-off rule for
  // Trash must not override it.
  const scope = planFolderScope(GMAIL_FOLDERS, { folder: "[Gmail]/Trash" });
  assert.deepEqual(scope.folders, ["[Gmail]/Trash"]);
});

test("Trash and Junk are left out by default and reported as skipped", () => {
  const scope = planFolderScope(GMAIL_FOLDERS, {});
  assert.ok(!scope.folders.includes("[Gmail]/Trash"));
  assert.ok(!scope.folders.includes("[Gmail]/Spam"));
  assert.ok(scope.skipped.includes("[Gmail]/Trash"));
  assert.ok(scope.skipped.includes("[Gmail]/Spam"));
});

test("Trash and Junk are included on request", () => {
  const scope = planFolderScope(GMAIL_FOLDERS, { includeTrash: true });
  assert.ok(scope.folders.includes("[Gmail]/Trash"));
  assert.ok(scope.folders.includes("[Gmail]/Spam"));
  assert.deepEqual(scope.skipped, []);
});

test("INBOX is searched first, then Sent and archives, drafts last", () => {
  const scope = planFolderScope(GMAIL_FOLDERS, {});
  assert.equal(scope.folders[0], "INBOX");
  const sent = scope.folders.indexOf("[Gmail]/Sent Mail");
  const all = scope.folders.indexOf("[Gmail]/All Mail");
  const drafts = scope.folders.indexOf("[Gmail]/Drafts");
  assert.ok(sent < all, "Sent should be searched before All Mail");
  assert.ok(all < drafts, "Drafts should come last");
});

test("the configured poll folder outranks INBOX when they differ", () => {
  const folders = [folder("INBOX", "\\Inbox"), folder("Support"), folder("Archive", "\\Archive")];
  const scope = planFolderScope(folders, { pollFolder: "Support" });
  assert.equal(scope.folders[0], "Support");
});

test("servers without SPECIAL-USE still get their trash folders recognised", () => {
  // Older Dovecot / Exchange installs advertise nothing, so the name is all
  // there is to go on.
  const folders = [
    folder("INBOX"),
    folder("Deleted Items"),
    folder("Junk E-mail"),
    folder("INBOX.Trash"),
    folder("Project Trashcan"),
  ];
  const scope = planFolderScope(folders, {});
  assert.deepEqual(scope.folders.sort(), ["INBOX", "Project Trashcan"]);
  assert.equal(scope.skipped.length, 3);
});

test("a folder merely containing the word trash is not treated as Trash", () => {
  assert.equal(isTrashLike(folder("Project Trashcan")), false);
  assert.equal(isTrashLike(folder("Trash")), true);
});

test("the folder cap drops the lowest-ranked folders and reports them", () => {
  const many: FolderInfo[] = [folder("INBOX", "\\Inbox")];
  for (let i = 0; i < 40; i += 1) many.push(folder(`Folder-${String(i).padStart(2, "0")}`));

  const scope = planFolderScope(many, { maxFolders: 5 });
  assert.equal(scope.folders.length, 5);
  assert.equal(scope.folders[0], "INBOX");
  assert.equal(scope.skipped.length, 36);
  // Everything that was asked for is accounted for either way.
  assert.equal(scope.folders.length + scope.skipped.length, many.length);
});

test("the default folder cap applies when none is given", () => {
  const many: FolderInfo[] = [];
  for (let i = 0; i < DEFAULT_MAX_FOLDERS + 10; i += 1) many.push(folder(`F-${i}`));
  const scope = planFolderScope(many, {});
  assert.equal(scope.folders.length, DEFAULT_MAX_FOLDERS);
});

function hit(overrides: Partial<SearchHit> & Pick<SearchHit, "folder" | "uid">): SearchHit {
  return {
    mailbox: "personal",
    messageId: null,
    from: "someone@example.com",
    subject: "Test",
    date: "2026-07-01T00:00:00.000Z",
    snippet: "",
    unseen: false,
    ...overrides,
  };
}

test("the same message in INBOX and All Mail collapses to one result", () => {
  const merged = mergeSearchResults(
    [
      hit({ folder: "INBOX", uid: 10, messageId: "<abc@example.com>" }),
      hit({ folder: "[Gmail]/All Mail", uid: 99, messageId: "<abc@example.com>" }),
    ],
    50,
  );
  assert.equal(merged.results.length, 1);
  assert.equal(merged.deduped, 1);
  // First copy seen wins, and callers feed folders in scope order, so the
  // operator gets the INBOX location — the one they can act on.
  assert.equal(merged.results[0].folder, "INBOX");
  assert.equal(merged.results[0].uid, 10);
});

test("the same message in two different mailboxes stays as two results", () => {
  const merged = mergeSearchResults(
    [
      hit({ mailbox: "personal", folder: "INBOX", uid: 1, messageId: "<shared@example.com>" }),
      hit({ mailbox: "sales", folder: "INBOX", uid: 4, messageId: "<shared@example.com>" }),
    ],
    50,
  );
  assert.equal(merged.results.length, 2);
  assert.equal(merged.deduped, 0);
});

test("messages without a Message-ID are never merged together", () => {
  const merged = mergeSearchResults(
    [
      hit({ folder: "INBOX", uid: 1, messageId: null }),
      hit({ folder: "INBOX", uid: 2, messageId: null }),
      hit({ folder: "Archive", uid: 1, messageId: null }),
    ],
    50,
  );
  assert.equal(merged.results.length, 3);
  assert.equal(merged.deduped, 0);
});

test("results are newest first across folders", () => {
  const merged = mergeSearchResults(
    [
      hit({ folder: "Archive", uid: 1, date: "2026-01-01T00:00:00.000Z", subject: "oldest" }),
      hit({ folder: "INBOX", uid: 2, date: "2026-07-01T00:00:00.000Z", subject: "newest" }),
      hit({ folder: "INBOX", uid: 3, date: "2026-03-01T00:00:00.000Z", subject: "middle" }),
    ],
    50,
  );
  assert.deepEqual(
    merged.results.map((r) => r.subject),
    ["newest", "middle", "oldest"],
  );
});

test("messages with no date sort last instead of jumbling the top", () => {
  const merged = mergeSearchResults(
    [
      hit({ folder: "INBOX", uid: 1, date: "", subject: "undated" }),
      hit({ folder: "INBOX", uid: 2, date: "2026-02-01T00:00:00.000Z", subject: "dated" }),
    ],
    50,
  );
  assert.deepEqual(
    merged.results.map((r) => r.subject),
    ["dated", "undated"],
  );
});

test("the limit truncates and says so", () => {
  const hits = [
    hit({ folder: "INBOX", uid: 1, date: "2026-01-01T00:00:00.000Z" }),
    hit({ folder: "INBOX", uid: 2, date: "2026-02-01T00:00:00.000Z" }),
    hit({ folder: "INBOX", uid: 3, date: "2026-03-01T00:00:00.000Z" }),
  ];
  const merged = mergeSearchResults(hits, 2);
  assert.equal(merged.results.length, 2);
  assert.equal(merged.truncated, true);

  const untruncated = mergeSearchResults(hits, 3);
  assert.equal(untruncated.truncated, false);
});

test("truncation counts deduped rows only once", () => {
  // Two raw hits, one message: that is one result and must not report as
  // truncated just because the input was longer than the limit.
  const merged = mergeSearchResults(
    [
      hit({ folder: "INBOX", uid: 1, messageId: "<x@example.com>" }),
      hit({ folder: "[Gmail]/All Mail", uid: 2, messageId: "<x@example.com>" }),
    ],
    1,
  );
  assert.equal(merged.results.length, 1);
  assert.equal(merged.truncated, false);
});
