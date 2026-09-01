import { ImapFlow, type FetchMessageObject, type SearchObject } from "imapflow";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import {
  ATTACHMENT_MAX_BYTES,
  attachmentPartId,
  collectAttachmentMeta,
} from "./attachments.js";
import { htmlToMarkdown } from "./markdown.js";

export interface MailboxRuntime {
  key: string;
  user: string;
  /** App password for basic auth. Empty when using OAuth (accessToken set instead). */
  pass: string;
  /** OAuth2 access token (XOAUTH2). When set, takes precedence over `pass`. */
  accessToken?: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  pollFolder: string;
}

export interface ParsedMessage {
  uid: number;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: string;
  fromAddress: string | null;
  to: string[];
  cc: string[];
  subject: string;
  date: string;
  text: string;
  html: string;
  markdown: string;
  attachments: Array<{ name: string; mime: string; size: number; partId: string; inline: boolean }>;
}

export interface SearchInput {
  folder: string;
  from?: string;
  to?: string;
  subject?: string;
  /**
   * IMAP TEXT: matches headers *and* body. This is what the operator-facing
   * search box sends — one box, matches anywhere. Servers implement it as a
   * substring scan, so it is the slowest criterion here; keep the folder set
   * bounded when using it.
   */
  text?: string;
  /** IMAP BODY: body only, headers excluded. */
  body?: string;
  since?: Date;
  before?: Date;
  unseen?: boolean;
  uidGt?: number;
  header?: { [key: string]: string };
}

export interface SearchResultItem {
  uid: number;
  messageId: string | null;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  unseen: boolean;
}

// ImapFlow reports async socket failures ("Socket timeout", ECONNRESET) as an
// 'error' event on the client — including while a pooled connection sits idle
// between UI actions. With zero listeners Node treats that emission as an
// uncaught exception, which kills the whole worker process and 502s every
// mailbox until the host restarts it. Command promises still reject on their
// own; this listener only absorbs the out-of-band emission. Callers already
// detect a dead client via `usable` and reconnect.
export function attachConnectionErrorListener(client: ImapFlow, mailboxKey: string): void {
  client.on("error", (err: Error) => {
    // Worker stderr is captured by the host and logged as `[plugin stderr]`.
    console.error(
      `email-tools: IMAP connection error (mailbox=${mailboxKey}): ${err?.message ?? String(err)}`,
    );
  });
}

export async function openConnection(
  rt: MailboxRuntime,
  opts: { forIdle?: boolean; maxIdleTimeMs?: number } = {},
): Promise<ImapFlow> {
  const port = rt.imapPort;
  const secure = rt.imapSecure;
  const client = new ImapFlow({
    host: rt.imapHost,
    port,
    secure,
    auth: rt.accessToken
      ? { user: rt.user, accessToken: rt.accessToken }
      : { user: rt.user, pass: rt.pass },
    logger: false,
    disableAutoIdle: !opts.forIdle,
    maxIdleTime: opts.forIdle ? (opts.maxIdleTimeMs ?? 28 * 60 * 1000) : undefined,
  });
  attachConnectionErrorListener(client, rt.key);
  await client.connect();
  return client;
}

export async function getUidValidity(client: ImapFlow, folder: string): Promise<number> {
  const lock = await client.getMailboxLock(folder);
  try {
    const mb = client.mailbox;
    if (!mb || typeof mb === "boolean") throw new Error("mailbox not open");
    return Number(mb.uidValidity);
  } finally {
    lock.release();
  }
}

function buildSearchObject(q: SearchInput): SearchObject {
  const obj: SearchObject = {};
  if (q.from) obj.from = q.from;
  if (q.to) obj.to = q.to;
  if (q.subject) obj.subject = q.subject;
  if (q.text) obj.text = q.text;
  if (q.body) obj.body = q.body;
  if (q.since) obj.since = q.since;
  if (q.before) obj.before = q.before;
  if (q.unseen) obj.seen = false;
  if (q.uidGt !== undefined && q.uidGt > 0) {
    obj.uid = `${q.uidGt + 1}:*`;
  }
  if (q.header) obj.header = q.header;
  if (Object.keys(obj).length === 0) obj.all = true;
  return obj;
}

