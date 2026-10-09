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
      if (!best || at > best.at) best = { uid: msg.uid, at };
    }
    if (!best) return null;

    const one = await client.fetchOne(String(best.uid), { source: true }, { uid: true });
    if (!one || !one.source) return null;
    const parsed = await simpleParser(one.source);
    const fromAddr = parsed.from?.value?.[0]?.address ?? "";
    if (!senderAllowed(fromAddr, senderDomains)) return null;
    const body = parsed.text || (typeof parsed.html === "string" ? parsed.html.replace(/<[^>]+>/g, " ") : "");
    return extractLoginCode(parsed.subject ?? "", body);
  } finally {
    await client.logout().catch(() => undefined);
  }
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
      if (code) return code;
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
