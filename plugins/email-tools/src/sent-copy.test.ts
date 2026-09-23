/**
 * Tests for the copy saved to Sent and the mark set on the original.
 *
 * The behaviours worth pinning: the copy lands in the Sent folder the
 * mailbox's own mail programs use (on Rackspace that is the full "Sent Items",
 * not the near-empty "Sent" beside it), providers that file their own copy are
 * left alone, a copy is never uploaded twice, the replied and forwarded flags
 * are only reported as set once the server shows them, no follow-up failure
 * can stop the other one, and every send path in the worker goes through the
 * one function that does all of this.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import type { ListResponse } from "imapflow";
import { ANSWERED_FLAG, FORWARDED_FLAG } from "./imap.js";
import { toMailOptions } from "./mail-options.js";
import {
  awaitFollowUps,
  buildSentCopy,
  markOriginal,
  pickSentFolder,
  providerFilingSentCopy,
  recordSend,
  resolveSentFolder,
  sentFolderCandidates,
  uploadSentCopy,
  type ImapRunner,
  type SentCopyClient,
} from "./sent-copy.js";

interface FakeFolder {
  path: string;
  flags?: string[];
  specialUse?: string;
  /** "extension" = the server labelled it, "name" = imapflow guessed. */
  specialUseSource?: string;
  messages?: number;
  /** Message-IDs already in the folder, by UID. */
  messageIds?: Record<number, string>;
}

// Shaped like imapflow's LIST entries: `name` is the last segment and `parent`
// the segments above it, split on the server's delimiter.
function listEntry(f: FakeFolder): ListResponse {
  const delimiter = f.path.startsWith("[Gmail]") || !f.path.includes(".") ? "/" : ".";
  const segments = f.path.split(delimiter);
  return {
    path: f.path,
    name: segments[segments.length - 1],
    delimiter,
    parent: segments.slice(0, -1),
    flags: new Set(f.flags ?? []),
    specialUse: f.specialUse,
    specialUseSource: f.specialUseSource,
  } as unknown as ListResponse;
}

function fakeClient(opts: {
  folders: FakeFolder[];
  /** Flags each message in the opened folder carries, by UID. */
  messageFlags?: Record<number, string[]>;
  /** PERMANENTFLAGS the server reports; undefined = not reported. */
  permanentFlags?: string[];
  /** False = the server acknowledges STORE and then ignores it. */
  keepsFlags?: boolean;
  appendResult?: unknown;
  /** STATUS throws for this folder. */
  failStatusFor?: string;
  /** STATUS answers false for this folder, as imapflow does on a NO. */
  refuseStatusFor?: string;
  /** The folder this connection already has open, as a pooled one might. */
  alreadyOpen?: string;
}) {
  const calls = {
    list: 0,
    status: [] as string[],
    appended: [] as Array<{ path: string; raw: string; flags?: string[]; idate?: unknown }>,
    stored: [] as Array<{ uids: unknown; flags: string[] }>,
    opened: [] as string[],
  };
  const flagsByUid = new Map<number, Set<string>>(
    Object.entries(opts.messageFlags ?? {}).map(([uid, fl]) => [Number(uid), new Set(fl)]),
  );
  let current: FakeFolder | undefined = opts.folders.find((x) => x.path === opts.alreadyOpen);
  const client = {
    list: async () => {
      calls.list += 1;
      return opts.folders.map(listEntry);
    },
    status: async (path: string) => {
      calls.status.push(path);
      if (path === opts.failStatusFor) throw new Error("STATUS failed");
      if (path === opts.refuseStatusFor) return false;
      const f = opts.folders.find((x) => x.path === path);
      if (!f) throw new Error(`Mailbox doesn't exist: ${path}`);
      return { path, messages: f.messages ?? 0 };
    },
    getMailboxLock: async (path: string) => {
      calls.opened.push(path);
      current = opts.folders.find((x) => x.path === path);
      if (!current) throw new Error(`Mailbox doesn't exist: ${path}`);
      return { path, release: () => undefined };
    },
    get mailbox() {
      if (!current) return false;
      return {
        path: current.path,
        exists: current.messages ?? 0,
        permanentFlags: opts.permanentFlags ? new Set(opts.permanentFlags) : undefined,
      };
    },
    search: async (query: { header?: Record<string, string> }) => {
      const wanted = query.header?.["message-id"];
      return Object.entries(current?.messageIds ?? {})
        .filter(([, id]) => wanted && id.includes(wanted))
        .map(([uid]) => Number(uid));
    },
    append: async (path: string, raw: Buffer, flags?: string[], idate?: unknown) => {
      calls.appended.push({ path, raw: raw.toString("utf8"), flags, idate });
      return opts.appendResult === undefined ? { destination: path, uid: 99 } : opts.appendResult;
    },
    messageFlagsAdd: async (uids: unknown, flags: string[]) => {
      calls.stored.push({ uids, flags });
      if (opts.keepsFlags === false) return true;
      for (const uid of uids as number[]) {
        const set = flagsByUid.get(uid);
        if (set) for (const f of flags) set.add(f);
      }
      return true;
    },
    fetchOne: async (uid: string) => {
      const n = Number(uid);
      const set = flagsByUid.get(n);
      const messageId = current?.messageIds?.[n];
      if (!set && !messageId) return false;
      return { uid: n, flags: new Set(set ?? []), envelope: { messageId } };
    },
  };
  return { client: client as unknown as SentCopyClient, calls };
}