/**
 * Enforce the strict greater-than contract on a UID list.
 *
 * RFC 3501 interprets a UID range `n:*` as spanning n through the highest
 * UID in the mailbox, and when n exceeds that highest UID the range STILL
 * matches the single newest message. So a search built from `uidGt` returns
 * the newest existing message forever once a mailbox goes quiet: every poll
 * tick counted one phantom "new" message, and once wake-on-mail acted on
 * that count (v0.18.4) it woke the triage agents on every tick all night.
 * The search range narrows the candidates; this filter is the contract.
 */
export function enforceUidGt(uids: number[], uidGt: number | undefined): number[] {
  if (uidGt === undefined || uidGt <= 0) return uids;
  return uids.filter((u) => u > uidGt);
}

export async function searchMessages(client: ImapFlow, q: SearchInput): Promise<number[]> {
  const lock = await client.getMailboxLock(q.folder);
  try {
    const result = await client.search(buildSearchObject(q), { uid: true });
    if (!result) return [];
    return enforceUidGt(result.slice().sort((a, b) => a - b), q.uidGt);
  } finally {
    lock.release();
  }
}

function addrToString(addr: AddressObject | AddressObject[] | undefined): string {
  if (!addr) return "";
  const list = Array.isArray(addr) ? addr : [addr];
  return list.map((a) => a.text ?? "").filter(Boolean).join(", ");
}

function addrFirstAddress(addr: AddressObject | AddressObject[] | undefined): string | null {
  if (!addr) return null;
  const list = Array.isArray(addr) ? addr : [addr];
  for (const a of list) {
    for (const v of a.value ?? []) {
      if (v.address) return v.address;
    }
  }
  return null;
}

function refsArray(parsed: ParsedMail): string[] {
  const refs = parsed.references;
  if (!refs) return [];
  return Array.isArray(refs) ? refs : [refs];
}

function snippetFromText(text: string): string {
  if (!text) return "";
  return text.replace(/\s+/g, " ").trim().slice(0, 280);
}

export async function fetchParsedMessage(
  client: ImapFlow,
  folder: string,
  uid: number,
): Promise<ParsedMessage | null> {
  const lock = await client.getMailboxLock(folder);
  try {
    const msg = (await client.fetchOne(String(uid), { source: true, flags: true }, { uid: true })) as
      | FetchMessageObject
      | false;
    if (!msg || !msg.source) return null;
    const parsed = await simpleParser(msg.source);
    const html = typeof parsed.html === "string" ? parsed.html : "";
    const text = parsed.text ?? "";
    return {
      uid: msg.uid,
      messageId: parsed.messageId ?? null,
      inReplyTo: parsed.inReplyTo ?? null,
      references: refsArray(parsed),
      from: addrToString(parsed.from),
      fromAddress: addrFirstAddress(parsed.from),
      to: parsed.to ? [addrToString(parsed.to)].filter(Boolean) : [],
      cc: parsed.cc ? [addrToString(parsed.cc)].filter(Boolean) : [],
      subject: parsed.subject ?? "",
      date: (parsed.date ?? new Date()).toISOString(),
      text,
      html,
      markdown: html ? htmlToMarkdown(html) : text,
      attachments: collectAttachmentMeta(parsed.attachments ?? []),
    };
  } finally {
    lock.release();
  }
}

