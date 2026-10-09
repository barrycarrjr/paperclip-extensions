import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestHarness, type TestHarnessOptions } from "@paperclipai/plugin-sdk/testing";
import manifest from "./manifest.js";
import type { ResolvedWorkspace } from "./slackClient.js";
import { APPROVE_ACTION_ID } from "./socketMode.js";
import {
  InboundDmBridges,
  MAX_THREAD_PARENT_CHARS,
  pairingInstructions,
  slackIdentity,
  withThreadContext,
  type InboundWorkspace,
} from "./worker.js";

/**
 * Inbound DMs in Clippy mode. The plugin never names a Paperclip user: it
 * hands Paperclip the Slack identity, an unpaired account is sent a pairing
 * code, and both the turn and the approve button carry that identity.
 */

const PAT = "U0TESTUSR01";
const APPROVAL = "3f1c2b4e-9d8a-4c7b-8e6f-0a1b2c3d4e5f";
const WS: InboundWorkspace = { key: "main", target: "clippy", companyId: "company-hq", agentId: null, fromUserIds: [PAT] };

function dmPayload(text: string, ts = "1760000000.000100", threadTs?: string) {
  return {
    event_id: `Ev${ts}`,
    event: {
      type: "message",
      channel_type: "im",
      channel: "D0TESTDM001",
      user: PAT,
      text,
      ts,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    },
  };
}

/**
 * `threadParent`: the message conversations.replies returns first, or an
 * error it throws. `reactionError`: what every reaction call throws.
 */
function fakeSlack(options: { threadParent?: Record<string, unknown> | Error; reactionError?: Error } = {}) {
  const posted: Array<{ text: string; blocks?: unknown[]; threadTs?: string }> = [];
  const updated: Array<{ text: string; blocks?: unknown[] }> = [];
  const reactions: string[] = [];
  const client = {
    chat: {
      postMessage: async (args: { text: string; blocks?: unknown[]; thread_ts?: string }) => {
        posted.push({ text: args.text, blocks: args.blocks, threadTs: args.thread_ts });
        return { ok: true };
      },
      update: async (args: { text: string; blocks?: unknown[] }) => {
        updated.push({ text: args.text, blocks: args.blocks });
        return { ok: true };
      },
    },
    reactions: {
      add: async (args: { name: string }) => {
        if (options.reactionError) throw options.reactionError;
        reactions.push(`+${args.name}`);
        return { ok: true };
      },
      remove: async (args: { name: string }) => {
        if (options.reactionError) throw options.reactionError;
        reactions.push(`-${args.name}`);
        return { ok: true };
      },
    },
    users: {
      info: async () => ({ ok: true, user: { real_name: "Pat Lee" } }),
    },
    conversations: {
      replies: async () => {
        if (options.threadParent instanceof Error) throw options.threadParent;
        return { ok: true, messages: options.threadParent ? [options.threadParent] : [] };
      },
    },
  };
  return { posted, updated, reactions, workspace: { client } as unknown as ResolvedWorkspace };
}

function bridgesWith(options: Partial<TestHarnessOptions>, slackOptions: Parameters<typeof fakeSlack>[0] = {}) {
  const harness = createTestHarness({ manifest, ...options });
  const slack = fakeSlack(slackOptions);
  const bridges = new InboundDmBridges(harness.ctx, async () => slack.workspace);
  // The handlers are private; tests drive them the way a Socket Mode envelope would.
  const handlers = bridges as unknown as {
    onDm(ws: InboundWorkspace, payload: Record<string, unknown>): Promise<void>;
    onInteractive(ws: InboundWorkspace, payload: Record<string, unknown>): Promise<void>;
  };
  return { harness, slack, handlers };
}

