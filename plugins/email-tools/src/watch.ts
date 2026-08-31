/**
 * Wake-on-mail: after a poll tick fetches messages that survived the
 * auto-triage and mute rules, request an assignment wakeup on the mailbox's
 * configured triage issue, so the agent runs when there is mail needing
 * attention instead of sweeping on a schedule. Mirrors the help-scout
 * plugin's watch-new-mail feature (its v0.7.4); here it piggybacks on the
 * existing poll loop, so it costs no extra IMAP traffic at all.
 *
 * `fetched` counts only dispatched messages: auto-triaged and muted mail is
 * already handled in code and must never wake the agent. Because the poll
 * cursor advances as messages are fetched, each batch produces exactly one
 * wake; there is no repeat-until-triaged semantic like help-scout's
 * cursor-lag watcher, so the triage issue's hourly fallback wake remains the
 * backstop for a wake that lands while the agent is unavailable.
 *
 * The wake goes to the mailbox's Ingest company: inbound mail already
 * belongs to that company, and it is required whenever polling is on.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { ConfigMailbox } from "./types.js";

/** How the watcher identifies itself in wake payloads and activity logs. */
export const WATCH_CONTEXT_SOURCE = "email-tools.watch-new-mail";

export interface MailWakeDecision {
  wake: boolean;
  issueId?: string;
  companyId?: string;
  reason?: string;
  /** Set when the watch is on but misconfigured, so the poll can log it. */
  skipReason?: string;
}

export function decideMailWake(mailbox: ConfigMailbox, fetched: number): MailWakeDecision {
  if (!mailbox.watchEnabled) return { wake: false };
  if (fetched <= 0) return { wake: false };
  const issueId = (mailbox.watchIssueId ?? "").trim();
  if (!issueId) {
    return { wake: false, skipReason: "watch enabled but 'Issue to wake' is empty" };
  }
  const companyId = (mailbox.ingestCompanyId ?? "").trim();
  if (!companyId) {
    return { wake: false, skipReason: "watch enabled but no 'Ingest company' is set" };
  }
  return {
    wake: true,
    issueId,
    companyId,
    reason:
      `New mail in mailbox "${mailbox.key}": ${fetched} message(s) survived the sender rules ` +
      `and were dispatched. Run the triage cycle now.`,
  };
}

/**
 * Request the wakeup for one polled mailbox. Never throws: a refused wakeup
 * (unassigned, closed, or dependency-blocked issue) is logged and swallowed
 * so it cannot break the poll loop for the other mailboxes.
 */
export async function maybeRequestMailWake(
  ctx: PluginContext,
  mailbox: ConfigMailbox,
  fetched: number,
): Promise<boolean> {
  const decision = decideMailWake(mailbox, fetched);
  if (!decision.wake) {
    if (decision.skipReason) {
      ctx.logger.warn("email-tools watch: skipping wake", {
        mailbox: mailbox.key,
        reason: decision.skipReason,
      });
    }
    return false;
  }
  try {
    await ctx.issues.requestWakeup(decision.issueId!, decision.companyId!, {
      reason: decision.reason,
      contextSource: WATCH_CONTEXT_SOURCE,
    });
    ctx.logger.info("email-tools watch: wake requested", {
      mailbox: mailbox.key,
      issueId: decision.issueId,
      fetched,
    });
    return true;
  } catch (err) {
    ctx.logger.error("email-tools watch: wake request failed", {
      mailbox: mailbox.key,
      issueId: decision.issueId,
      message: (err as Error).message,
    });
    return false;
  }
}
