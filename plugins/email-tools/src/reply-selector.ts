import type { ImapFlow } from "imapflow";
import { fetchParsedMessage } from "./imap.js";
import { validMessageId, validUid } from "./routing-config.js";

export type ReplySelector = { uid: number; messageId?: never } | { messageId: string; uid?: never };
export function parseReplySelector(p: { uid?: unknown; messageId?: unknown }): ReplySelector {
  if ((p.uid !== undefined) === (p.messageId !== undefined)) throw new Error("[EREPLY_SELECTOR] Supply exactly one of uid or messageId.");
  if (p.uid !== undefined) {
    if (!validUid(p.uid)) throw new Error("[EREPLY_SELECTOR] uid must be a positive 32-bit integer.");
    return { uid: p.uid };
  }
  if (!validMessageId(p.messageId)) throw new Error("[EREPLY_SELECTOR] messageId must be a valid bracketed Message-ID.");
  return { messageId: p.messageId };
}

export async function resolveReplySelector(client: ImapFlow, folder: string, selector: ReplySelector) {
  if (selector.uid !== undefined) return fetchParsedMessage(client, folder, selector.uid);
  // Keep the selection locked until the exact UID is verified and fetched. A reset cannot substitute a cached UID.
  const lock = await client.getMailboxLock(folder, { readOnly: true });
  let uid: number;
  let validity: string;
  try {
    if (!client.mailbox) throw new Error("[EREPLY_SELECTOR] Folder is unavailable.");
    validity = String(client.mailbox.uidValidity);
    const matches = await client.search({ header: { "message-id": selector.messageId } }, { uid: true });
    // IMAP HEADER search is a substring match. Refuse multiple candidates rather than picking one.
    if (!matches || matches.length !== 1) throw new Error("[EREPLY_SELECTOR] Message-ID is missing or ambiguous in this folder. Locate the original email and select its folder before replying.");
    uid = matches[0];
    const header = await client.fetchOne(String(uid), { envelope: true }, { uid: true });
    if (!header || header.uid !== uid || header.envelope?.messageId !== selector.messageId) throw new Error("[EREPLY_SELECTOR] Lookup did not match the exact Message-ID. No reply was sent.");
  } finally { lock.release(); }
  // The existing parser takes its own lock. Check validity both sides and Message-ID again after the fetch.
  const original = await fetchParsedMessage(client, folder, uid!);
  const check = await client.getMailboxLock(folder, { readOnly: true });
  try {
    if (!client.mailbox || String(client.mailbox.uidValidity) !== validity! || !original || original.uid !== uid! || original.messageId !== selector.messageId) throw new Error("[EREPLY_SELECTOR] Original changed or disappeared during lookup. No reply was sent.");
    return original;
  } finally { check.release(); }
}
