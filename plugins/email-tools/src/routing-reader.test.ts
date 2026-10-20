import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { ImapFlow } from "imapflow";
import { readRoutingMessage } from "./routing-reader.js";
import { parseReplySelector, resolveReplySelector } from "./reply-selector.js";
import { buildMailboxRuntime, clearSecretCache } from "./poll.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";

const ID = "<fixture@example.com>";
const raw = `From: Example <sender@example.com>\r\nTo: clerk@example.com\r\nSubject: Invented update\r\nDate: Sun, 18 Oct 2026 12:00:00 +0000\r\nMessage-ID: ${ID}\r\n\r\nSynthetic text.\r\n`;
function fixture() {
  const calls = { locks: [] as unknown[], fetch: [] as unknown[], downloads: [] as unknown[], releases: 0 };
  let validity = 42n;
  let messageId = ID;
  let matches = [7];
  let missing = false;
  const client = {
    get mailbox() { return { uidValidity: validity }; },
    getMailboxLock: async (folder: string, options?: unknown) => { calls.locks.push({ folder, options }); return { release() { calls.releases++; } }; },
    fetchOne: async (uid: string, query: Record<string, unknown>, options: unknown) => {
      calls.fetch.push({ uid, query, options });
      if (missing) return false;
      return { uid: 7, headers: Buffer.from(raw.replace(ID, messageId)), source: Buffer.from(raw.replace(ID, messageId)), envelope: { messageId },
        bodyStructure: { type: "multipart/mixed", childNodes: [
          { type: "text/plain", part: "1", size: 12 },
          { type: "application/pdf", part: "2", size: 10000000, disposition: "attachment", dispositionParameters: { filename: "invented.pdf" } },
        ] } };
    },
    download: async (uid: string, part: string, options: unknown) => { calls.downloads.push({ uid, part, options }); return { content: Readable.from([Buffer.from("Synthetic current plain text.")]) }; },
    search: async () => matches,
  } as unknown as ImapFlow;
  return { client, calls, setValidity(n: bigint) { validity = n; }, setId(s: string) { messageId = s; }, setMatches(m: number[]) { matches = m; }, setMissing() { missing = true; } };
}
const locator = { folder: "INBOX", uid: 7, uidValidity: "42", messageId: ID };

test("routing reader uses EXAMINE/PEEK-shaped fetches, reads text only and returns bounded metadata without attachment bytes", async () => {
  const f = fixture(); const r = await readRoutingMessage(f.client, locator);
  assert.equal(r.parsed.messageId, ID); assert.equal(r.uidValidity, "42"); assert.equal(r.parsed.text, "Synthetic current plain text.");
  assert.deepEqual(f.calls.locks, [{ folder: "INBOX", options: { readOnly: true } }]); assert.equal(f.calls.releases, 1);
  assert.deepEqual(f.calls.downloads, [{ uid: "7", part: "1", options: { uid: true, maxBytes: 24000, chunkSize: 8192 } }]);
  assert.deepEqual(r.parsed.attachments, [{ name: "invented.pdf", mime: "application/pdf", size: 10000000, partId: "2", inline: false }]);
  assert.ok(!JSON.stringify(f.calls.fetch).includes('"source"'));
});

test("routing reader refuses changed UIDVALIDITY, changed header or missing message before downloading", async () => {
  for (const change of [(f: ReturnType<typeof fixture>) => f.setValidity(43n), (f: ReturnType<typeof fixture>) => f.setId("<different@example.com>"), (f: ReturnType<typeof fixture>) => f.setMissing()]) {
    const f = fixture(); change(f); await assert.rejects(readRoutingMessage(f.client, locator), /MISMATCH|NOT_FOUND/);
    assert.equal(f.calls.downloads.length, 0); assert.equal(f.calls.releases, 1);
  }
});

test("reply selectors are strictly exclusive, bounded and preserve UID lookup", async () => {
  for (const p of [{}, { uid: 7, messageId: ID }, { uid: 0 }, { uid: 1.5 }, { uid: 4294967296 }, { messageId: "bad" }, { messageId: "<a\r\n@example.com>" }]) assert.throws(() => parseReplySelector(p), /EREPLY_SELECTOR/);
  assert.deepEqual(parseReplySelector({ uid: 7 }), { uid: 7 }); assert.deepEqual(parseReplySelector({ messageId: ID }), { messageId: ID });
  const f = fixture(); const message = await resolveReplySelector(f.client, "Archive", { uid: 7 });
  assert.equal(message!.uid, 7); assert.equal(message!.messageId, ID); assert.equal(f.calls.fetch.length, 1);
});

test("Message-ID reply resolves real current UID and exact header in selected folder", async () => {
  const f = fixture(); const message = await resolveReplySelector(f.client, "INBOX", { messageId: ID });
  assert.equal(message!.uid, 7); assert.equal(message!.messageId, ID); assert.equal(f.calls.fetch.length, 2);
  assert.equal(f.calls.releases, 3);
});

test("Message-ID reply refuses missing, ambiguous, substring-mismatched and reset identities", async () => {
  for (const matches of [[], [7, 8]]) {
    const f = fixture(); f.setMatches(matches); await assert.rejects(resolveReplySelector(f.client, "INBOX", { messageId: ID }), /missing or ambiguous/);
  }
  const mismatch = fixture(); mismatch.setId("<prefix-fixture@example.com>");
  await assert.rejects(resolveReplySelector(mismatch.client, "INBOX", { messageId: ID }), /exact Message-ID/);
  const reset = fixture(); let calls = 0; const original = reset.client.getMailboxLock.bind(reset.client);
  reset.client.getMailboxLock = async (...args) => { if (++calls === 2) reset.setValidity(43n); return original(...args); };
  await assert.rejects(resolveReplySelector(reset.client, "INBOX", { messageId: ID }), /changed or disappeared/);
});

test("routing credential reads observe rotation at the same reference instead of using the legacy mailbox cache", async () => {
  clearSecretCache(); let version = 1;
  const ctx = { secrets: { resolve: async () => `synthetic-version-${version}` } } as unknown as PluginContext;
  const cfg = { key: "synthetic", imapHost: "imap.example.com", user: "clerk@example.com", pass: "synthetic-reference" };
  const first = await buildMailboxRuntime(ctx, cfg, cfg.key, undefined, { freshCredentials: true });
  version = 2;
  const second = await buildMailboxRuntime(ctx, cfg, cfg.key, undefined, { freshCredentials: true });
  assert.equal(first.pass, "synthetic-version-1"); assert.equal(second.pass, "synthetic-version-2"); clearSecretCache();
});
