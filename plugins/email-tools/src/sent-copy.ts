/**
 * A copy of every sent message in the mailbox's Sent folder, and the replied
 * or forwarded mark on the message it answered.
 *
 * SMTP only delivers a message. Keeping a copy for the sender is the sending
 * program's job: Outlook and webmail upload one over IMAP after every send.
 * Gmail and Microsoft 365 are the exceptions, and file a copy of anything sent
 * through their own SMTP servers. Rackspace, which hosts most of the mailboxes
 * this plugin was built for, files nothing, and the plugin never uploaded a
 * copy itself. So mail sent from Paperclip reached the recipient and left no
 * trace in the sender's own mailbox, and the sender's reasonable conclusion was
 * that it had never gone (2026-09-23: a reply that had arrived, and had
 * already been answered, looked unsent).
 *
 * The replied and forwarded icons a mail client shows come from flags on the
 * original message: the `\Answered` system flag and the `$Forwarded` keyword.
 * Mail clients set them when you reply or forward, and the plugin now does too.
 *
 * All of this runs after the message has gone, so none of it may fail the
 * send. Every step reports what happened instead of throwing.
 */
import type { ImapFlow, ListResponse } from "imapflow";
import imapflowSpecialUse from "imapflow/lib/special-use.js";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type Mail from "nodemailer/lib/mailer/index.js";
import { hasFlag } from "./imap.js";
import { nonBlank } from "./smtp-identity.js";

/** The part of ImapFlow used here, so the tests can hand in a stand-in. */
export type SentCopyClient = Pick<
  ImapFlow,
  "list" | "status" | "getMailboxLock" | "search" | "append" | "messageFlagsAdd" | "fetchOne" | "mailbox"
>;

/**
 * The provider that files its own copy of mail sent through its SMTP service,
 * or null when nobody does and the plugin has to upload one.
 *
 * Decided by the SMTP host, because that is the service doing the filing.
 * Google's relay (smtp-relay.gmail.com) is a different service that files
 * nothing, so hosts are matched exactly rather than by domain.
 */
export function providerFilingSentCopy(smtpHost: string, authType?: string): string | null {
  const host = smtpHost.trim().toLowerCase();
  if (host === "smtp.gmail.com" || host === "smtp.googlemail.com") return "Gmail";
  // "oauth2" is only offered for Microsoft mailboxes (see types.ts).
  if (authType === "oauth2" || host === "smtp.office365.com" || host === "smtp-mail.outlook.com") {
    return "Microsoft 365";
  }
  return null;
}

/**
 * Folder names that mean "Sent", in the order a tie between two of them is
 * settled. "Sent Items" comes first because Rackspace mailboxes carry both it
 * and a nearly empty "Sent", and Outlook and Rackspace webmail file into
 * "Sent Items". This only decides between folders that hold the same amount of
 * mail (usually none); otherwise the fuller one wins, see pickSentFolder.
 */
const SENT_NAMES = ["sent items", "sent", "sent messages", "sent mail"];

/**
 * Names for a Sent folder in other languages ("Gesendete Elemente",
 * "Envoyés"), from the list imapflow uses for its own guess. That guess labels
 * only one folder per role, alphabetically first, so when an archive's copy
 * sorts ahead of the real folder the real one goes unlabelled; checking every
 * folder against the list directly avoids leaning on which one it picked.
 */
const LOCALIZED_SENT_NAMES = new Set(imapflowSpecialUse.names["\\Sent"] ?? []);

/** Folder names compared the way imapflow compares them. */
function folderNameKey(name: string): string {
  return name.toLowerCase().replace(/‎/g, "").trim();
}

export interface SentFolderCandidate {
  path: string;
  /** The server itself labels this folder \Sent, rather than it being a guess from its name. */
  serverFlagged: boolean;
  /** Position in SENT_NAMES, or SENT_NAMES.length for a name that is not on that list. */
  nameRank: number;
  /**
   * How many messages it holds. Only looked up when there is more than one
   * candidate, and left unset when the server would not say.
   */
  messages?: number;
}