export async function fetchHeaders(
  client: ImapFlow,
  folder: string,
  uids: number[],
  options: { withSnippets?: boolean } = {},
): Promise<SearchResultItem[]> {
  if (uids.length === 0) return [];
  const lock = await client.getMailboxLock(folder);
  try {
    const out: SearchResultItem[] = [];
    // Fetching `source` is one IMAP FETCH for the whole batch (not per
    // message), but it does pull full message bytes. Snippet generation is
    // best-effort — we swallow parse errors and fall back to "".
    const fetchSpec = options.withSnippets
      ? { uid: true, envelope: true, flags: true, source: true, internalDate: true }
      : { uid: true, envelope: true, flags: true, bodyStructure: false, internalDate: true };
    for await (const msg of client.fetch(uids, fetchSpec, { uid: true })) {
      const env = msg.envelope;
      const fromList = env?.from ?? [];
      const fromStr = fromList
        .map((a) => (a.name ? `${a.name} <${a.address ?? ""}>` : a.address ?? ""))
        .filter(Boolean)
        .join(", ");
      const date = env?.date ?? msg.internalDate;
      let snippet = "";
      if (options.withSnippets && msg.source) {
        try {
          const parsed = await simpleParser(msg.source);
          snippet = snippetFromText(parsed.text ?? "");
        } catch {
          // Best-effort — leave snippet empty on parse failure.
        }
      }
      out.push({
        uid: msg.uid,
        messageId: env?.messageId ?? null,
        from: fromStr,
        subject: env?.subject ?? "",
        date: date instanceof Date ? date.toISOString() : (date ?? ""),
        snippet,
        unseen: !msg.flags?.has("\\Seen"),
      });
    }
    out.sort((a, b) => (b.date < a.date ? -1 : 1));
    return out;
  } finally {
    lock.release();
  }
}

export async function getAttachment(
  client: ImapFlow,
  folder: string,
  uid: number,
  partId: string,
): Promise<{ filename: string; mime: string; content: Buffer } | null> {
  const lock = await client.getMailboxLock(folder);
  try {
    const msg = (await client.fetchOne(String(uid), { source: true }, { uid: true })) as
      | FetchMessageObject
      | false;
    if (!msg || !msg.source) return null;
    const parsed = await simpleParser(msg.source);
    const attachments = parsed.attachments ?? [];
    // Same index-based derivation as collectAttachmentMeta, so the partId a
    // caller got from a fetch resolves to the same part here.
    const found = attachments.find((_, idx) => attachmentPartId(idx) === partId);
    if (!found) return null;
    const buf = found.content as Buffer;
    if (!buf) return null;
    if (buf.length > ATTACHMENT_MAX_BYTES) {
      throw new Error("attachment exceeds 25 MB cap");
    }
    return {
      filename: found.filename ?? "(unnamed)",
      mime: found.contentType ?? "application/octet-stream",
      content: buf,
    };
  } finally {
    lock.release();
  }
}

export async function setSeenFlag(
  client: ImapFlow,
  folder: string,
  uids: number[],
  on: boolean,
): Promise<void> {
  if (uids.length === 0) return;
  const lock = await client.getMailboxLock(folder);
  try {
    if (on) {
      await client.messageFlagsAdd(uids, ["\\Seen"], { uid: true });
    } else {
      await client.messageFlagsRemove(uids, ["\\Seen"], { uid: true });
    }
  } finally {
    lock.release();
  }
}

export interface MoveMessagesResult {
  movedCount: number;
  uidMap: Map<number, number>;
  destinationCreated: boolean;
}

export async function moveMessages(
  client: ImapFlow,
  folder: string,
  uids: number[],
  targetFolder: string,
): Promise<MoveMessagesResult> {
  if (uids.length === 0) {
    return { movedCount: 0, uidMap: new Map(), destinationCreated: false };
  }

  // Pre-flight: ensure destination exists. mailboxCreate is idempotent on
  // ImapFlow (returns { created: false } when it already exists). On Gmail
  // this auto-creates the label so the move can succeed; on stricter IMAP
  // servers it fails fast with a real error instead of silently no-op'ing.
  let destinationCreated = false;
  try {
    const created = await client.mailboxCreate(targetFolder);
    destinationCreated = created?.created === true;
  } catch (createErr) {
    const msg = (createErr as Error).message ?? "";
    if (!/already exists|ALREADYEXISTS/i.test(msg)) {
      throw new Error(
        `[EFOLDER_CREATE_FAILED] couldn't create target folder "${targetFolder}": ${msg}`,
      );
    }
  }

  const lock = await client.getMailboxLock(folder);
  try {
    const result = await client.messageMove(uids, targetFolder, { uid: true });

    // Post-flight: ImapFlow returns `false` if the server didn't ack the move.
    if (!result) {
      throw new Error(
        `[EMOVE_FAILED] messageMove returned false for target "${targetFolder}" (server did not acknowledge).`,
      );
    }

    // The uidMap maps source UID → destination UID. An empty map means the
    // server processed the request without actually translating any UIDs —
    // typically a silent no-op against a non-existent label or a permissions
    // issue. Treat as a real failure rather than a phantom success.
    const uidMap = result.uidMap ?? new Map<number, number>();
    if (uidMap.size === 0) {
      throw new Error(
        `[EMOVE_FAILED] messageMove acknowledged but uidMap is empty for target "${targetFolder}" — no messages were actually moved.`,
      );
    }

    if (uidMap.size < uids.length) {
      throw new Error(
        `[EMOVE_PARTIAL] messageMove translated ${uidMap.size} of ${uids.length} UIDs for target "${targetFolder}". Aborting before mark-read so caller can retry.`,
      );
    }

    return { movedCount: uidMap.size, uidMap, destinationCreated };
  } finally {
    lock.release();
  }
}

