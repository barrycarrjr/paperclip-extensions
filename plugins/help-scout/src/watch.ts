/**
 * Wake-on-mail watcher.
 *
 * A scheduled job ("watch-new-mail", cron every minute, gated by
 * watchPollIntervalMinutes) checks each watch-enabled account for active
 * conversations modified since the triage cursor. When any exist it requests
 * an assignment wakeup on the configured issue, so the assigned agent runs
 * exactly when there is mail to triage. When there is nothing, no agent run
 * happens at all: the check is one Help Scout API call, no tokens spent.
 * (The motivating incident: a triage heartbeat on a self-scheduled loop woke
 * ~1,400 times over three days of a quiet mailbox and found zero mail.)
 *
 * Read-only over the cursor by design. Advancing the cursor stays the
 * triaging agent's move at the end of a successful run
 * (helpscout_set_triage_cursor); if the watcher advanced it, a wake the agent
 * never acted on would skip that mail forever. Because the cursor sits still
 * until the agent runs, the idempotency key carries the newest modifiedAt
 * seen, letting the host collapse repeat wake requests for the same unread
 * state instead of stacking one per poll tick.
 *
 * Same testability rule as triage-cursor.ts: every decision is a pure
 * function, and runWatch takes its I/O (account resolution, HTTP) as
 * injectable deps so tests never touch the network.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  type ConfigAccount,
  type InstanceConfig,
  getHelpScoutAccount,
  helpScoutRequest,
} from "./helpScoutClient.js";
import { parseStoredCursor, resolveSince, triageCursorScope } from "./triage-cursor.js";

/** Instance-scoped state, so one due-gate covers every watched account. */
export const WATCH_STATE_NAMESPACE = "watch";
export const WATCH_LAST_POLL_KEY = "last-poll-at";

export const DEFAULT_WATCH_INTERVAL_MINUTES = 2;
const MIN_WATCH_INTERVAL_MINUTES = 1;
const MAX_WATCH_INTERVAL_MINUTES = 60;
const MS_PER_MINUTE = 60_000;

/** How the watcher identifies itself in wake payloads and activity logs. */
export const WATCH_CONTEXT_SOURCE = "help-scout.watch-new-mail";

const watchLastPollScope = {
  scopeKind: "instance",
  namespace: WATCH_STATE_NAMESPACE,
  stateKey: WATCH_LAST_POLL_KEY,
} as const;

export function clampWatchIntervalMs(minutes: unknown): number {
  const n =
    typeof minutes === "number" && Number.isFinite(minutes)
      ? minutes
      : DEFAULT_WATCH_INTERVAL_MINUTES;
  const clamped = Math.min(Math.max(n, MIN_WATCH_INTERVAL_MINUTES), MAX_WATCH_INTERVAL_MINUTES);
  return clamped * MS_PER_MINUTE;
}

/** A missing or garbage last-poll value must mean "due now", never "wait". */
export function isWatchDue(lastPollAtIso: unknown, now: Date, intervalMs: number): boolean {
  if (typeof lastPollAtIso !== "string" || !lastPollAtIso.trim()) return true;
  const t = Date.parse(lastPollAtIso);
  if (Number.isNaN(t)) return true;
  return now.getTime() - t >= intervalMs;
}

export interface WatchTarget {
  accountKey: string;
  companyId: string;
  issueId: string;
  mailboxId: string | null;
}

export interface SkippedWatch {
  accountKey: string;
  reason: string;
}

/**
 * Turn the account config into concrete watch targets.
 *
 * Accounts with the watch switched off are silently ignored; accounts with it
 * on but misconfigured come back as skips with a reason, so the job can log
 * them instead of a half-configured watch failing silently forever.
 */
export function collectWatchTargets(config: InstanceConfig): {
  targets: WatchTarget[];
  skipped: SkippedWatch[];
} {
  const targets: WatchTarget[] = [];
  const skipped: SkippedWatch[] = [];
  for (const account of config.accounts ?? []) {
    if (!account.watchEnabled) continue;
    const key = (account.key ?? "").trim();
    if (!key) {
      skipped.push({ accountKey: "(no-key)", reason: "watch enabled but the account has no key" });
      continue;
    }
    const issueId = (account.watchIssueId ?? "").trim();
    if (!issueId) {
      skipped.push({ accountKey: key, reason: "watch enabled but 'Issue to wake' is empty" });
      continue;
    }
    const company = resolveWatchCompanyId(account);
    if (!company.ok) {
      skipped.push({ accountKey: key, reason: company.reason });
      continue;
    }
    targets.push({
      accountKey: key,
      companyId: company.companyId,
      issueId,
      mailboxId: (account.watchMailboxId ?? "").trim() || null,
    });
  }
  return { targets, skipped };
}

/**
 * The wake needs a company (requestWakeup and the account gate both take
 * one). An explicit watchCompanyId wins; otherwise derive it only when
 * allowedCompanies names exactly one concrete company, so a portfolio-wide or
 * multi-company account can never wake an issue in a company nobody chose.
 */
function resolveWatchCompanyId(
  account: ConfigAccount,
): { ok: true; companyId: string } | { ok: false; reason: string } {
  const explicit = (account.watchCompanyId ?? "").trim();
  if (explicit) return { ok: true, companyId: explicit };
  const allowed = account.allowedCompanies ?? [];
  if (allowed.includes("*")) {
    return {
      ok: false,
      reason: "'Watch company' is required when 'Allowed companies' is portfolio-wide (*)",
    };
  }
  const concrete = allowed.filter((c) => typeof c === "string" && c.trim());
  if (concrete.length === 1) return { ok: true, companyId: concrete[0] };
  return {
    ok: false,
    reason:
      concrete.length === 0
        ? "'Watch company' is required (no 'Allowed companies' to derive it from)"
        : "'Watch company' is required ('Allowed companies' lists several, cannot pick one)",
  };
}

