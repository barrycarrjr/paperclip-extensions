/**
 * Where a review's reply came from, as far as the plugin can tell.
 *
 * The reviews table records `reply_source` as 'human' (posted from the
 * Reviews page), 'agent' (posted by the reply tool), or 'google' (a reply the
 * plugin did not post, first seen by the daily sync). The post path writes
 * 'human' or 'agent' itself; this function is what the SYNC uses to decide
 * whether to keep that or overwrite it.
 *
 * The rule is simple on purpose: if the text on Google is the text we stored,
 * whoever we recorded still wrote it. If the text differs, somebody changed
 * it in Google's own console (or posted it there before we ever saw it), so
 * the honest answer is 'google'. No reply on Google means no source.
 */

export type ReplySource = "human" | "agent" | "google";

export interface StoredReply {
  replyText: string | null | undefined;
  replySource: ReplySource | string | null | undefined;
}

export interface IncomingReply {
  replyText: string | null | undefined;
}

function isKnownSource(value: unknown): value is ReplySource {
  return value === "human" || value === "agent" || value === "google";
}

export function nextReplySource(stored: StoredReply, incoming: IncomingReply): ReplySource | null {
  const incomingText = incoming.replyText ?? null;
  if (incomingText === null) return null;
  const storedText = stored.replyText ?? null;
  if (storedText !== null && storedText === incomingText && isKnownSource(stored.replySource)) {
    return stored.replySource;
  }
  return "google";
}