export async function searchHeaderRefs(
  client: ImapFlow,
  folder: string,
  rootMessageId: string,
): Promise<number[]> {
  const lock = await client.getMailboxLock(folder);
  try {
    const refsHits = (await client.search({ header: { references: rootMessageId } }, { uid: true })) || [];
    const inReplyHits =
      (await client.search({ header: { "in-reply-to": rootMessageId } }, { uid: true })) || [];
    const idHits =
      (await client.search({ header: { "message-id": rootMessageId } }, { uid: true })) || [];
    return Array.from(new Set([...refsHits, ...inReplyHits, ...idHits])).sort((a, b) => a - b);
  } finally {
    lock.release();
  }
}

export async function findUidByMessageId(
  client: ImapFlow,
  folder: string,
  messageId: string,
): Promise<number | null> {
  const lock = await client.getMailboxLock(folder);
  try {
    const hits = await client.search({ header: { "message-id": messageId } }, { uid: true });
    if (!hits || hits.length === 0) return null;
    return hits[0];
  } finally {
    lock.release();
  }
}

export async function listFolders(client: ImapFlow): Promise<string[]> {
  const items = await client.list();
  return items
    .map((item) => item.path)
    .filter(Boolean)
    .sort();
}

/**
 * Folders that can actually be opened, with the special-use role attached
 * where the server advertises one.
 *
 * `listFolders` returns every path the server lists, including container-only
 * nodes carrying `\Noselect` (Gmail's bare `[Gmail]` is the common one).
 * Opening one of those throws, which would abort a whole multi-folder search,
 * so anything unselectable is dropped here rather than at the call site.
 */
export async function listSelectableFolders(
  client: ImapFlow,
): Promise<Array<{ path: string; specialUse: string | null }>> {
  const items = await client.list();
  const out: Array<{ path: string; specialUse: string | null }> = [];
  for (const item of items) {
    if (!item.path) continue;
    const flags = (item as { flags?: Set<string> }).flags;
    if (flags?.has("\\Noselect") || flags?.has("\\NonExistent")) continue;
    out.push({
      path: item.path,
      specialUse: (item as { specialUse?: string }).specialUse ?? null,
    });
  }
  return out;
}

// Locates the mailbox's Trash folder. Prefers the IMAP SPECIAL-USE
// `\Trash` attribute (Gmail, Office365, most modern providers expose
// this), and falls back to a path-name heuristic for older servers.
export async function findTrashFolder(client: ImapFlow): Promise<string | null> {
  const items = await client.list();
  for (const item of items) {
    if ((item as { specialUse?: string }).specialUse === "\\Trash") {
      return item.path;
    }
  }
  const HEURISTICS = [
    "Trash",
    "[Gmail]/Trash",
    "Deleted Items",
    "Deleted Messages",
    "INBOX.Trash",
  ];
  for (const candidate of HEURISTICS) {
    const hit = items.find((it) => it.path === candidate);
    if (hit) return hit.path;
  }
  return null;
}

export async function safeLogout(client: ImapFlow): Promise<void> {
  try {
    await client.logout();
  } catch {
    // ignore
  }
}