// The M3 Media mailbox's real layout on 2026-09-23 (Rackspace): a "Sent" with
// 4 messages from 2024 beside the "Sent Items" every mail program uses, and an
// archive subfolder whose name only resembles a Sent folder.
const RACKSPACE: FakeFolder[] = [
  { path: "INBOX", specialUse: "\\Inbox", specialUseSource: "name" },
  { path: "INBOX.Drafts" },
  { path: "INBOX.Sent", specialUse: "\\Sent", specialUseSource: "name", messages: 4 },
  { path: "INBOX.Sent Items", messages: 2345 },
  { path: "INBOX.Brooks Old Emails.Sent Emails", messages: 700 },
  { path: "INBOX.Trash" },
];

test("providerFilingSentCopy names only the SMTP services that file their own copy", () => {
  assert.equal(providerFilingSentCopy("smtp.gmail.com"), "Gmail");
  assert.equal(providerFilingSentCopy(" SMTP.GMAIL.COM "), "Gmail");
  assert.equal(providerFilingSentCopy("smtp.googlemail.com"), "Gmail");
  assert.equal(providerFilingSentCopy("smtp.office365.com"), "Microsoft 365");
  assert.equal(providerFilingSentCopy("smtp-mail.outlook.com"), "Microsoft 365");
  assert.equal(providerFilingSentCopy("anything.example.com", "oauth2"), "Microsoft 365");
  // Google's relay files nothing, so it must not be mistaken for Gmail.
  assert.equal(providerFilingSentCopy("smtp-relay.gmail.com"), null);
  assert.equal(providerFilingSentCopy("secure.emailsrvr.com"), null);
  assert.equal(providerFilingSentCopy("", "basic"), null);
});

test("on a Rackspace mailbox the copy goes to the Sent Items folder that holds the mail", async () => {
  const { client, calls } = fakeClient({ folders: RACKSPACE });
  const picked = await resolveSentFolder(client);
  assert.equal(picked?.path, "INBOX.Sent Items");
  assert.match(picked?.reason ?? "", /most mail/);
  // Only the two real candidates were counted; the archive subfolder is not one.
  assert.deepEqual(calls.status.sort(), ["INBOX.Sent", "INBOX.Sent Items"]);
});

test("candidates include server labels and translated names, and skip look-alikes and containers", () => {
  // imapflow labels one folder per role at most, so only one entry carries a
  // label here, as it would from a real server.
  const candidates = sentFolderCandidates(
    [
      { path: "[Gmail]", flags: ["\\Noselect"] },
      { path: "[Gmail]/Sent Mail", specialUse: "\\Sent", specialUseSource: "extension" },
      { path: "Sent" },
      { path: "Gesendete Elemente" },
      { path: "INBOX.Brooks Old Emails.Sent Emails" },
      { path: "Projects" },
    ].map(listEntry),
  );
  assert.deepEqual(
    candidates.map((c) => [c.path, c.serverFlagged]),
    [
      ["[Gmail]/Sent Mail", true],
      ["Sent", false],
      ["Gesendete Elemente", false],
    ],
  );
});

