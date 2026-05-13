import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  fetchHeaders,
  fetchParsedMessage,
  getUidValidity,
  moveMessages,
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
const TRIAGE_FOLDER = "_paperclip/triage";

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
  let totalRulesLearned = 0;
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
    try {
      const learned = await learnFromTriageFolder(ctx, mailbox);
      totalRulesLearned += learned;
    } catch (err) {
      ctx.logger.error("email-tools triage-learn error", {
        mailbox: mailbox.key,
        message: (err as Error).message,
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
    rulesLearned: String(totalRulesLearned),
  });
}

// Scans the per-mailbox triage folder (`_paperclip/triage`) for messages
// that appeared since the last scan, extracts the From address of each,
// and INSERTs an auto-triage rule. This lets the operator train rules
// from any IMAP client (Outlook / Mail.app / mobile) just by dragging
// messages into the triage folder.
function extractEmailFromHeader(from: string): string | null {
  const angled = from.match(/<([^>]+)>/);
  const raw = angled ? angled[1]! : from;
  const trimmed = raw.trim().toLowerCase();
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/i.test(trimmed) ? trimmed : null;
}

export async function learnFromTriageFolder(
  ctx: PluginContext,
  mailbox: ConfigMailbox,
): Promise<number> {
  const key = mailbox.key as string;
  if (!mailbox.ingestCompanyId) return 0; // need a company to scope rules to
  return withMailboxLock(`${key}:triage-learn`, async () => {
    const rt = await buildMailboxRuntime(ctx, mailbox, key);
    const client = await openConnection(rt);
    try {
      // Probe folder existence — Gmail auto-creates labels on first move,
      // but if no one's moved anything yet the folder won't exist. Use
      // mailboxOpen-style search via getUidValidity; catch & return 0.
      let uidValidity: number;
      try {
        uidValidity = await getUidValidity(client, TRIAGE_FOLDER);
      } catch {
        return 0;
      }

      const cursorKey = `${key}:triage-cursor`;
      const cursor = (await ctx.state.get({
        scopeKind: "instance",
        namespace: STATE_NAMESPACE,
        stateKey: cursorKey,
      })) as MailboxCursor | undefined;

      // First run or UIDVALIDITY change → seed cursor at current max UID and
      // skip historical messages (no bulk-rule from years of pre-existing
      // triage history).
      if (!cursor || cursor.uidValidity !== uidValidity) {
        const allUids = await searchMessages(client, { folder: TRIAGE_FOLDER });
        const maxUid = allUids.length > 0 ? Math.max(...allUids) : 0;
        await ctx.state.set(
          { scopeKind: "instance", namespace: STATE_NAMESPACE, stateKey: cursorKey },
          { uidValidity, uid: maxUid },
        );
        return 0;
      }

      const newUids = await searchMessages(client, {
        folder: TRIAGE_FOLDER,
        uidGt: cursor.uid,
      });
      if (newUids.length === 0) return 0;

      const headers = await fetchHeaders(client, TRIAGE_FOLDER, newUids);
      const senders = new Set<string>();
      for (const h of headers) {
        const addr = extractEmailFromHeader(h.from);
        if (addr) senders.add(addr);
      }

      let inserted = 0;
      for (const sender of senders) {
        try {
          const result = await ctx.db.execute(
            `INSERT INTO plugin_email_tools_7cbee3fdf3.email_sender_rules
               (company_id, mailbox_key, sender_pattern, rule_type)
             VALUES ($1, $2, $3, 'auto-triage')
             ON CONFLICT (company_id, mailbox_key, sender_pattern) DO NOTHING`,
            [mailbox.ingestCompanyId, key, sender],
          );
          if (result.rowCount > 0) inserted += 1;
        } catch (err) {
          ctx.logger.warn("email-tools triage-learn rule insert failed", {
            mailbox: key,
            sender,
            error: (err as Error).message,
          });
        }
      }

      const maxNewUid = Math.max(cursor.uid, ...newUids);
      await ctx.state.set(
        { scopeKind: "instance", namespace: STATE_NAMESPACE, stateKey: cursorKey },
        { uidValidity, uid: maxNewUid },
      );

      if (inserted > 0) {
        ctx.logger.info("email-tools learned auto-triage rules from triage folder", {
          mailbox: key,
          newMessages: newUids.length,
          newSenders: senders.size,
          rulesInserted: inserted,
        });
      }
      return inserted;
    } finally {
      await safeLogout(client);
    }
  });
}