/**
 * The folders a Sent folder sits directly under: the top of the mailbox, the
 * INBOX on servers that keep every folder inside it (Rackspace's "INBOX.Sent
 * Items"), or Gmail's "[Gmail]".
 */
const SENT_PARENTS = /^(inbox|\[gmail\]|\[google mail\])$/i;

function parentsOf(entry: ListResponse): string[] {
  if (Array.isArray(entry.parent)) return entry.parent;
  if (!entry.delimiter) return [];
  return entry.path.split(entry.delimiter).slice(0, -1);
}

/**
 * Every folder that could be the Sent folder.
 *
 * A candidate is a folder the server labels \Sent, wherever it is. Beyond
 * that, a folder qualifies by name (SENT_NAMES, a name in another language
 * from LOCALIZED_SENT_NAMES, or imapflow's own guess), but only near the top of
 * the mailbox: an imported archive often carries a "Sent Items" of its own,
 * deep inside, and can hold more mail than the real one.
 */
export function sentFolderCandidates(entries: ListResponse[]): SentFolderCandidate[] {
  const out: SentFolderCandidate[] = [];
  for (const entry of entries) {
    if (!entry.path) continue;
    if (entry.flags?.has("\\Noselect") || entry.flags?.has("\\NonExistent")) continue;
    // imapflow records where a special-use label came from: "extension" when
    // the server sent it, "name" when imapflow guessed it from the folder name.
    const source = (entry as { specialUseSource?: string }).specialUseSource;
    const labelledSent = entry.specialUse === "\\Sent";
    const serverFlagged = labelledSent && (source === "extension" || source === "user");
    const name = folderNameKey(entry.name || entry.path);
    const nameRank = SENT_NAMES.indexOf(name);
    if (!labelledSent && nameRank < 0 && !LOCALIZED_SENT_NAMES.has(name)) continue;
    const parents = parentsOf(entry);
    const nearTop = parents.length === 0 || (parents.length === 1 && SENT_PARENTS.test(parents[0]));
    if (!serverFlagged && !nearTop) continue;
    out.push({
      path: entry.path,
      serverFlagged,
      nameRank: nameRank < 0 ? SENT_NAMES.length : nameRank,
    });
  }
  return out;
}

export interface PickedSentFolder {
  path: string;
  /** Why this folder, in words the Test connection check can show as they are. */
  reason: string;
}

/**
 * Choose the Sent folder from the candidates.
 *
 * With more than one, the folder holding the most mail wins, because that is
 * where the mailbox's own mail programs have been filing sent mail, and so
 * where the operator will look. It beats the server's own \Sent label: a
 * Rackspace mailbox can carry a "Sent" with four messages from 2024 beside a
 * "Sent Items" with every message since 2022, and a copy filed into the empty
 * one would be as good as lost. The server's label then settles a tie, and the
 * name order after that.
 *
 * Counts only decide when every candidate has one. A folder the server would
 * not count is not the same as an empty folder, and treating it as one would
 * send the copy to whichever folder did answer, which on Rackspace is the
 * near-empty "Sent".
 */
export function pickSentFolder(candidates: SentFolderCandidate[]): PickedSentFolder | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    const only = candidates[0];
    return {
      path: only.path,
      reason: only.serverFlagged
        ? "the mail server marks it as the Sent folder"
        : "the only Sent folder on this mailbox",
    };
  }
  const countsKnown = candidates.every((c) => typeof c.messages === "number");
  const ranked = [...candidates].sort(
    (a, b) =>
      (countsKnown ? (b.messages as number) - (a.messages as number) : 0) ||
      Number(b.serverFlagged) - Number(a.serverFlagged) ||
      a.nameRank - b.nameRank ||
      a.path.localeCompare(b.path),
  );
  const [best, next] = ranked;
  if (countsKnown && (best.messages as number) > (next.messages as number)) {
    return { path: best.path, reason: `it holds the most mail of the ${candidates.length} Sent folders` };
  }
  if (best.serverFlagged && !next.serverFlagged) {
    return { path: best.path, reason: "the mail server marks it as the Sent folder" };
  }
  return {
    path: best.path,
    reason: countsKnown
      ? `the ${candidates.length} Sent folders hold the same amount of mail, and it has the most usual name`
      : `the server would not count every Sent folder, and it has the most usual name of the ${candidates.length}`,
  };
}