test("a translated Sent folder is found even when the library's one label went to an archive copy", async () => {
  // imapflow gives its name-guessed label to the alphabetically first match,
  // here an archive's copy, which is too deep to count. The real folder has
  // no label and no English name, and must still be found.
  const picked = await resolveSentFolder(
    fakeClient({
      folders: [
        { path: "INBOX" },
        { path: "Archiv" },
        { path: "Archiv.Gesendete Elemente", specialUse: "\\Sent", specialUseSource: "name", messages: 5000 },
        { path: "Gesendete Elemente", messages: 300 },
      ],
    }).client,
  );
  assert.equal(picked?.path, "Gesendete Elemente");
});

test("the server's own label settles a tie between equally full folders", () => {
  const picked = pickSentFolder([
    { path: "INBOX.Sent Items", serverFlagged: false, nameRank: 0, messages: 0 },
    { path: "INBOX.Sent", serverFlagged: true, nameRank: 1, messages: 0 },
  ]);
  assert.equal(picked?.path, "INBOX.Sent");
  assert.match(picked?.reason ?? "", /marks it as the Sent folder/);
});

test("with no label and no mail anywhere, 'Sent Items' is preferred to 'Sent'", () => {
  const picked = pickSentFolder([
    { path: "INBOX.Sent", serverFlagged: false, nameRank: 1, messages: 0 },
    { path: "INBOX.Sent Items", serverFlagged: false, nameRank: 0, messages: 0 },
  ]);
  assert.equal(picked?.path, "INBOX.Sent Items");
});

test("a single Sent folder is used without counting anything", async () => {
  const { client, calls } = fakeClient({ folders: [{ path: "INBOX" }, { path: "Sent", messages: 3 }] });
  const picked = await resolveSentFolder(client);
  assert.equal(picked?.path, "Sent");
  assert.equal(calls.status.length, 0);
  assert.equal(pickSentFolder([]), null);
});

test("a folder the server will not count does not lose to the one it will", async () => {
  // Counting it as empty would hand the copy to the 4-message "Sent", the
  // folder the operator never looks in. Without every count, the name decides.
  for (const refusal of [{ failStatusFor: "INBOX.Sent Items" }, { refuseStatusFor: "INBOX.Sent Items" }]) {
    const { client } = fakeClient({ folders: RACKSPACE, ...refusal });
    const picked = await resolveSentFolder(client);
    assert.equal(picked?.path, "INBOX.Sent Items");
    assert.match(picked?.reason ?? "", /would not count/);
  }
});

test("the folder already open on the connection is counted from the open mailbox", async () => {
  // IMAP discourages STATUS on the open folder, and some servers refuse it.
  const { client, calls } = fakeClient({
    folders: RACKSPACE,
    alreadyOpen: "INBOX.Sent Items",
    refuseStatusFor: "INBOX.Sent Items",
  });
  const picked = await resolveSentFolder(client);
  assert.equal(picked?.path, "INBOX.Sent Items");
  assert.match(picked?.reason ?? "", /most mail/);
  assert.deepEqual(calls.status, ["INBOX.Sent"]);
});

test("a Sent folder buried in an imported archive is not a candidate, however full", async () => {
  const picked = await resolveSentFolder(
    fakeClient({
      folders: [
        { path: "INBOX" },
        { path: "INBOX.Sent", messages: 900 },
        { path: "INBOX.Archive 2019.Sent Items", messages: 6000 },
        { path: "INBOX.Archive 2019" },
      ],
    }).client,
  );
  assert.equal(picked?.path, "INBOX.Sent");
  // A folder the server itself labels \Sent still counts wherever it lives.
  const labelled = sentFolderCandidates(
    [{ path: "Accounts.Main.Outbox Copies", specialUse: "\\Sent", specialUseSource: "extension" }].map(listEntry),
  );
  assert.deepEqual(labelled.map((c) => c.path), ["Accounts.Main.Outbox Copies"]);
});

test("a folder named in the settings is used as given, without asking the server", async () => {
  const { client, calls } = fakeClient({ folders: RACKSPACE });
  const picked = await resolveSentFolder(client, "  INBOX.Sent  ");
  assert.deepEqual(picked, { path: "INBOX.Sent", reason: "set in the mailbox settings" });
  assert.equal(calls.list, 0);
  // Blank is the same as not set.
  assert.equal((await resolveSentFolder(client, "   "))?.path, "INBOX.Sent Items");
});