// One-shot sweep: when an auto-triage rule is added (via UI or otherwise),
// move any unread INBOX messages whose From matches the pattern. Without
// this, freshly-added rules only apply to new arrivals — existing unread
// mail past the poll cursor stays in INBOX.
export async function applyAutoTriageRuleToInbox(
  ctx: PluginContext,
  mailbox: ConfigMailbox,
  pattern: string,
): Promise<number> {
  const key = mailbox.key as string;
  if (mailbox.disallowMove) return 0;
  if (!key) return 0;

  return withMailboxLock(`${key}:apply-rule`, async () => {
    const rt = await buildMailboxRuntime(ctx, mailbox, key);
    const client = await openConnection(rt);
    try {
      const folder = mailbox.pollFolder ?? "INBOX";
      const unseenUids = await searchMessages(client, { folder, unseen: true });
      if (unseenUids.length === 0) return 0;

      const headers = await fetchHeaders(client, folder, unseenUids);
      const patternLower = pattern.toLowerCase().trim();
      const matchedUids: number[] = [];

      for (const h of headers) {
        const fromAddr = extractEmailFromHeader(h.from);
        if (!fromAddr) continue;
        if (patternLower.startsWith("@")) {
          const at = fromAddr.indexOf("@");
          if (at >= 0 && `@${fromAddr.slice(at + 1)}` === patternLower) {
            matchedUids.push(h.uid);
          }
        } else if (fromAddr === patternLower) {
          matchedUids.push(h.uid);
        }
      }

      if (matchedUids.length === 0) return 0;

      // Mark read first so the email-triage routine's unseen filter skips
      // these on its next run, then move.
      await setSeenFlag(client, folder, matchedUids, true);
      await moveMessages(client, folder, matchedUids, TRIAGE_FOLDER);

      ctx.logger.info("email-tools: applied auto-triage rule to existing INBOX", {
        mailbox: key,
        pattern,
        matched: matchedUids.length,
      });
      return matchedUids.length;
    } finally {
      await safeLogout(client);
    }
  });
}

// One-shot sweep: when a mute rule is added, mark any unread INBOX messages
// whose From matches the pattern as seen. No move — muted senders stay in
// INBOX, just silenced.
export async function applyMuteRuleToInbox(
  ctx: PluginContext,
  mailbox: ConfigMailbox,
  pattern: string,
): Promise<number> {
  const key = mailbox.key as string;
  if (!key) return 0;

  return withMailboxLock(`${key}:apply-rule`, async () => {
    const rt = await buildMailboxRuntime(ctx, mailbox, key);
    const client = await openConnection(rt);
    try {
      const folder = mailbox.pollFolder ?? "INBOX";
      const unseenUids = await searchMessages(client, { folder, unseen: true });
      if (unseenUids.length === 0) return 0;

      const headers = await fetchHeaders(client, folder, unseenUids);
      const patternLower = pattern.toLowerCase().trim();
      const matchedUids: number[] = [];

      for (const h of headers) {
        const fromAddr = extractEmailFromHeader(h.from);
        if (!fromAddr) continue;
        if (patternLower.startsWith("@")) {
          const at = fromAddr.indexOf("@");
          if (at >= 0 && `@${fromAddr.slice(at + 1)}` === patternLower) {
            matchedUids.push(h.uid);
          }
        } else if (fromAddr === patternLower) {
          matchedUids.push(h.uid);
        }
      }

      if (matchedUids.length === 0) return 0;

      await setSeenFlag(client, folder, matchedUids, true);

      ctx.logger.info("email-tools: applied mute rule to existing INBOX", {
        mailbox: key,
        pattern,
        matched: matchedUids.length,
      });
      return matchedUids.length;
    } finally {
      await safeLogout(client);
    }
  });
}

