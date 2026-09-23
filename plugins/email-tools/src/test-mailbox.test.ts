/**
 * Tests for the two Test connection checks this plugin's Sent copies depend
 * on. Both are what an operator reads before trusting, or overriding, the
 * automatic choices, so a misleading line here leads straight to a wrong
 * setting.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import type { ImapFlow, ListResponse } from "imapflow";
import { markSupportCheck, sentFolderCheck } from "./test-mailbox.js";
import type { ConfigMailbox } from "./types.js";

test("the marks check tells silence, an empty list and a full list apart", () => {
  assert.match(markSupportCheck(undefined).message, /did not list/);
  assert.match(markSupportCheck(new Set()).message, /keeps no flags in this folder/);
  assert.match(markSupportCheck(new Set(["\\Answered", "$Forwarded"])).message, /can both be kept/);
  assert.match(markSupportCheck(new Set(["\\Answered", "\\*"])).message, /can both be kept/);
  assert.match(markSupportCheck(new Set(["\\Answered", "\\Seen"])).message, /no forwarded mark/);
});

function client(statusAnswer: unknown): ImapFlow {
  const entries = [
    { path: "INBOX", name: "INBOX", delimiter: ".", parent: [], flags: new Set() },
    { path: "INBOX.Sent Items", name: "Sent Items", delimiter: ".", parent: ["INBOX"], flags: new Set() },
  ] as unknown as ListResponse[];
  return {
    list: async () => entries,
    status: async () => statusAnswer,
    mailbox: false,
  } as unknown as ImapFlow;
}

const RACKSPACE: ConfigMailbox = { key: "m3-barry", imapHost: "secure.emailsrvr.com", smtpHost: "secure.emailsrvr.com" };

test("the Sent folder check gives the count when the server gives one", async () => {
  const check = await sentFolderCheck(client({ path: "INBOX.Sent Items", messages: 767 }), RACKSPACE);
  assert.equal(check.passed, true);
  assert.match(check.message, /"INBOX\.Sent Items" \(767 messages\)/);
});

test("a folder the server will not count is not reported as empty", async () => {
  // imapflow answers false on a refusal; printing that as 0 invites someone to
  // "correct" the setting to the near-empty folder.
  const check = await sentFolderCheck(client(false), RACKSPACE);
  assert.equal(check.passed, true);
  assert.doesNotMatch(check.message, /\(0 messages\)/);
  assert.match(check.message, /would not say how many/);
});

test("a typed Sent folder the server will not open fails the check", async () => {
  const check = await sentFolderCheck(client(false), { ...RACKSPACE, sentFolder: "INBOX.Sent Itemz" });
  assert.equal(check.passed, false);
  assert.match(check.message, /would not open "INBOX\.Sent Itemz"/);
});

test("Gmail is reported as keeping its own copy, without looking for a folder", async () => {
  const check = await sentFolderCheck(client(false), { key: "personal", imapHost: "imap.gmail.com" });
  assert.equal(check.passed, true);
  assert.match(check.message, /Gmail keeps its own copy/);
});