/**
 * The folder copies go to: the one named in the mailbox settings, else the
 * best candidate on the server. Null when the mailbox has no Sent folder at
 * all.
 */
export async function resolveSentFolder(
  client: SentFolderClient,
  configured?: string,
): Promise<PickedSentFolder | null> {
  const named = nonBlank(configured);
  if (named) return { path: named, reason: "set in the mailbox settings" };
  const candidates = sentFolderCandidates(await client.list());
  if (candidates.length > 1) {
    for (const candidate of candidates) {
      candidate.messages = await countMessages(client, candidate.path);
    }
  }
  return pickSentFolder(candidates);
}

type SentFolderClient = Pick<SentCopyClient, "list" | "status" | "mailbox">;

/**
 * How many messages a folder holds, or undefined when the server will not
 * say. A folder the connection already has open is read from the open mailbox
 * instead, since IMAP discourages STATUS on the open folder and some servers
 * refuse it.
 */
async function countMessages(client: SentFolderClient, path: string): Promise<number | undefined> {
  const open = client.mailbox;
  if (open && typeof open !== "boolean" && open.path === path && typeof open.exists === "number") {
    return open.exists;
  }
  try {
    // imapflow answers false, rather than throwing, when the server refuses.
    const status = (await client.status(path, { messages: true })) as { messages?: number } | false;
    return status && typeof status.messages === "number" ? status.messages : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The message as the sender's own record of it: what was sent, plus the Bcc
 * line. The transmitted message had to leave Bcc out, since every recipient
 * sees the headers, but the sender is entitled to see who was copied, and
 * Outlook's own Sent copies show it.
 */
export async function buildSentCopy(mail: Mail.Options, messageId: string): Promise<Buffer> {
  const node = new MailComposer({ ...mail, ...(messageId ? { messageId } : {}) }).compile();
  node.keepBcc = true;
  return node.build();
}

export interface SentCopyOutcome {
  /** A copy is in the Sent folder, or the provider files one itself. */
  ok: boolean;
  /** The folder the copy is in. Absent when the provider files its own. */
  folder?: string;
  /** The provider that files the copy itself, so none was uploaded. */
  filedBy?: string;
  /** The copy was already there, so it was not uploaded a second time. */
  alreadyThere?: boolean;
  /**
   * Still being saved when the send had to report back (see awaitFollowUps).
   * `ok` is false only because it is not known yet; the plugin log records how
   * it ended.
   */
  pending?: boolean;
  /** Why no copy was saved. Only set when `ok` is false and not pending. */
  error?: string;
}

export interface SentCopyInput {
  raw: Buffer;
  messageId: string;
  date: Date;
  /** The mailbox's 'Sent folder' setting, when there is one. */
  configuredFolder?: string;
}

function bareMessageId(id: string): string {
  return id.trim().replace(/^<|>$/g, "");
}

/** How many search hits are read back before giving up on an exact match. */
const MAX_MESSAGE_ID_CANDIDATES = 25;

/**
 * UIDs in the open folder whose Message-ID is exactly `messageId`.
 *
 * IMAP's HEADER search matches any header that merely contains the text, so a
 * short or cut-off ID (an agent passing "812" as in_reply_to) would match
 * unrelated messages. Each hit's own Message-ID is read back and compared
 * whole, brackets aside.
 */
async function uidsWithMessageId(
  client: Pick<SentCopyClient, "search" | "fetchOne">,
  messageId: string,
): Promise<number[]> {
  const wanted = bareMessageId(messageId);
  if (!wanted) return [];
  const hits = await client.search({ header: { "message-id": wanted } }, { uid: true });
  if (!Array.isArray(hits) || hits.length === 0) return [];
  const exact: number[] = [];
  for (const uid of hits.slice(0, MAX_MESSAGE_ID_CANDIDATES)) {
    const found = await client.fetchOne(String(uid), { envelope: true }, { uid: true });
    const id = found ? found.envelope?.messageId : undefined;
    if (id && bareMessageId(id) === wanted) exact.push(uid);
  }
  return exact;
}

async function folderHasMessageId(
  client: Pick<SentCopyClient, "getMailboxLock" | "search" | "fetchOne">,
  folder: string,
  messageId: string,
): Promise<boolean> {
  const lock = await client.getMailboxLock(folder);
  try {
    return (await uidsWithMessageId(client, messageId)).length > 0;
  } finally {
    lock.release();
  }
}

export async function uploadSentCopy(
  client: SentCopyClient,
  input: SentCopyInput,
): Promise<SentCopyOutcome> {
  let folder: string | undefined;
  try {
    const picked = await resolveSentFolder(client, input.configuredFolder);
    if (!picked) {
      return {
        ok: false,
        error: "This mailbox has no Sent folder. Name one in the mailbox's 'Sent folder' setting.",
      };
    }
    folder = picked.path;
    // A server that files its own copy, or a retry of a send whose copy was
    // already made, would otherwise end up with two.
    if (input.messageId && (await folderHasMessageId(client, folder, input.messageId))) {
      return { ok: true, folder, alreadyThere: true };
    }
    const appended = await client.append(folder, input.raw, ["\\Seen"], input.date);
    if (!appended) {
      return { ok: false, folder, error: `The mail server refused the copy for "${folder}".` };
    }
    return { ok: true, folder };
  } catch (err) {
    return { ok: false, folder, error: errorText(err) };
  }
}

export interface MarkTarget {
  folder: string;
  /** The original's UID. */
  uid?: number;
  /**
   * The original's Message-ID. With a UID, it is checked against the message
   * at that UID before anything is marked, since a UID only names a message
   * within one folder and one UIDVALIDITY. Without one, it is how the original
   * is found (an agent's email_send with in_reply_to).
   */
  messageId?: string;
  flag: string;
}

export interface MarkOutcome {
  ok: boolean;
  flag: string;
  folder: string;
  uid?: number;
  /** The original could not be found, as opposed to found and not marked. */
  notFound?: boolean;
  /**
   * The server says it can never keep this flag. A fixed property of the
   * server rather than a failure of this send, so it is not worth a warning
   * on every one; Test connection reports it once.
   */
  unsupported?: boolean;
  /** Still being set when the send had to report back (see awaitFollowUps). */
  pending?: boolean;
  error?: string;
}

/**
 * Set the replied or forwarded flag on the original message, then read it
 * back.
 *
 * Two checks keep this honest. A server that says in PERMANENTFLAGS that it
 * cannot keep the flag is not asked: under RFC 3501 it would still accept the
 * flag for this connection only, so no read-back on this connection could
 * tell the difference, and no mail program would ever see it. The read-back
 * then catches a server that ignored the command altogether.
 */
export async function markOriginal(client: SentCopyClient, target: MarkTarget): Promise<MarkOutcome> {
  const base = { flag: target.flag, folder: target.folder };
  let lock: { release(): void } | undefined;
  try {
    lock = await client.getMailboxLock(target.folder);
    let uid = target.uid;
    if (uid !== undefined && target.messageId) {
      const found = await client.fetchOne(String(uid), { envelope: true }, { uid: true });
      const actual = found ? found.envelope?.messageId : undefined;
      if (!actual || bareMessageId(actual) !== bareMessageId(target.messageId)) {
        return {
          ...base,
          uid,
          ok: false,
          notFound: true,
          error: `Message UID ${uid} in "${target.folder}" is not the one that was answered, so nothing was marked.`,
        };
      }
    } else if (uid === undefined && target.messageId) {
      uid = (await uidsWithMessageId(client, target.messageId))[0];
    }
    if (uid === undefined) {
      return { ...base, ok: false, notFound: true, error: `The original message is not in "${target.folder}".` };
    }
    // Absent means the server did not say. An empty list is an answer: nothing
    // can be kept here (a folder opened read-only, say), and imapflow would
    // then quietly drop the flag without asking the server at all.
    const mailbox = client.mailbox;
    const permanent = mailbox && typeof mailbox !== "boolean" ? mailbox.permanentFlags : undefined;
    if (permanent && !permanent.has("\\*") && !hasFlag(permanent, target.flag)) {
      return {
        ...base,
        uid,
        ok: false,
        unsupported: true,
        error: `The mail server does not store the ${target.flag} flag.`,
      };
    }
    await client.messageFlagsAdd([uid], [target.flag], { uid: true });
    const after = await client.fetchOne(String(uid), { flags: true }, { uid: true });
    if (!after) {
      return { ...base, uid, ok: false, notFound: true, error: `Message UID ${uid} is no longer in "${target.folder}".` };
    }
    if (!hasFlag(after.flags, target.flag)) {
      return { ...base, uid, ok: false, error: `The mail server did not keep the ${target.flag} flag.` };
    }
    return { ...base, uid, ok: true };
  } catch (err) {
    return { ...base, ok: false, error: errorText(err) };
  } finally {
    lock?.release();
  }
}

export interface SendRecord {
  sentCopy?: SentCopyOutcome;
  original?: MarkOutcome;
}

/** Runs `fn` on an IMAP connection to the mailbox, however that is provided. */
export type ImapRunner = <T>(fn: (client: SentCopyClient) => Promise<T>) => Promise<T>;

/**
 * Both follow-ups, each on the connection that suits it, side by side. Never
 * rejects: a connection that cannot be opened becomes that step's outcome,
 * and the other step still runs.
 *
 * The copy goes up on a connection of its own (`own`). It moves the whole
 * message again, attachments and all, and on the mailbox's shared connection
 * it would hold up everything queued behind it, including the next reply,
 * which has to fetch its original over that connection before it can send.
 * The mark is quick and uses the shared one (`shared`).
 */
export async function recordSend(
  runners: { own: ImapRunner; shared: ImapRunner },
  plan: { copy?: SentCopyInput; mark?: MarkTarget },
): Promise<SendRecord> {
  const { copy, mark } = plan;
  const cannotOpen = (err: unknown) => `Could not open the mailbox: ${errorText(err)}`;
  const [sentCopy, original] = await Promise.all([
    copy
      ? runners
          .own((client) => uploadSentCopy(client, copy))
          .catch((err): SentCopyOutcome => ({ ok: false, error: cannotOpen(err) }))
      : undefined,
    mark
      ? runners
          .shared((client) => markOriginal(client, mark))
          .catch(
            (err): MarkOutcome => ({ ok: false, flag: mark.flag, folder: mark.folder, uid: mark.uid, error: cannotOpen(err) }),
          )
      : undefined,
  ]);
  const record: SendRecord = {};
  if (sentCopy) record.sentCopy = sentCopy;
  if (original) record.original = original;
  return record;
}

/**
 * Wait for the follow-ups, but never past the time the send has left to
 * answer in.
 *
 * The host gives every plugin call 30 seconds, and after that tells the
 * caller the call failed, even though this one already sent its mail. The
 * Email pages keep a failed send open for another try, and an agent retries,
 * so a follow-up that overran would turn into the same message sent twice. The
 * upload can take a while: it moves the whole message again, attachments and
 * all, and a pooled connection a router silently dropped only fails when its
 * socket times out, minutes later.
 *
 * So after `budgetMs` this stops waiting and answers null, and the work
 * carries on regardless; `onLate` hears how it ended, for the log. A follow-up
 * that fails outright rejects here, and the caller reports it.
 */
export async function awaitFollowUps(
  work: Promise<SendRecord>,
  budgetMs: number,
  onLate: (record: SendRecord | null, err?: unknown) => void,
): Promise<SendRecord | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outOfTime = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(0, budgetMs));
  });
  try {
    const first = await Promise.race([work, outOfTime]);
    if (first === null) {
      work.then(
        (record) => onLate(record),
        (err) => onLate(null, err),
      );
    }
    return first;
  } finally {
    clearTimeout(timer);
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message || String(err) : String(err);
}
