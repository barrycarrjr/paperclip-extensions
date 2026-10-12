/**
 * The review queue through the worker, the way agents and the operator UI
 * reach it: the real setup() under the SDK test harness, with a real Postgres
 * behind ctx.db.
 *
 * The behaviours worth pinning: both agent tools are declared in the manifest
 * and answer; a message without a Message-ID does not fail the write and an
 * entry that cannot be stored is skipped, not fatal; the Auto-triage / Keep /
 * Mute buttons (email.set-rule) clear the sender's entry whatever case the
 * mailbox key arrives in, and still succeed when the clear fails; Dismiss
 * clears an address and its whole-domain entry; the import can be run twice;
 * the expiry setting is honoured; and a company outside the mailbox's allow
 * list gets nothing.
 */
import { after, before, test } from "node:test";
import { strict as assert } from "node:assert";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { ToolResult } from "@paperclipai/plugin-sdk";
import manifest from "./manifest.js";
import plugin from "./worker.js";
import { openPluginDb } from "./pglite-db.js";

const COMPANY = "aaaaaaaa-1111-4222-8333-444444444444";
const OUTSIDER = "bbbbbbbb-5555-4666-8777-888888888888";

let harness: TestHarness;
let opened: Awaited<ReturnType<typeof openPluginDb>>;

before(async () => {
  harness = createTestHarness({
    manifest,
    config: {
      reviewQueueExpiryDays: 30,
      mailboxes: [
        {
          key: "personal",
          name: "Personal",
          imapHost: "imap.example.com",
          user: "pat@example.com",
          allowedCompanies: [COMPANY],
        },
      ],
    },
  });
  opened = await openPluginDb();
  (harness.ctx as { db: unknown }).db = opened.db;
  await plugin.definition.setup(harness.ctx);
});

after(async () => {
  await plugin.definition.onShutdown?.();
  await opened.pg.close();
});

function tool(name: string, params: unknown, companyId = COMPANY): Promise<ToolResult> {
  return harness.executeTool<ToolResult>(name, params, { companyId });
}

async function waiting(): Promise<Array<{ sender: string; messageCount: number }>> {
  const r = await tool("email_list_review_queue", { mailbox: "personal" });
  assert.equal(r.error, undefined, r.error);
  return (r.data as { entries: Array<{ sender: string; messageCount: number }> }).entries.sort((a, b) =>
    a.sender.localeCompare(b.sender),
  );
}

async function senders(): Promise<string[]> {
  return (await waiting()).map((e) => e.sender);
}

const recent = () => new Date(Date.now() - 86_400_000).toISOString();

test("both review-queue tools are declared in the manifest", () => {
  const declared = new Set((manifest.tools ?? []).map((t) => t.name));
  assert.ok(declared.has("email_add_to_review_queue"));
  assert.ok(declared.has("email_list_review_queue"));
});

test("an agent queues senders straight from search results, null Message-IDs included", async () => {
  const added = await tool("email_add_to_review_queue", {
    mailbox: "personal",
    entries: [
      {
        sender: "Shop Example <promo@shop.example.com>",
        messages: [
          { messageId: "<1@shop>", uid: 101 },
          { messageId: null, uid: 102 },
        ],
        subject: "Autumn sale",
        note: "Marketing list, unsubscribe link present.",
        suggestedRule: "auto-triage",
      },
      { sender: "pat.lee@example.org", messageIds: [null], note: "Looks like a real person." },
    ],
  });
  assert.equal(added.error, undefined, added.error);
  assert.match(added.content ?? "", /2 added, 0 updated/);
  assert.deepEqual(
    (await waiting()).map((e) => [e.sender, e.messageCount]),
    [
      ["pat.lee@example.org", 1],
      ["promo@shop.example.com", 2],
    ],
  );

  // The next run sees the same unread mail again.
  await tool("email_add_to_review_queue", {
    mailbox: "personal",
    entries: [{ sender: "promo@shop.example.com", messages: [{ messageId: null, uid: 102 }] }],
  });
  assert.equal((await waiting()).find((e) => e.sender === "promo@shop.example.com")?.messageCount, 2);
});

test("an entry that cannot be stored is skipped and reported, the rest are stored", async () => {
  const r = await tool("email_add_to_review_queue", {
    mailbox: "personal",
    entries: [{ sender: "fine@example.com" }, { sender: "o'brien@example.com" }, { sender: "not a sender" }],
  });
  assert.equal(r.error, undefined, r.error);
  const data = r.data as { added: string[]; skipped: Array<{ index: number; reason: string }> };
  assert.deepEqual(data.added, ["fine@example.com"]);
  assert.deepEqual(data.skipped.map((s) => s.index), [1, 2]);
  assert.match(r.content ?? "", /2 skipped/);
  assert.ok((await senders()).includes("fine@example.com"));
});

