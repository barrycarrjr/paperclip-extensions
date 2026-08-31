/**
 * Tests for the wake-on-mail helper.
 *
 * The behaviours worth pinning: only a watch-enabled mailbox with dispatched
 * mail wakes anything, misconfiguration surfaces as a logged skip instead of
 * a silent no-op, the wake carries the ingest company and the documented
 * context source, and a refused wakeup is swallowed so the poll loop for the
 * other mailboxes cannot be broken by one bad issue.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { ConfigMailbox } from "./types.js";
import { WATCH_CONTEXT_SOURCE, decideMailWake, maybeRequestMailWake } from "./watch.js";

const COMPANY = "cccccccc-1111-4222-8333-444444444444";
const ISSUE = "dddddddd-5555-4666-8777-888888888888";

function watchedMailbox(overrides: Partial<ConfigMailbox> = {}): ConfigMailbox {
  return {
    key: "ib-barry",
    ingestCompanyId: COMPANY,
    watchEnabled: true,
    watchIssueId: ISSUE,
    ...overrides,
  } as ConfigMailbox;
}

function mockCtx() {
  const wakeups: Array<{ issueId: string; companyId: string; options: Record<string, unknown> }> = [];
  const warns: Array<Record<string, unknown>> = [];
  const errors: Array<Record<string, unknown>> = [];
  const ctx = {
    issues: {
      requestWakeup: async (issueId: string, companyId: string, options: Record<string, unknown>) => {
        wakeups.push({ issueId, companyId, options });
        return { requested: true };
      },
    },
    logger: {
      info: () => undefined,
      warn: (_m: string, meta?: Record<string, unknown>) => warns.push(meta ?? {}),
      error: (_m: string, meta?: Record<string, unknown>) => errors.push(meta ?? {}),
    },
  } as unknown as PluginContext;
  return { ctx, wakeups, warns, errors };
}

test("decideMailWake stays quiet for unwatched mailboxes and empty batches", () => {
  assert.equal(decideMailWake(watchedMailbox({ watchEnabled: false }), 3).wake, false);
  assert.equal(decideMailWake(watchedMailbox(), 0).wake, false);
  assert.equal(decideMailWake(watchedMailbox(), -1).wake, false);
});

test("decideMailWake reports misconfiguration instead of failing silently", () => {
  const noIssue = decideMailWake(watchedMailbox({ watchIssueId: "  " }), 2);
  assert.equal(noIssue.wake, false);
  assert.match(noIssue.skipReason ?? "", /Issue to wake/);

  const noCompany = decideMailWake(watchedMailbox({ ingestCompanyId: undefined }), 2);
  assert.equal(noCompany.wake, false);
  assert.match(noCompany.skipReason ?? "", /Ingest company/);
});

test("decideMailWake wakes the configured issue in the ingest company", () => {
  const d = decideMailWake(watchedMailbox(), 3);
  assert.equal(d.wake, true);
  assert.equal(d.issueId, ISSUE);
  assert.equal(d.companyId, COMPANY);
  assert.match(d.reason ?? "", /"ib-barry"/);
  assert.match(d.reason ?? "", /3 message\(s\)/);
});

test("maybeRequestMailWake sends exactly one wake with the documented shape", async () => {
  const m = mockCtx();
  const woke = await maybeRequestMailWake(m.ctx, watchedMailbox(), 2);
  assert.equal(woke, true);
  assert.equal(m.wakeups.length, 1);
  assert.equal(m.wakeups[0].issueId, ISSUE);
  assert.equal(m.wakeups[0].companyId, COMPANY);
  assert.equal(m.wakeups[0].options.contextSource, WATCH_CONTEXT_SOURCE);
});

test("maybeRequestMailWake logs a skip for a half-configured watch", async () => {
  const m = mockCtx();
  const woke = await maybeRequestMailWake(m.ctx, watchedMailbox({ watchIssueId: "" }), 2);
  assert.equal(woke, false);
  assert.equal(m.wakeups.length, 0);
  assert.equal(m.warns.length, 1);
  assert.equal(m.warns[0].mailbox, "ib-barry");
});

test("a refused wakeup is logged and swallowed", async () => {
  const m = mockCtx();
  (m.ctx.issues as { requestWakeup: unknown }).requestWakeup = async () => {
    throw new Error("Issue is not wakeable in status: done");
  };
  const woke = await maybeRequestMailWake(m.ctx, watchedMailbox(), 1);
  assert.equal(woke, false);
  assert.equal(m.errors.length, 1);
  assert.match(String(m.errors[0].message), /not wakeable/);
});
