import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  fetchParsedMessage,
  getUidValidity,
  openConnection,
  safeLogout,
  searchMessages,
  setSeenFlag,
  type MailboxRuntime,
} from "./imap.js";
import { dispatchReceived, passesFilter } from "./dispatch.js";
import type { ConfigMailbox, InstanceConfig } from "./types.js";

const STATE_NAMESPACE = "imap";
const LAST_POLL_KEY = "last-poll-at";

interface MailboxCursor {
  uidValidity: number;
  uid: number;
}

const mailboxLocks = new Map<string, Promise<void>>();

export async function withMailboxLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  while (mailboxLocks.has(key)) {
    await mailboxLocks.get(key);
  }
  let release: () => void = () => {};
  const lock = new Promise<void>((resolve) => {
    release = resolve;
  });
  mailboxLocks.set(key, lock);
  try {
    return await fn();
  } finally {
    mailboxLocks.delete(key);
    release();
  }
}

export async function buildMailboxRuntime(
  ctx: PluginContext,
  cfg: ConfigMailbox,
  key: string,
): Promise<MailboxRuntime> {
  if (!cfg.imapHost) throw new Error(`Mailbox "${key}": imapHost is required.`);
  if (!cfg.user) throw new Error(`Mailbox "${key}": user is required.`);
  if (!cfg.pass) throw new Error(`Mailbox "${key}": pass (secret reference) is required.`);
  const pass = await ctx.secrets.resolve(cfg.pass);
  const imapPort = typeof cfg.imapPort === "number" ? cfg.imapPort : 993;
  const imapSecure = typeof cfg.imapSecure === "boolean" ? cfg.imapSecure : imapPort === 993;
  return {
    key,
    user: cfg.user,
    pass,
    imapHost: cfg.imapHost,
    imapPort,
    imapSecure,
    pollFolder: cfg.pollFolder ?? "INBOX",
  };
}

export async function runPoll(ctx: PluginContext, config: InstanceConfig): Promise<void> {
  const intervalMs = clampInterval(config.pollIntervalMinutes ?? 5);
  const lastPollAt = (await ctx.state.get({
    scopeKind: "instance",
    namespace: STATE_NAMESPACE,
    stateKey: LAST_POLL_KEY,
  })) as string | undefined;

  if (lastPollAt) {
    const elapsed = Date.now() - new Date(lastPollAt).getTime();
    if (Number.isFinite(elapsed) && elapsed < intervalMs) {
      return;
    }
  }

  const mailboxes = (config.mailboxes ?? []).filter((m) => m.pollEnabled && m.key);
  if (mailboxes.length === 0) {
    await ctx.state.set(
      { scopeKind: "instance", namespace: STATE_NAMESPACE, stateKey: LAST_POLL_KEY },
      new Date().toISOString(),
    );
    return;
  }

  let totalFetched = 0;
  let totalErrors = 0;
  for (const mailbox of mailboxes) {
    try {
      const fetched = await pollOne(ctx, mailbox);
      totalFetched += fetched;
    } catch (err) {
      totalErrors += 1;
      ctx.logger.error("email-tools poll error", {
        mailbox: mailbox.key,
        message: (err as Error).message,
      });
      await ctx.telemetry.track("poll-error", {
        mailbox: String(mailbox.key),
        message: String((err as Error).message),
      });
    }
  }
  await ctx.state.set(
    { scopeKind: "instance", namespace: STATE_NAMESPACE, stateKey: LAST_POLL_KEY },
    new Date().toISOString(),
  );
  await ctx.telemetry.track("poll-tick", {
    mailboxesChecked: String(mailboxes.length),
    totalFetched: String(totalFetched),
    totalErrors: String(totalErrors),
  });
}

export async function pollOne(ctx: PluginContext, mailbox: ConfigMailbox): Promise<number> {
  const key = mailbox.key as string;
  return withMailboxLock(key, async () => {
    if (!mailbox.ingestCompanyId) {
      ctx.logger.warn("email-tools: skipping poll — ingestCompanyId required when pollEnabled", {
        mailbox: key,
      });
      return 0;
    }
    const rt = await buildMailboxRuntime(ctx, mailbox, key);
    const client = await openConnection(rt);
    let fetched = 0;
    try {
      const folder = mailbox.pollFolder ?? rt.pollFolder;
      const uidValidity = await getUidValidity(client, folder);
      const cursorKey = `${key}:cursor`;
      const cursor = (await ctx.state.get({
        scopeKind: "instance",
        namespace: STATE_NAMESPACE,
        stateKey: cursorKey,
      })) as MailboxCursor | undefined;

      let uidGt = 0;
      let since: Date | undefined;
      if (!cursor || cursor.uidValidity !== uidValidity) {
        if (cursor && cursor.uidValidity !== uidValidity) {
          ctx.logger.warn("email-tools: UIDVALIDITY changed — resetting cursor", {
            mailbox: key,
            oldUidValidity: cursor.uidValidity,
            newUidValidity: uidValidity,
          });
          await ctx.telemetry.track("poll-uidvalidity-reset", {
            mailbox: key,
            oldUidValidity: String(cursor.uidValidity),
            newUidValidity: String(uidValidity),
          });
        }
        const days = mailbox.pollSinceDays ?? 1;
        since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        uidGt = 0;
      } else {
        uidGt = cursor.uid;
      }

      const uids = await searchMessages(client, {
        folder,
        since,
        uidGt,
        from: undefined,
        subject: undefined,
      });

      let maxUid = uidGt;
      const dispatchMode = mailbox.onReceive?.mode ?? "none";
      const markAsRead =
        !!mailbox.onReceive?.markAsRead && (dispatchMode === "event" || dispatchMode === "issue");
      for (const uid of uids) {
        try {
          const parsed = await fetchParsedMessage(client, folder, uid);
          if (parsed && passesFilter(parsed, mailbox)) {
            await dispatchReceived(ctx, mailbox, parsed);
            fetched += 1;
            if (markAsRead) {
              await setSeenFlag(client, folder, [uid], true);
            }
          }
        } catch (perMsg) {
          ctx.logger.error("email-tools poll message error", {
            mailbox: key,
            uid,
            message: (perMsg as Error).message,
          });
          await ctx.telemetry.track("poll-message-error", {
            mailbox: key,
            uid: String(uid),
            message: String((perMsg as Error).message),
          });
        }
        if (uid > maxUid) maxUid = uid;
      }

      await ctx.state.set(
        { scopeKind: "instance", namespace: STATE_NAMESPACE, stateKey: cursorKey },
        { uidValidity, uid: maxUid },
      );
      return fetched;
    } finally {
      await safeLogout(client);
    }
  });
}

function clampInterval(minutes: number): number {
  const m = Math.max(1, Math.min(60, Math.floor(minutes)));
  return m * 60_000;
}