test("the copy is what was sent, with the same Message-ID and Date, and keeps the Bcc line", async () => {
  const date = new Date("2026-09-23T16:52:14.000Z");
  const mail = toMailOptions(
    {
      from: "owner@example.com",
      to: ["jordan@example.org"],
      bcc: "records@example.com",
      subject: "Re: Catching up",
      body: "Hi Jordan, great to hear from you!",
      inReplyTo: "original-123@example.org",
      references: ["original-123@example.org"],
      attachments: [{ name: "quote.pdf", mime: "application/pdf", contentBase64: Buffer.from("%PDF-1.4").toString("base64") }],
    },
    date,
  );
  const raw = (await buildSentCopy(mail, "<1f2e3d4c-5b6a-7980-a1b2-c3d4e5f60718@example.com>")).toString("utf8");
  assert.match(raw, /^Message-ID: <1f2e3d4c-5b6a-7980-a1b2-c3d4e5f60718@example\.com>$/m);
  assert.match(raw, /^Date: Wed, 23 Sep 2026 16:52:14 \+0000$/m);
  assert.match(raw, /^Bcc: records@example\.com$/m);
  assert.match(raw, /^To: jordan@example\.org$/m);
  assert.match(raw, /^In-Reply-To: <original-123@example\.org>$/m);
  assert.match(raw, /^Subject: Re: Catching up$/m);
  assert.match(raw, /filename=quote\.pdf/);
  assert.match(raw, /Hi Jordan, great to hear from you!/);
});

test("the copy is uploaded read, with the send time, into the chosen folder", async () => {
  const { client, calls } = fakeClient({ folders: RACKSPACE });
  const date = new Date("2026-09-23T16:52:14.000Z");
  const outcome = await uploadSentCopy(client, { raw: Buffer.from("raw message"), messageId: "<a@b>", date });
  assert.deepEqual(outcome, { ok: true, folder: "INBOX.Sent Items" });
  assert.equal(calls.appended.length, 1);
  assert.equal(calls.appended[0].path, "INBOX.Sent Items");
  assert.deepEqual(calls.appended[0].flags, ["\\Seen"]);
  assert.equal(calls.appended[0].idate, date);
});

test("a copy already in the folder is not uploaded a second time", async () => {
  const folders = RACKSPACE.map((f) =>
    f.path === "INBOX.Sent Items" ? { ...f, messageIds: { 812: "<a@b>" } } : f,
  );
  const { client, calls } = fakeClient({ folders });
  const outcome = await uploadSentCopy(client, { raw: Buffer.from("x"), messageId: "<a@b>", date: new Date() });
  assert.deepEqual(outcome, { ok: true, folder: "INBOX.Sent Items", alreadyThere: true });
  assert.equal(calls.appended.length, 0);
});