test("a rule set with the mailbox key in another case still clears the sender's entry", async () => {
  const result = await harness.performAction<{ ok: boolean; clearedReviewEntries: number }>(
    "email.set-rule",
    {
      companyId: COMPANY,
      mailbox: "PERSONAL",
      senderPattern: "Pat.Lee@example.org",
      // keep-always: auto-triage and mute also sweep the mailbox over IMAP.
      ruleType: "keep-always",
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.clearedReviewEntries, 1);
  assert.ok(!(await senders()).includes("pat.lee@example.org"));
});

test("set-rule succeeds and logs when the clear fails, and the sender is still hidden", async () => {
  opened.failWhen(/DELETE FROM \S*email_review_queue/);
  try {
    const result = await harness.performAction<{ ok: boolean; clearedReviewEntries: number }>(
      "email.set-rule",
      { companyId: COMPANY, mailbox: "personal", senderPattern: "fine@example.com", ruleType: "keep-always" },
    );
    assert.equal(result.ok, true);
    assert.equal(result.clearedReviewEntries, 0);
  } finally {
    opened.failWhen(null);
  }
  assert.ok(harness.logs.some((l) => l.level === "warn" && /not cleared/.test(l.message)));
  assert.ok(!(await senders()).includes("fine@example.com"));
});

test("Dismiss clears an address and its domain's whole-domain entry", async () => {
  await tool("email_add_to_review_queue", {
    mailbox: "personal",
    entries: [{ sender: "@shop.example.com", note: "Whole domain looks like marketing." }],
  });
  const result = await harness.performAction<{ ok: boolean; cleared: number }>("email.dismiss-review-entry", {
    companyId: COMPANY,
    mailbox: "personal",
    sender: "promo@shop.example.com",
  });
  assert.deepEqual(result, { ok: true, cleared: 2 });
  assert.deepEqual(await senders(), []);
  // A Brief row keyed on a bare display name can never have been queued.
  const nameOnly = await harness.performAction("email.dismiss-review-entry", {
    companyId: COMPANY,
    mailbox: "personal",
    sender: "pat example",
  });
  assert.deepEqual(nameOnly, { ok: true, cleared: 0 });
});

test("the import can run twice: covered senders are reported, old ones skipped, counts unchanged", async () => {
  const batch = {
    companyId: COMPANY,
    mailbox: "personal",
    entries: [
      { sender: "pat.lee@example.org", count: 3, lastSeenAt: recent() },
      { sender: "offers@deals.example.net", count: 2, lastSeenAt: recent() },
      { sender: "ancient@example.net", count: 1, lastSeenAt: "2026-01-01T00:00:00Z" },
    ],
  };
  const first = await harness.performAction<{
    ok: boolean;
    added: string[];
    updated: string[];
    alreadyRuled: string[];
    skipped: Array<{ reason: string }>;
  }>("email.add-to-review-queue", batch);
  assert.equal(first.ok, true);
  assert.deepEqual(first.alreadyRuled, ["pat.lee@example.org"]);
  assert.deepEqual(first.added, ["offers@deals.example.net"]);
  assert.match(first.skipped[0]?.reason ?? "", /older than the review-queue expiry/);

  const second = await harness.performAction<{ updated: string[] }>("email.add-to-review-queue", batch);
  assert.deepEqual(second.updated, ["offers@deals.example.net"]);
  const listed = await harness.getData<{ entries: Array<{ sender: string; messageCount: number }>; total: number }>(
    "email.list-review-queue",
    { companyId: COMPANY, mailbox: "personal" },
  );
  assert.deepEqual(
    listed.entries.map((e) => [e.sender, e.messageCount]),
    [["offers@deals.example.net", 2]],
  );
  assert.equal(listed.total, 1);
});

test("a company outside the mailbox's allow list gets nothing", async () => {
  const read = await tool("email_list_review_queue", { mailbox: "personal" }, OUTSIDER);
  assert.ok(read.error, "listing must be refused");
  const write = await tool(
    "email_add_to_review_queue",
    { mailbox: "personal", entries: [{ sender: "x@example.com" }] },
    OUTSIDER,
  );
  assert.ok(write.error, "adding must be refused");
  await assert.rejects(
    harness.performAction("email.dismiss-review-entry", {
      companyId: OUTSIDER,
      mailbox: "personal",
      sender: "offers@deals.example.net",
    }),
  );
  assert.deepEqual(await senders(), ["offers@deals.example.net"]);
});
