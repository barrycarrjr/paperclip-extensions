/**
 * Read a carrier's one-time login code from the operator's mailbox.
 *
 * Limits, all enforced here rather than trusted to the mail server:
 *   - The folder is opened with EXAMINE (read-only), so nothing is marked
 *     read, moved or deleted.
 *   - Only envelopes (sender + date) are fetched for the search hits. A body
 *     is downloaded for exactly one message: the newest whose sender domain is
 *     on the carrier's list and that arrived after the code was requested.
 *   - The code is handed back to the sign-in step only. It is never logged or
 *     returned to the agent.
 */
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { sleep } from "./cdp.js";
import { extractLoginCode, senderAllowed } from "./safety.js";

export interface MailboxSettings {
  user: string;
  password: string;
  host: string;
  port: number;
  folder: string;
  /** TLS on connect. Always true in the plugin; tests use a plain local server. */
  secure?: boolean;
}

/** After a code arrives, wait this long for a newer one before using it. */
export let SETTLE_MS = 10_000;
/** Tests shorten the settle wait. */
export function setSettleMs(ms: number): void {
  SETTLE_MS = ms;
}

/** Allow this much clock drift between the mail server and this machine. */
const CLOCK_SKEW_MS = 60_000;

async function newestCode(
  mb: MailboxSettings,
  senderDomains: readonly string[],
  requestedAt: Date,
): Promise<string | null> {
  const client = new ImapFlow({
    host: mb.host,
    port: mb.port,
    secure: mb.secure ?? true,
    auth: { user: mb.user, pass: mb.password },
    logger: false,
  });
  client.on("error", () => undefined);
  try {
    await client.connect();
  } catch (err) {
    client.close();
    throw err;
  }
  try {
    await client.mailboxOpen(mb.folder, { readOnly: true });
    const since = new Date(requestedAt.getTime() - 24 * 3600_000);
    const uids = new Set<number>();
    for (const domain of senderDomains) {
      const found = await client.search({ from: domain, since }, { uid: true });
      for (const uid of found || []) uids.add(uid);
    }
    if (uids.size === 0) return null;

    let best: { uid: number; at: number } | null = null;
    for await (const msg of client.fetch(
      [...uids].join(","),
      { envelope: true, internalDate: true },
      { uid: true },
    )) {
      const from = msg.envelope?.from?.[0]?.address ?? "";
      if (!senderAllowed(from, senderDomains)) continue;
      const at = new Date(msg.internalDate ?? 0).getTime();
      if (at < requestedAt.getTime() - CLOCK_SKEW_MS) continue;
      // Same second: the one the mailbox received later (higher UID) is newer.
      if (!best || at > best.at || (at === best.at && msg.uid > best.uid)) best = { uid: msg.uid, at };
    }
    if (!best) return null;

    const one = await client.fetchOne(String(best.uid), { source: true }, { uid: true });
    if (!one || !one.source) return null;
    const parsed = await simpleParser(one.source);
    const fromAddr = parsed.from?.value?.[0]?.address ?? "";
    if (!senderAllowed(fromAddr, senderDomains)) return null;
    const body = emailBodyText(parsed.text, parsed.html);
    return extractLoginCode(parsed.subject ?? "", body);
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/**
 * The readable text of an email. Some senders (Selective) include an empty
 * plain-text part and put everything in the HTML part, so a blank plain part
 * falls back to the HTML. The HTML is turned into text properly: style and
 * script blocks and comments dropped, each cell or line break on its own
 * line, and character codes such as "&#8201;" (a thin space) decoded, so they
 * cannot be mistaken for the code.
 */
export function emailBodyText(text: string | undefined, html: string | false | undefined): string {
  if (text && text.trim()) return text;
  if (typeof html !== "string") return "";
  const named: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", zwnj: "", zwj: "", thinsp: " ", ensp: " ", emsp: " " };
  return html
    .replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/td|\/tr|\/li|\/h\d)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => named[n.toLowerCase()] ?? m)
    .replace(/[ \t\u00a0\u2000-\u200b]+/g, " ")
    .replace(/\n\s*\n+/g, "\n");
}

/** Poll until a code arrives or `timeoutMs` passes. */
export async function waitForLoginCode(
  mb: MailboxSettings,
  senderDomains: readonly string[],
  requestedAt: Date,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  await sleep(Math.min(5_000, timeoutMs / 4));
  while (Date.now() < deadline) {
    try {
      const code = await newestCode(mb, senderDomains, requestedAt);
      if (code) {
        // Some portals send two codes a moment apart, and only the last one
        // works (Selective). Give a second email a few seconds to land, then
        // take whatever is newest; still only one message body is read each time.
        await sleep(Math.min(SETTLE_MS, Math.max(0, deadline - Date.now())));
        const again = await newestCode(mb, senderDomains, requestedAt).catch(() => null);
        return again ?? code;
      }
    } catch (err) {
      lastError = err;
      const e = err as { message?: string; authenticationFailed?: boolean; responseText?: string };
      if (e?.authenticationFailed || /auth|credentials|login|password/i.test(`${e?.message ?? ""} ${e?.responseText ?? ""}`)) {
        throw new Error(
          "[EMAIL_AUTH_FAILED] Could not sign in to the code mailbox. Check the mailbox address and app password secret in the plugin settings.",
        );
      }
    }
    await sleep(Math.min(6_000, timeoutMs / 4));
  }
  const why = lastError instanceof Error ? ` Last mailbox error: ${lastError.message}` : "";
  throw new Error(
    `[ECODE_TIMEOUT] No login code email from ${senderDomains.join(", ")} arrived within ${Math.round(timeoutMs / 1000)} seconds.${why}`,
  );
}

/** Connect and open the folder read-only; used by the settings "Test" check. */
export async function testMailbox(mb: MailboxSettings): Promise<void> {
  const client = new ImapFlow({
    host: mb.host,
    port: mb.port,
    secure: mb.secure ?? true,
    auth: { user: mb.user, pass: mb.password },
    logger: false,
  });
  client.on("error", () => undefined);
  try {
    await client.connect();
  } catch (err) {
    client.close();
    throw err;
  }
  try {
    await client.mailboxOpen(mb.folder, { readOnly: true });
  } finally {
    await client.logout().catch(() => undefined);
  }
}