test("no Sent folder, a refused upload, and a missing named folder each come back as a reason", async () => {
  const none = fakeClient({ folders: [{ path: "INBOX" }, { path: "Archive" }] });
  const noFolder = await uploadSentCopy(none.client, { raw: Buffer.from("x"), messageId: "<a@b>", date: new Date() });
  assert.equal(noFolder.ok, false);
  assert.match(noFolder.error ?? "", /no Sent folder.*'Sent folder' setting/);

  const refused = fakeClient({ folders: RACKSPACE, appendResult: false });
  const refusedOutcome = await uploadSentCopy(refused.client, { raw: Buffer.from("x"), messageId: "", date: new Date() });
  assert.deepEqual(refusedOutcome, {
    ok: false,
    folder: "INBOX.Sent Items",
    error: 'The mail server refused the copy for "INBOX.Sent Items".',
  });

  const typo = fakeClient({ folders: RACKSPACE });
  const typoOutcome = await uploadSentCopy(typo.client, {
    raw: Buffer.from("x"),
    messageId: "<a@b>",
    date: new Date(),
    configuredFolder: "INBOX.Sent Itemz",
  });
  assert.equal(typoOutcome.ok, false);
  assert.equal(typoOutcome.folder, "INBOX.Sent Itemz");
  assert.match(typoOutcome.error ?? "", /doesn't exist/);
});

test("a reply marks the original answered, and says so only once the server shows it", async () => {
  const { client, calls } = fakeClient({
    folders: RACKSPACE,
    messageFlags: { 279427: ["\\Seen"] },
    permanentFlags: ["\\Answered", "\\Flagged", "\\Deleted", "\\Seen", "\\Draft", "\\*"],
  });
  const outcome = await markOriginal(client, { folder: "INBOX", uid: 279427, flag: ANSWERED_FLAG });
  assert.deepEqual(outcome, { ok: true, flag: "\\Answered", folder: "INBOX", uid: 279427 });
  assert.deepEqual(calls.stored, [{ uids: [279427], flags: ["\\Answered"] }]);
});

test("a server that cannot store the forwarded keyword is not asked, and says why", async () => {
  const { client, calls } = fakeClient({
    folders: RACKSPACE,
    messageFlags: { 5: [] },
    permanentFlags: ["\\Answered", "\\Seen"],
  });
  const outcome = await markOriginal(client, { folder: "INBOX", uid: 5, flag: FORWARDED_FLAG });
  assert.equal(outcome.ok, false);
  // A fixed property of the server, so the caller can keep quiet about it
  // instead of warning on every forward.
  assert.equal(outcome.unsupported, true);
  assert.match(outcome.error ?? "", /does not store the \$Forwarded flag/);
  assert.equal(calls.stored.length, 0);
});

test("an empty PERMANENTFLAGS list means nothing can be kept, not that the server was silent", async () => {
  // imapflow would drop the flag without asking the server, so the read-back
  // would fail and every reply from such a folder would warn.
  const { client, calls } = fakeClient({ folders: RACKSPACE, messageFlags: { 5: [] }, permanentFlags: [] });
  const outcome = await markOriginal(client, { folder: "INBOX", uid: 5, flag: ANSWERED_FLAG });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.unsupported, true);
  assert.equal(calls.stored.length, 0);
});

test("a server that ignores the command is reported, not claimed", async () => {
  const { client } = fakeClient({ folders: RACKSPACE, messageFlags: { 5: [] }, keepsFlags: false });
  const outcome = await markOriginal(client, { folder: "INBOX", uid: 5, flag: FORWARDED_FLAG });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error ?? "", /did not keep the \$Forwarded flag/);
});

test("the flag read-back ignores case, since servers may echo keywords differently", async () => {
  const { client } = fakeClient({ folders: RACKSPACE, messageFlags: { 5: ["$forwarded"] }, keepsFlags: false });
  const outcome = await markOriginal(client, { folder: "INBOX", uid: 5, flag: FORWARDED_FLAG });
  assert.equal(outcome.ok, true);
});

test("a UID that now holds a different message is left alone", async () => {
  // A UID only names a message within one folder; given the Message-ID too,
  // the message at that UID has to match before anything is marked.
  const folders = RACKSPACE.map((f) => (f.path === "INBOX" ? { ...f, messageIds: { 5: "<unrelated@x>" } } : f));
  const { client, calls } = fakeClient({ folders, messageFlags: { 5: [] } });
  const outcome = await markOriginal(client, { folder: "INBOX", uid: 5, messageId: "<orig@x>", flag: FORWARDED_FLAG });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.notFound, true);
  assert.equal(outcome.uid, 5);
  assert.equal(calls.stored.length, 0);
});

test("a UID whose Message-ID matches is marked, brackets or not", async () => {
  const folders = RACKSPACE.map((f) => (f.path === "INBOX" ? { ...f, messageIds: { 5: "<orig@x>" } } : f));
  const { client } = fakeClient({ folders, messageFlags: { 5: [] } });
  const outcome = await markOriginal(client, { folder: "INBOX", uid: 5, messageId: "orig@x", flag: ANSWERED_FLAG });
  assert.deepEqual(outcome, { ok: true, flag: "\\Answered", folder: "INBOX", uid: 5 });
});

test("an original known only by Message-ID is found first, and a miss is flagged as not found", async () => {
  const folders = RACKSPACE.map((f) => (f.path === "INBOX" ? { ...f, messageIds: { 41: "<orig@x>" } } : f));
  const found = fakeClient({ folders, messageFlags: { 41: [] } });
  const hit = await markOriginal(found.client, { folder: "INBOX", messageId: "<orig@x>", flag: ANSWERED_FLAG });
  assert.deepEqual(hit, { ok: true, flag: "\\Answered", folder: "INBOX", uid: 41 });

  const missing = fakeClient({ folders });
  const miss = await markOriginal(missing.client, { folder: "INBOX", messageId: "<other@x>", flag: ANSWERED_FLAG });
  assert.equal(miss.ok, false);
  assert.equal(miss.notFound, true);
  assert.equal(miss.uid, undefined);
  assert.equal(missing.calls.stored.length, 0);
});