/**
 * Newest modification stamp on the returned page, for the idempotency key.
 * Help Scout puts the customer-visible stamp in userUpdatedAt; slimConversation
 * reads the same pair in the same order.
 */
export function newestModifiedAt(
  conversations: Array<Record<string, unknown>>,
  fallbackIso: string,
): string {
  let newest = Number.NaN;
  for (const c of conversations) {
    const raw = (c.userUpdatedAt as string) ?? (c.modifiedAt as string) ?? null;
    if (typeof raw !== "string") continue;
    const t = Date.parse(raw);
    if (Number.isNaN(t)) continue;
    if (Number.isNaN(newest) || t > newest) newest = t;
  }
  return Number.isNaN(newest) ? fallbackIso : new Date(newest).toISOString();
}

/**
 * Help Scout's Mailbox API rejects timestamps carrying milliseconds (it wants
 * yyyy-MM-dd'T'HH:mm:ss'Z' exactly), so strip them off the ISO string before
 * putting it in a query. The triage skill does the same by hand ("strip ms")
 * before its find calls; sending the raw toISOString() form comes back as
 * [EHELP_SCOUT_400] Bad request.
 */
export function toHelpScoutTimestamp(iso: string): string {
  return iso.replace(/\.\d{1,3}(?=Z$)/, "");
}

export function wakeIdempotencyKey(
  accountKey: string,
  mailboxId: string | null,
  newestIso: string,
): string {
  return `helpscout-watch:${accountKey}:${mailboxId ?? "default"}:${newestIso}`;
}

export function buildWakeReason(count: number, accountKey: string, newestIso: string): string {
  return (
    `New Help Scout mail on account "${accountKey}": ${count} active conversation(s) ` +
    `modified since the triage cursor (newest ${newestIso}). Run the triage cycle now.`
  );
}

/** I/O the watch performs, injectable so tests never touch the network. */
export interface WatchDeps {
  getAccount: typeof getHelpScoutAccount;
  request: typeof helpScoutRequest;
  now: () => Date;
}

export interface WatchRunSummary {
  /** false when the due-gate decided this tick was not due yet. */
  ran: boolean;
  targetsChecked: number;
  wakesRequested: number;
  skipped: SkippedWatch[];
  errors: number;
}

export async function runWatch(
  ctx: PluginContext,
  config: InstanceConfig,
  opts: { bypassDueGate?: boolean } = {},
  depsOverride: Partial<WatchDeps> = {},
): Promise<WatchRunSummary> {
  const deps: WatchDeps = {
    getAccount: getHelpScoutAccount,
    request: helpScoutRequest,
    now: () => new Date(),
    ...depsOverride,
  };
  const now = deps.now();

  if (!opts.bypassDueGate) {
    const intervalMs = clampWatchIntervalMs(config.watchPollIntervalMinutes);
    const lastPollAt = await ctx.state.get(watchLastPollScope);
    if (!isWatchDue(lastPollAt, now, intervalMs)) {
      return { ran: false, targetsChecked: 0, wakesRequested: 0, skipped: [], errors: 0 };
    }
  }

  const { targets, skipped } = collectWatchTargets(config);
  for (const skip of skipped) {
    ctx.logger.warn("help-scout watch: skipping account", { ...skip });
  }

  let wakesRequested = 0;
  let errors = 0;
  for (const target of targets) {
    try {
      const resolved = await deps.getAccount(ctx, target.companyId, "watch-new-mail", target.accountKey);
      const stored = parseStoredCursor(
        await ctx.state.get(triageCursorScope(target.companyId, target.accountKey, target.mailboxId)),
      );
      const { since, source } = resolveSince(stored, deps.now());

      const query: Record<string, string | number | undefined> = {
        size: 25,
        status: "active",
        modifiedSince: toHelpScoutTimestamp(since),
      };
      if (target.mailboxId) query.mailbox = target.mailboxId;
      const resp = await deps.request<{
        _embedded?: { conversations?: unknown[] };
        page?: { totalElements?: number };
      }>(resolved, "/conversations", { query });

      const conversations = (resp.body?._embedded?.conversations ?? []) as Array<
        Record<string, unknown>
      >;
      const count = resp.body?.page?.totalElements ?? conversations.length;
      if (count === 0) continue;

      const newest = newestModifiedAt(conversations, since);
      await ctx.issues.requestWakeup(target.issueId, target.companyId, {
        reason: buildWakeReason(count, target.accountKey, newest),
        contextSource: WATCH_CONTEXT_SOURCE,
        idempotencyKey: wakeIdempotencyKey(target.accountKey, target.mailboxId, newest),
      });
      wakesRequested += 1;
      ctx.logger.info("help-scout watch: wake requested", {
        account: target.accountKey,
        issueId: target.issueId,
        count,
        newest,
        cursorSource: source,
      });
    } catch (err) {
      errors += 1;
      ctx.logger.error("help-scout watch error", {
        account: target.accountKey,
        message: (err as Error).message,
      });
    }
  }

  await ctx.state.set(watchLastPollScope, now.toISOString());
  try {
    await ctx.telemetry.track("help-scout.watch-tick", {
      targets: String(targets.length),
      wakes: String(wakesRequested),
      errors: String(errors),
    });
  } catch {
    // never break the job on telemetry failure
  }
  return { ran: true, targetsChecked: targets.length, wakesRequested, skipped, errors };
}
