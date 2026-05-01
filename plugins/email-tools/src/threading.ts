import type { ImapFlow } from "imapflow";
import {
  fetchHeaders,
  fetchParsedMessage,
  findUidByMessageId,
  searchHeaderRefs,
  type SearchResultItem,
} from "./imap.js";

export async function buildThread(
  client: ImapFlow,
  folder: string,
  startUid: number | null,
  startMessageId: string | null,
): Promise<SearchResultItem[]> {
  let uid = startUid ?? null;
  if (uid === null && startMessageId) {
    uid = await findUidByMessageId(client, folder, startMessageId);
  }
  if (uid === null) return [];

  const seed = await fetchParsedMessage(client, folder, uid);
  if (!seed) return [];

  const rootId = pickRootMessageId(seed.references, seed.inReplyTo, seed.messageId);
  if (!rootId) {
    const hdr = await fetchHeaders(client, folder, [uid]);
    return hdr;
  }

  const uids = await searchHeaderRefs(client, folder, rootId);
  if (uids.length === 0) {
    const hdr = await fetchHeaders(client, folder, [uid]);
    return hdr;
  }

  const headers = await fetchHeaders(client, folder, uids);
  headers.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.uid - b.uid));
  return headers;
}

function pickRootMessageId(
  references: string[],
  inReplyTo: string | null,
  messageId: string | null,
): string | null {
  if (references.length > 0) return references[0];
  if (inReplyTo) return inReplyTo;
  return messageId;
}