function runnerOn(client: SentCopyClient, used: string[], name: string): ImapRunner {
  return (fn) => {
    used.push(name);
    return fn(client);
  };
}

test("a failed copy does not stop the original being marked", async () => {
  const { client, calls } = fakeClient({
    folders: [{ path: "INBOX" }],
    messageFlags: { 7: [] },
  });
  const used: string[] = [];
  const record = await recordSend(
    { own: runnerOn(client, used, "own"), shared: runnerOn(client, used, "shared") },
    {
      copy: { raw: Buffer.from("x"), messageId: "<a@b>", date: new Date() },
      mark: { folder: "INBOX", uid: 7, flag: ANSWERED_FLAG },
    },
  );
  assert.equal(record.sentCopy?.ok, false);
  assert.equal(record.original?.ok, true);
  assert.equal(calls.stored.length, 1);
});

test("the copy uploads on its own connection and the mark uses the shared one", async () => {
  // A large copy on the shared connection would hold up the next send, which
  // has to fetch its original over that connection first.
  const { client } = fakeClient({ folders: RACKSPACE, messageFlags: { 7: [] } });
  const used: string[] = [];
  await recordSend(
    { own: runnerOn(client, used, "own"), shared: runnerOn(client, used, "shared") },
    {
      copy: { raw: Buffer.from("x"), messageId: "<a@b>", date: new Date() },
      mark: { folder: "INBOX", uid: 7, flag: ANSWERED_FLAG },
    },
  );
  assert.deepEqual(used.sort(), ["own", "shared"]);
  const onlyCopy: string[] = [];
  await recordSend(
    { own: runnerOn(client, onlyCopy, "own"), shared: runnerOn(client, onlyCopy, "shared") },
    { copy: { raw: Buffer.from("x"), messageId: "<b@b>", date: new Date() } },
  );
  assert.deepEqual(onlyCopy, ["own"]);
});

test("a connection that will not open becomes that step's outcome, and the other step still runs", async () => {
  const { client } = fakeClient({ folders: RACKSPACE, messageFlags: { 7: [] } });
  const record = await recordSend(
    {
      own: () => Promise.reject(new Error("login refused")),
      shared: (fn) => fn(client),
    },
    {
      copy: { raw: Buffer.from("x"), messageId: "<a@b>", date: new Date() },
      mark: { folder: "INBOX", uid: 7, flag: ANSWERED_FLAG },
    },
  );
  assert.deepEqual(record.sentCopy, { ok: false, error: "Could not open the mailbox: login refused" });
  assert.equal(record.original?.ok, true);
});

test("a partial Message-ID never marks an unrelated message", async () => {
  // IMAP's header search matches any header containing the text, so an agent
  // passing "812" as in_reply_to would otherwise hit both of these.
  const folders = RACKSPACE.map((f) =>
    f.path === "INBOX" ? { ...f, messageIds: { 41: "<orig-812@x>", 55: "<812@x>" } } : f,
  );
  const partial = fakeClient({ folders, messageFlags: { 41: [], 55: [] } });
  const miss = await markOriginal(partial.client, { folder: "INBOX", messageId: "812", flag: ANSWERED_FLAG });
  assert.equal(miss.ok, false);
  assert.equal(miss.notFound, true);
  assert.equal(partial.calls.stored.length, 0);

  const whole = fakeClient({ folders, messageFlags: { 41: [], 55: [] } });
  const hit = await markOriginal(whole.client, { folder: "INBOX", messageId: "812@x", flag: ANSWERED_FLAG });
  assert.equal(hit.uid, 55);
  assert.equal(hit.ok, true);
});

test("a copy is not skipped because some other message's ID contains its own", async () => {
  const folders = RACKSPACE.map((f) =>
    f.path === "INBOX.Sent Items" ? { ...f, messageIds: { 9: "<prefix-abc@x>" } } : f,
  );
  const { client, calls } = fakeClient({ folders });
  const outcome = await uploadSentCopy(client, { raw: Buffer.from("x"), messageId: "<abc@x>", date: new Date() });
  assert.deepEqual(outcome, { ok: true, folder: "INBOX.Sent Items" });
  assert.equal(calls.appended.length, 1);
});

