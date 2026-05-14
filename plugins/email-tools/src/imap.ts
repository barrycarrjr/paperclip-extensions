import { ImapFlow, type FetchMessageObject, type SearchObject } from "imapflow";
import { simpleParser, type AddressObject, type Attachment, type ParsedMail } from "mailparser";
import { htmlToMarkdown } from "./markdown.js";

export interface MailboxRuntime {
  key: string;
  user: string;
  pass: string;
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
  attachments: Array<{ name: string; mime: string; size: number; partId: string }>;
}

export interface SearchInput {
  folder: string;
  from?: string;
  to?: string;
  subject?: string;
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

const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

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
    auth: { user: rt.user, pass: rt.pass },
    logger: false,
    disableAutoIdle: !opts.forIdle,
    maxIdleTime: opts.forIdle ? (opts.maxIdleTimeMs ?? 28 * 60 * 1000) : undefined,
  });
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

export async function searchMessages(client: ImapFlow, q: SearchInput): Promise<number[]> {
  const lock = await client.getMailboxLock(q.folder);
  try {
    const result = await client.search(buildSearchObject(q), { uid: true });
    if (!result) return [];
    return result.slice().sort((a, b) => a - b);
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

function collectAttachments(
  attachments: Attachment[],
): Array<{ name: string; mime: string; size: number; partId: string }> {
  return attachments.map((a, idx) => ({
    name: a.filename ?? "(unnamed)",
    mime: a.contentType ?? "application/octet-stream",
    size: a.size ?? 0,
    partId: a.cid ?? `att-${idx}`,
  }));
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
      attachments: collectAttachments(parsed.attachments ?? []),
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
    const found = attachments.find((a, idx) => (a.cid ?? `att-${idx}`) === partId);
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