describe("inbound DMs to Clippy", () => {
  it("names the Slack account by workspace key and user id", () => {
    assert.deepEqual(slackIdentity("main", PAT), { workspace: "main", externalUserId: PAT });
  });

  it("tells an unpaired account how to connect, and runs nothing", async () => {
    let turns = 0;
    const { slack, handlers } = bridgesWith({
      pairedChannelUsers: [],
      chatTurn: () => {
        turns += 1;
        throw new Error("should not run");
      },
    });
    await handlers.onDm(WS, dmPayload("what needs me today?"));

    assert.equal(turns, 0);
    assert.equal(slack.posted.length, 1);
    assert.match(slack.posted[0]!.text, /not connected to Paperclip yet/);
    assert.match(slack.posted[0]!.text, /\*TEST-CODE\*/);
    assert.match(slack.posted[0]!.text, /Chat apps/);
  });

  it("runs a paired account's message as a Clippy turn and posts the answer and approval buttons", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { slack, harness, handlers } = bridgesWith({
      pairedChannelUsers: [{ workspace: "main", externalUserId: PAT, userName: "Pat" }],
      chatTurn: (input) => {
        seen.push(input as unknown as Record<string, unknown>);
        return {
          sessionId: "chat-session-1",
          replyText: "Drafted the reply to Jacobs.",
          stopReason: "end_turn",
          pendingApprovals: [{ id: APPROVAL, toolName: "email-tools:email_send", summary: "Reply to Jacobs" }],
          needsConfirmation: ["create_issue"],
          toolCalls: [{ name: "email-tools__email_send", ok: true }],
          error: null,
        };
      },
    });
    await handlers.onDm(WS, dmPayload("reply to Jacobs"));

    assert.deepEqual(seen[0]?.identity, { workspace: "main", externalUserId: PAT });
    assert.equal(seen[0]?.companyId, "company-hq");
    assert.equal(seen[0]?.text, "reply to Jacobs");
    assert.equal(slack.posted[0]?.text, "Drafted the reply to Jacobs.");
    assert.match(slack.posted[1]!.text, /create_issue/);
    assert.equal(slack.posted[2]?.text, "An action is waiting for your approval.");
    assert.ok(Array.isArray(slack.posted[2]?.blocks));
    assert.deepEqual(slack.reactions, ["+eyes", "-eyes", "+white_check_mark"]);
    // The session the host returned is remembered for the next message.
    assert.ok(harness.dbExecutes.some((call) => (call.params as unknown[]).includes("chat-session-1")));
  });

  it("says so when the turn stopped part way", async () => {
    const { slack, handlers } = bridgesWith({
      pairedChannelUsers: [{ workspace: "main", externalUserId: PAT }],
      chatTurn: () => ({
        sessionId: "chat-session-1",
        replyText: "",
        stopReason: "error",
        pendingApprovals: [],
        needsConfirmation: [],
        toolCalls: [],
        error: "provider went away",
      }),
    });
    await handlers.onDm(WS, dmPayload("go"));

    assert.deepEqual(slack.posted.map((post) => post.text), ["Clippy stopped part way: provider went away"]);
    assert.deepEqual(slack.reactions, ["+eyes", "-eyes", "+x"]);
  });

  function answering(seen: string[]): Partial<TestHarnessOptions> {
    return {
      pairedChannelUsers: [{ workspace: "main", externalUserId: PAT }],
      chatTurn: (input) => {
        seen.push((input as { text: string }).text);
        return {
          sessionId: "chat-session-1",
          replyText: "Sent.",
          stopReason: "end_turn",
          pendingApprovals: [],
          needsConfirmation: [],
          toolCalls: [],
          error: null,
        };
      },
    };
  }

  it("gives Clippy the message a thread reply was sent under, as context only", async () => {
    const seen: string[] = [];
    const { handlers } = bridgesWith(answering(seen), {
      threadParent: {
        text: "Needs you (1): Flowroute phone trouble has spread.\nPlease open one ticket with Flowroute.",
        bot_id: "B0PAPERCLIP",
        bot_profile: { name: "Paperclip Bot" },
      },
    });
    await handlers.onDm(WS, dmPayload("please alert Calystah", "1760000000.000200", "1760000000.000100"));

    assert.equal(
      seen[0],
      [
        "[Slack: this is a reply in a thread, under the message below from Paperclip Bot. That message is context only, not part of the request.]",
        "> Needs you (1): Flowroute phone trouble has spread.",
        "> Please open one ticket with Flowroute.",
        "",
        "please alert Calystah",
      ].join("\n"),
    );
  });

  it("answers in a thread: under a new message, or in the thread a reply was written in", async () => {
    const seen: string[] = [];
    const { slack, handlers } = bridgesWith(answering(seen));
    await handlers.onDm(WS, dmPayload("hi", "1760000000.000600"));
    await handlers.onDm(WS, dmPayload("and this", "1760000000.000700", "1760000000.000100"));

    assert.deepEqual(
      slack.posted.map((post) => post.threadTs),
      ["1760000000.000600", "1760000000.000100"],
    );
  });

  it("still answers a thread reply when Slack will not show the thread", async () => {
    const seen: string[] = [];
    const { slack, handlers } = bridgesWith(answering(seen), { threadParent: new Error("missing_scope") });
    await handlers.onDm(WS, dmPayload("please alert Calystah", "1760000000.000200", "1760000000.000100"));

    assert.deepEqual(seen, ["please alert Calystah"]);
    assert.deepEqual(slack.posted.map((post) => post.text), ["Sent."]);
  });

  it("caps a long replied-to message", () => {
    const text = withThreadContext("and this?", { text: "x".repeat(MAX_THREAD_PARENT_CHARS + 50), author: "the sender" });
    assert.ok(text.includes(`> ${"x".repeat(MAX_THREAD_PARENT_CHARS)} [...]`));
    assert.ok(text.endsWith("\n\nand this?"));
    assert.equal(withThreadContext("hello", null), "hello");
  });

  it("decides an approval as the account that pressed the button", async () => {
    const decisions: Array<Record<string, unknown>> = [];
    const { slack, handlers } = bridgesWith({
      pairedChannelUsers: [{ workspace: "main", externalUserId: PAT }],
      approvalsRespond: (input) => {
        decisions.push(input as unknown as Record<string, unknown>);
        return {
          id: APPROVAL,
          companyId: "company-hq",
          type: "outbound_tool_draft",
          status: "approved",
          applied: true,
          executed: { ok: true, reason: null, error: null },
        };
      },
    });
    await handlers.onInteractive(WS, {
      type: "block_actions",
      user: { id: PAT },
      channel: { id: "D0TESTDM001" },
      message: { ts: "1760000000.000200" },
      actions: [{ action_id: APPROVE_ACTION_ID, value: APPROVAL }],
    });

    assert.deepEqual(decisions[0], {
      identity: { workspace: "main", externalUserId: PAT },
      approvalId: APPROVAL,
      decision: "approve",
    });
    // In the reader's own time zone, and the first line says it was sent.
    assert.match(slack.updated[0]!.text, /^Approved and sent at <!date\^\d+\^\{time\}\|\d\d:\d\d UTC>\.$/);
    const blocks = slack.updated[0]!.blocks as Array<{ type: string; text?: { text: string } }>;
    assert.ok(blocks[0]!.text!.text.startsWith("*Sent:*"));
    assert.ok(!blocks.some((block) => block.type === "actions"));
  });

  it("keeps the buttons when a decision does not go through, so it can be pressed again", async () => {
    const { slack, handlers } = bridgesWith({
      pairedChannelUsers: [{ workspace: "main", externalUserId: PAT }],
      approvalsRespond: () => {
        throw new Error("Paperclip is restarting.");
      },
    });
    await handlers.onInteractive(WS, {
      type: "block_actions",
      user: { id: PAT },
      channel: { id: "D0TESTDM001" },
      message: { ts: "1760000000.000200" },
      actions: [{ action_id: APPROVE_ACTION_ID, value: APPROVAL }],
    });

    const blocks = slack.updated[0]!.blocks as Array<{ type: string }>;
    assert.ok(blocks.some((block) => block.type === "actions"));
    assert.match(slack.updated[0]!.text, /^That did not go through: Paperclip is restarting\. Press the button again/);
  });

  it("logs a reaction it could not set, once per cause", async () => {
    // What @slack/web-api throws when the bot token lacks a scope.
    const missingScope = Object.assign(new Error("An API error occurred: missing_scope"), {
      code: "slack_webapi_platform_error",
      data: { ok: false, error: "missing_scope", needed: "reactions:write", provided: "chat:write,im:history" },
    });
    const seen: string[] = [];
    const { harness, slack, handlers } = bridgesWith(answering(seen), { reactionError: missingScope });
    await handlers.onDm(WS, dmPayload("one", "1760000000.000300"));
    await handlers.onDm(WS, dmPayload("two", "1760000000.000400"));

    // Both messages were still answered.
    assert.deepEqual(seen, ["one", "two"]);
    assert.equal(slack.posted.length, 2);
    const warnings = harness.logs.filter((entry) => entry.level === "warn" && entry.message.includes("could not set a reaction"));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!.message, /missing scope \(needed=reactions:write/);
  });

  it("answers a message that is only a file, saying the file cannot be opened", async () => {
    const seen: string[] = [];
    const { handlers } = bridgesWith(answering(seen));
    await handlers.onDm(WS, {
      event_id: "EvFile",
      event: {
        type: "message",
        subtype: "file_share",
        channel_type: "im",
        channel: "D0TESTDM001",
        user: PAT,
        text: "",
        ts: "1760000000.000500",
        files: [{ id: "F01", name: "image.png" }],
      },
    });

    assert.equal(seen.length, 1);
    assert.match(seen[0]!, /^\[Slack: the sender also attached a file \(image\.png\), which cannot be opened from Slack\./);
  });

  it("points at the profile URL when Paperclip knows its address", () => {
    assert.match(
      pairingInstructions({ code: "K7QF-3MZD", profileUrl: "https://pc.example.com/instance/settings/profile" }),
      /<https:\/\/pc\.example\.com\/instance\/settings\/profile\|your Paperclip profile>/,
    );
  });
});