test("follow-ups that finish in time come back as they are", async () => {
  const record = { sentCopy: { ok: true, folder: "INBOX.Sent Items" } };
  let late = 0;
  const got = await awaitFollowUps(Promise.resolve(record), 1000, () => (late += 1));
  assert.deepEqual(got, record);
  assert.equal(late, 0);
});

test("follow-ups that overrun stop being waited for, and still report how they ended", async () => {
  // The host gives up on a plugin call at 30 seconds and calls it failed,
  // though the mail has gone; answering late would invite a second send.
  let finish!: (r: { sentCopy: { ok: boolean; folder: string } }) => void;
  const work = new Promise<{ sentCopy: { ok: boolean; folder: string } }>((resolve) => (finish = resolve));
  const heard: unknown[] = [];
  const got = await awaitFollowUps(work, 5, (record, err) => heard.push(record ?? err));
  assert.equal(got, null);
  finish({ sentCopy: { ok: true, folder: "INBOX.Sent Items" } });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(heard, [{ sentCopy: { ok: true, folder: "INBOX.Sent Items" } }]);
});

test("a follow-up that fails in time rejects, and one that fails late is only heard about", async () => {
  await assert.rejects(awaitFollowUps(Promise.reject(new Error("login refused")), 1000, () => undefined), /login refused/);

  let fail!: (err: Error) => void;
  const work = new Promise<never>((_, reject) => (fail = reject));
  const heard: unknown[] = [];
  assert.equal(await awaitFollowUps(work, 5, (record, err) => heard.push(record ?? (err as Error).message)), null);
  fail(new Error("socket timeout"));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(heard, ["socket timeout"]);
});

test("no time left means no waiting at all", async () => {
  const got = await awaitFollowUps(new Promise(() => undefined), -3000, () => undefined);
  assert.equal(got, null);
});

test("every send in the worker goes through deliver, which saves the copy", () => {
  // Placement regression guard, same idea as the one in watch.test.ts. A send
  // path that called sendViaSmtp, or nodemailer, itself would deliver the mail
  // and quietly leave no copy in Sent, which is the exact failure this module
  // exists to end, and no test of the helpers above could notice.
  const src = readFileSync(new URL("./worker.ts", import.meta.url), "utf8");
  const sendViaSmtpAt = src.indexOf("async function sendViaSmtp(");
  const deliverAt = src.indexOf("async function deliver(");
  assert.ok(sendViaSmtpAt > 0 && deliverAt > sendViaSmtpAt, "sendViaSmtp and deliver should both exist");

  // Mentions of sendViaSmtp(: its definition, and one call inside deliver.
  const uses = [...src.matchAll(/sendViaSmtp\(/g)].map((m) => m.index ?? -1);
  assert.equal(uses.length, 2, "sendViaSmtp should be defined once and called once");
  assert.ok(uses[1] > deliverAt, "the one call should be inside deliver");

  // nodemailer's sendMail only inside sendViaSmtp.
  const sendMails = [...src.matchAll(/\.sendMail\(/g)].map((m) => m.index ?? -1);
  assert.equal(sendMails.length, 1, "only sendViaSmtp may call sendMail");
  assert.ok(sendMails[0] > sendViaSmtpAt && sendMails[0] < deliverAt);

  // email_send, email_reply, email.send-reply and email.send-new.
  assert.equal([...src.matchAll(/\bdeliver\(/g)].length, 5, "deliver's definition and its 4 callers");

  // Inside deliver: the too-late check comes before the send, and the
  // follow-ups are waited for on the call's own clock. Without these a send
  // could overrun the host's limit and be reported failed after it went out.
  const body = src.slice(deliverAt, src.indexOf("\nfunction logFollowUps(", deliverAt));
  const guardAt = body.indexOf("assertTimeToSend(startedAt");
  assert.ok(guardAt > 0 && guardAt < body.indexOf("sendViaSmtp("), "the too-late check must come before sending");
  assert.match(body, /awaitFollowUps\(\s*work,\s*followUpBudget\(startedAt, Date\.now\(\)\)/);

  // Every send handler starts its clock first thing, so the time spent
  // fetching the original counts.
  assert.equal([...src.matchAll(/const startedAt = Date\.now\(\);/g)].length, 4);
});