function senderMatchesAutoTriage(fromAddr: string, patterns: Set<string>): boolean {
  if (patterns.size === 0) return false;
  const lower = fromAddr.toLowerCase();
  if (patterns.has(lower)) return true;
  const at = lower.indexOf("@");
  if (at >= 0 && patterns.has(`@${lower.slice(at + 1)}`)) return true;
  return false;
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
    let autoTriaged = 0;
    let muted = 0;

    // Load auto-triage and mute rule sets for this mailbox once per poll
    // tick. Best-effort: if the DB read fails (rare), fall through and skip
    // auto-application — dispatch will run as before.
    let autoTriageSet = new Set<string>();
    let muteSet = new Set<string>();
    try {
      const rules = await ctx.db.query<{ sender_pattern: string; rule_type: string }>(
        `SELECT sender_pattern, rule_type FROM plugin_email_tools_7cbee3fdf3.email_sender_rules
         WHERE company_id = $1 AND mailbox_key = $2 AND rule_type IN ('auto-triage', 'mute')`,
        [mailbox.ingestCompanyId, key],
      );
      autoTriageSet = new Set(
        rules.filter((r) => r.rule_type === "auto-triage").map((r) => r.sender_pattern.toLowerCase()),
      );
      muteSet = new Set(
        rules.filter((r) => r.rule_type === "mute").map((r) => r.sender_pattern.toLowerCase()),
      );
    } catch (err) {
      ctx.logger.warn("email-tools poll: failed to load sender rules; continuing without", {
        mailbox: key,
        message: (err as Error).message,
      });
    }
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
          if (parsed) {
            // Check auto-triage rules first. If the sender is on the list,
            // move the message straight to _paperclip/triage and skip both
            // filter and dispatch — the operator has already classified
            // this sender as auto-triage so it shouldn't bother them again.
            const fromAddr = parsed.fromAddress;
            if (
              fromAddr &&
              !mailbox.disallowMove &&
              senderMatchesAutoTriage(fromAddr, autoTriageSet)
            ) {
              try {
                await setSeenFlag(client, folder, [uid], true);
                await moveMessages(client, folder, [uid], TRIAGE_FOLDER);
                autoTriaged += 1;
                if (uid > maxUid) maxUid = uid;
                continue;
              } catch (moveErr) {
                ctx.logger.warn("email-tools poll: auto-triage move failed", {
                  mailbox: key,
                  uid,
                  sender: fromAddr,
                  message: (moveErr as Error).message,
                });
                // Fall through to normal dispatch on move failure.
              }
            }

            // Check mute rules. If the sender is muted, mark the message as
            // read in-place and skip both filter and dispatch — muted senders
            // stay in INBOX but never bump the unread count or trigger the
            // triage agent.
            if (fromAddr && senderMatchesAutoTriage(fromAddr, muteSet)) {
              try {
                await setSeenFlag(client, folder, [uid], true);
                muted += 1;
                if (uid > maxUid) maxUid = uid;
                continue;
              } catch (muteErr) {
                ctx.logger.warn("email-tools poll: mute mark-seen failed", {
                  mailbox: key,
                  uid,
                  sender: fromAddr,
                  message: (muteErr as Error).message,
                });
                // Fall through to normal dispatch on failure.
              }
            }

            if (passesFilter(parsed, mailbox)) {
              await dispatchReceived(ctx, mailbox, parsed);
              fetched += 1;
              if (markAsRead) {
                await setSeenFlag(client, folder, [uid], true);
              }
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
      if (autoTriaged > 0) {
        ctx.logger.info("email-tools poll: auto-triaged new mail by rule", {
          mailbox: key,
          autoTriaged,
        });
        await ctx.telemetry.track("poll-auto-triaged", {
          mailbox: key,
          count: String(autoTriaged),
        });
      }
      if (muted > 0) {
        ctx.logger.info("email-tools poll: muted new mail by rule", {
          mailbox: key,
          muted,
        });
        await ctx.telemetry.track("poll-muted", {
          mailbox: key,
          count: String(muted),
        });
      }
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
