import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestHarness, type TestHarnessOptions } from "@paperclipai/plugin-sdk/testing";
import type { PluginChatTurnInput, PluginChatTurnResult } from "@paperclipai/plugin-sdk";
import manifest from "./manifest.js";
import type { ResolvedWorkspace } from "./slackClient.js";
import { APPROVE_ACTION_ID } from "./socketMode.js";
import { MAX_DM_IMAGES } from "./dmImages.js";
import {
  InboundDmBridges,
  MAX_SLACK_CHAT_TITLE_CHARS,
  MAX_THREAD_PARENT_CHARS,
  pairingInstructions,
  slackChatTitle,
  slackIdentity,
  withThreadContext,
  type InboundDmOptions,
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
 * `fileInfo`: what files.info says about each file id, or the error it throws.
 */
function fakeSlack(
  options: {
    threadParent?: Record<string, unknown> | Error;
    reactionError?: Error;
    fileInfo?: Record<string, Record<string, unknown> | Error>;
  } = {},
) {
  const posted: Array<{ text: string; blocks?: unknown[]; threadTs?: string }> = [];
  const updated: Array<{ text: string; blocks?: unknown[] }> = [];
  const reactions: string[] = [];
  const fileInfoCalls: string[] = [];
  const client = {
    token: "xoxb-test",
    files: {
      info: async (args: { file: string }) => {
        fileInfoCalls.push(args.file);
        const info = options.fileInfo?.[args.file];
        if (info instanceof Error) throw info;
        if (!info) throw new Error(`no fake file ${args.file}`);
        return { ok: true, file: info };
      },
    },
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
  return { posted, updated, reactions, fileInfoCalls, workspace: { client } as unknown as ResolvedWorkspace };
}

function bridgesWith(
  options: Partial<TestHarnessOptions>,
  slackOptions: Parameters<typeof fakeSlack>[0] = {},
  inboundOptions: InboundDmOptions = {},
) {
  const harness = createTestHarness({ manifest, ...options });
  const slack = fakeSlack(slackOptions);
  const bridges = new InboundDmBridges(harness.ctx, async () => slack.workspace, inboundOptions);
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

  it("starts a new Clippy conversation for each new message, named after it", async () => {
    const turns: Array<{ sessionId: string | null; title?: string }> = [];
    const { harness, handlers } = bridgesWith({
      pairedChannelUsers: [{ workspace: "main", externalUserId: PAT }],
      chatTurn: (input) => {
        turns.push(input as { sessionId: string | null; title?: string });
        return {
          sessionId: `chat-session-${turns.length}`,
          replyText: "Done.",
          stopReason: "end_turn",
          pendingApprovals: [],
          needsConfirmation: [],
          toolCalls: [],
          error: null,
        };
      },
    });
    await handlers.onDm(WS, dmPayload("remind me to send the IRS letter tomorrow", "1760000000.000100"));
    await handlers.onDm(WS, dmPayload("what needs me today?", "1760000500.000200"));

    // Each message is looked up and saved under its own thread, so neither continues the other.
    const lookups = harness.dbQueries.filter((call) => call.sql.includes("inbound_thread_sessions"));
    assert.deepEqual(lookups.map((call) => (call.params as unknown[])[2]), ["1760000000.000100", "1760000500.000200"]);
    assert.deepEqual(turns.map((turn) => turn.sessionId), [null, null]);
    assert.equal(turns[0]?.title, "Slack: remind me to send the IRS letter tomorrow");
    const saves = harness.dbExecutes.filter((call) => call.sql.includes("inbound_thread_sessions"));
    assert.deepEqual(
      saves.map((call) => (call.params as unknown[]).slice(2, 5)),
      [
        ["1760000000.000100", PAT, "chat-session-1"],
        ["1760000500.000200", PAT, "chat-session-2"],
      ],
    );
  });

  it("continues a thread's conversation when the reply is in that thread", async () => {
    const ROOT = "1760000000.000100";
    const sessions: Array<string | null> = [];
    const { harness, handlers } = bridgesWith({
      pairedChannelUsers: [{ workspace: "main", externalUserId: PAT }],
      chatTurn: (input) => {
        sessions.push((input as { sessionId: string | null }).sessionId);
        return {
          sessionId: (input as { sessionId: string | null }).sessionId ?? "chat-session-new",
          replyText: "Done.",
          stopReason: "end_turn",
          pendingApprovals: [],
          needsConfirmation: [],
          toolCalls: [],
          error: null,
        };
      },
    });
    // The thread started at ROOT already has a conversation saved.
    harness.ctx.db.query = (async (sql: string, params?: unknown[]) => {
      harness.dbQueries.push({ sql, params });
      return params?.[2] === ROOT ? [{ chat_session_id: "chat-session-7", last_ts: ROOT }] : [];
    }) as typeof harness.ctx.db.query;

    await handlers.onDm(WS, dmPayload("and copy Calystah", "1760000100.000300", ROOT));
    await handlers.onDm(WS, dmPayload("something else entirely", "1760000200.000400"));

    assert.deepEqual(sessions, ["chat-session-7", null]);
  });

  it("names a Slack conversation after the first line of its first message", () => {
    assert.equal(slackChatTitle("  \nremind me\nsecond line"), "Slack: remind me");
    assert.equal(slackChatTitle(""), "Slack DM");
    const long = slackChatTitle("x".repeat(100));
    assert.equal(long.length, "Slack: ".length + MAX_SLACK_CHAT_TITLE_CHARS);
    assert.ok(long.endsWith("..."));
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

/**
 * Images in a DM. The plugin downloads each with the bot token, within the
 * app composer's limits, and hands them to Clippy with the turn; anything it
 * cannot open stays a note in the message.
 */
describe("images in inbound DMs", () => {
  // The first bytes of each type; what the plugin checks before sending.
  const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const JPEG = Buffer.from("ffd8ffe000104a46494600", "hex");

  const urlOf = (id: string, name: string) => `https://files.slack.com/files-pri/T0TEST-${id}/download/${name}`;

  /** What files.info says about a file. */
  function slackFile(id: string, name: string, size: number, mimetype = "image/png") {
    return { id, name, mimetype, size, url_private_download: urlOf(id, name) };
  }

  /** A DM carrying files, as the message event lists them. */
  function fileDm(files: Array<{ id: string; name: string; mimetype: string }>, text = "", ts = "1760000000.000800") {
    return {
      event_id: `Ev${ts}`,
      event: {
        type: "message",
        subtype: "file_share",
        channel_type: "im",
        channel: "D0TESTDM001",
        user: PAT,
        text,
        ts,
        files,
      },
    };
  }

  /** Answers each download from `responses` by URL, and records who asked for what. */
  function fakeDownloads(responses: Record<string, () => Response>) {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const fetchFile = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      const respond = responses[url];
      return respond ? respond() : new Response("not found", { status: 404 });
    }) as typeof fetch;
    return { fetchFile, requests };
  }

  const imageResponse = (bytes: Buffer, contentType = "image/png") =>
    new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": contentType } });

  /** Records each turn's input; `result` overrides the answer. */
  function recording(turns: PluginChatTurnInput[], result: Partial<PluginChatTurnResult> = {}): Partial<TestHarnessOptions> {
    return {
      pairedChannelUsers: [{ workspace: "main", externalUserId: PAT }],
      chatTurn: (input) => {
        turns.push(input);
        return {
          sessionId: "chat-session-1",
          replyText: "Sent.",
          stopReason: "end_turn",
          pendingApprovals: [],
          needsConfirmation: [],
          toolCalls: [],
          error: null,
          skippedImages: [],
          ...result,
        };
      },
    };
  }

  const missingFilesRead = () =>
    Object.assign(new Error("An API error occurred: missing_scope"), {
      code: "slack_webapi_platform_error",
      data: { ok: false, error: "missing_scope", needed: "files:read", provided: "chat:write,im:history" },
    });

  it("shows Clippy an image sent in a DM, downloaded with the bot token", async () => {
    const turns: PluginChatTurnInput[] = [];
    const downloads = fakeDownloads({ [urlOf("F0IMG1", "screenshot.png")]: () => imageResponse(PNG) });
    const { slack, handlers } = bridgesWith(
      recording(turns),
      { fileInfo: { F0IMG1: slackFile("F0IMG1", "screenshot.png", PNG.length) } },
      { fetchFile: downloads.fetchFile },
    );
    await handlers.onDm(WS, fileDm([{ id: "F0IMG1", name: "screenshot.png", mimetype: "image/png" }], "what is this error?"));

    assert.deepEqual(turns[0]?.images, [{ name: "screenshot.png", mediaType: "image/png", base64: PNG.toString("base64") }]);
    // Named in the text as well, for a Paperclip server too old to take images.
    assert.equal(
      turns[0]?.text,
      "what is this error?\n\n[Slack: the sender also attached an image (screenshot.png), sent with this message. If you cannot see it, say so and ask what it shows.]",
    );
    assert.deepEqual(downloads.requests, [{ url: urlOf("F0IMG1", "screenshot.png"), authorization: "Bearer xoxb-test" }]);
    assert.deepEqual(slack.posted.map((post) => post.text), ["Sent."]);
  });

  it("keeps the plain note for a file Clippy cannot be shown, and downloads nothing", async () => {
    const turns: PluginChatTurnInput[] = [];
    const downloads = fakeDownloads({});
    const { slack, handlers } = bridgesWith(recording(turns), {}, { fetchFile: downloads.fetchFile });
    await handlers.onDm(
      WS,
      fileDm(
        [
          { id: "F0PDF1", name: "invoice.pdf", mimetype: "application/pdf" },
          { id: "F0HEIC1", name: "photo.heic", mimetype: "image/heic" },
        ],
        "file these",
      ),
    );

    assert.equal(turns[0]?.images, undefined);
    assert.equal(
      turns[0]?.text,
      "file these\n\n[Slack: the sender also attached 2 files (invoice.pdf, photo.heic), which cannot be opened from Slack. If it matters, say so and ask what it shows.]",
    );
    assert.deepEqual(slack.fileInfoCalls, []);
    assert.deepEqual(downloads.requests, []);
  });

  it("says an image could not be opened when the Slack app lacks files:read, and logs Slack's reason once", async () => {
    const turns: PluginChatTurnInput[] = [];
    const downloads = fakeDownloads({});
    const { harness, slack, handlers } = bridgesWith(
      recording(turns),
      { fileInfo: { F0IMG1: missingFilesRead(), F0IMG2: missingFilesRead() } },
      { fetchFile: downloads.fetchFile },
    );
    await handlers.onDm(WS, fileDm([{ id: "F0IMG1", name: "screenshot.png", mimetype: "image/png" }], "look", "1760000000.000810"));
    await handlers.onDm(WS, fileDm([{ id: "F0IMG2", name: "photo.jpg", mimetype: "image/jpeg" }], "", "1760000000.000820"));

    assert.equal(turns[0]?.images, undefined);
    assert.equal(
      turns[0]?.text,
      "look\n\n[Slack: the sender also attached an image (screenshot.png), which could not be opened: the Slack app is missing the files:read permission. If it matters, say so and ask what it shows.]",
    );
    assert.match(turns[1]!.text, /^\[Slack: the sender also attached an image \(photo\.jpg\), which could not be opened/);
    // Both messages were still answered, and nothing was downloaded.
    assert.equal(slack.posted.length, 2);
    assert.deepEqual(downloads.requests, []);
    const warnings = harness.logs.filter((entry) => entry.level === "warn" && entry.message.includes("could not open an image"));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!.message, /missing scope \(needed=files:read/);
  });

  it("says an image could not be opened when its download fails, and logs Slack's answer once per cause", async () => {
    const turns: PluginChatTurnInput[] = [];
    const downloads = fakeDownloads({
      [urlOf("F0IMG1", "a.png")]: () => new Response("no", { status: 403 }),
      [urlOf("F0IMG2", "b.png")]: () => imageResponse(Buffer.from("<html>Sign in to Slack</html>"), "text/html; charset=utf-8"),
      [urlOf("F0IMG3", "c.png")]: () => new Response("no", { status: 403 }),
    });
    const { harness, handlers } = bridgesWith(
      recording(turns),
      {
        fileInfo: {
          F0IMG1: slackFile("F0IMG1", "a.png", 16),
          F0IMG2: slackFile("F0IMG2", "b.png", 16),
          F0IMG3: slackFile("F0IMG3", "c.png", 16),
        },
      },
      { fetchFile: downloads.fetchFile },
    );
    await handlers.onDm(WS, fileDm([{ id: "F0IMG1", name: "a.png", mimetype: "image/png" }], "", "1760000000.000810"));
    await handlers.onDm(WS, fileDm([{ id: "F0IMG2", name: "b.png", mimetype: "image/png" }], "", "1760000000.000820"));
    await handlers.onDm(WS, fileDm([{ id: "F0IMG3", name: "c.png", mimetype: "image/png" }], "", "1760000000.000830"));

    assert.deepEqual(turns.map((turn) => turn.images), [undefined, undefined, undefined]);
    for (const turn of turns) assert.match(turn.text, /which could not be opened: the download from Slack failed\./);
    const warnings = harness.logs
      .filter((entry) => entry.level === "warn" && entry.message.includes("could not open an image"))
      .map((entry) => entry.message);
    assert.equal(warnings.length, 2);
    assert.match(warnings[0]!, /HTTP 403/);
    assert.match(warnings[1]!, /web page instead of the file/);
  });

  it("keeps to Paperclip's size caps for each image and for the message's images, before downloading", async () => {
    const turns: PluginChatTurnInput[] = [];
    const downloads = fakeDownloads({
      [urlOf("F0TEXT", "fake.png")]: () => imageResponse(Buffer.from("hello")),
      [urlOf("F0A", "a.png")]: () => imageResponse(PNG),
      [urlOf("F0B", "b.jpg")]: () => imageResponse(JPEG, "image/jpeg"),
      [urlOf("F0C", "c.png")]: () => imageResponse(PNG),
    });
    const { handlers } = bridgesWith(
      recording(turns),
      {
        fileInfo: {
          F0BIG: slackFile("F0BIG", "big.png", 41),
          F0TEXT: slackFile("F0TEXT", "fake.png", 5),
          F0A: slackFile("F0A", "a.png", PNG.length),
          F0B: slackFile("F0B", "b.jpg", JPEG.length, "image/jpeg"),
          F0C: slackFile("F0C", "c.png", PNG.length),
        },
      },
      // As base64 the PNG takes 24 bytes and the JPEG 16. These caps stand in
      // for 10 MB an image and 24 MB a message: a 30 byte file, 36 in all.
      { fetchFile: downloads.fetchFile, imageLimits: { perImageBase64Bytes: 40, totalBase64Bytes: 48 } },
    );
    await handlers.onDm(
      WS,
      fileDm([
        { id: "F0BIG", name: "big.png", mimetype: "image/png" },
        { id: "F0TEXT", name: "fake.png", mimetype: "image/png" },
        { id: "F0A", name: "a.png", mimetype: "image/png" },
        { id: "F0B", name: "b.jpg", mimetype: "image/jpeg" },
        { id: "F0C", name: "c.png", mimetype: "image/png" },
      ]),
    );

    assert.deepEqual(turns[0]?.images, [
      { name: "a.png", mediaType: "image/png", base64: PNG.toString("base64") },
      { name: "b.jpg", mediaType: "image/jpeg", base64: JPEG.toString("base64") },
    ]);
    assert.equal(
      turns[0]?.text,
      [
        "[Slack: the sender also attached an image (big.png), which could not be opened: it is over the 30 B limit for one image. If it matters, say so and ask what it shows.]",
        "[Slack: the sender also attached an image (fake.png), which could not be opened: it is not a PNG, JPEG, GIF or WebP image. If it matters, say so and ask what it shows.]",
        "[Slack: the sender also attached an image (c.png), which could not be opened: with the other images in the message it is over the 36 B limit for all of them. If it matters, say so and ask what it shows.]",
        "[Slack: the sender also attached 2 images (a.png, b.jpg), sent with this message. If you cannot see them, say so and ask what they show.]",
      ].join("\n"),
    );
    // Slack said big.png and c.png were too large, so neither was downloaded.
    assert.deepEqual(
      downloads.requests.map((request) => request.url),
      [urlOf("F0TEXT", "fake.png"), urlOf("F0A", "a.png"), urlOf("F0B", "b.jpg")],
    );
  });

  it("caps an image at 7.5 MB of file, 10 MB as base64, by default, and does not download a larger one", async () => {
    const FULL = 7.5 * 1024 * 1024;
    const turns: PluginChatTurnInput[] = [];
    const downloads = fakeDownloads({
      [urlOf("F0FITS", "fits.png")]: () => imageResponse(Buffer.concat([PNG, Buffer.alloc(FULL - PNG.length)])),
    });
    const { handlers } = bridgesWith(
      recording(turns),
      {
        fileInfo: {
          F0OVER: slackFile("F0OVER", "over.png", FULL + 1),
          F0FITS: slackFile("F0FITS", "fits.png", FULL),
        },
      },
      { fetchFile: downloads.fetchFile },
    );
    await handlers.onDm(
      WS,
      fileDm([
        { id: "F0OVER", name: "over.png", mimetype: "image/png" },
        { id: "F0FITS", name: "fits.png", mimetype: "image/png" },
      ]),
    );

    assert.deepEqual(downloads.requests.map((request) => request.url), [urlOf("F0FITS", "fits.png")]);
    assert.deepEqual(turns[0]?.images?.map((image) => image.name), ["fits.png"]);
    assert.match(turns[0]!.text, /\(over\.png\), which could not be opened: it is over the 7\.5 MB limit for one image\./);
  });

  it("never sends the bot token anywhere but Slack", async () => {
    const turns: PluginChatTurnInput[] = [];
    const downloads = fakeDownloads({});
    const { harness, handlers } = bridgesWith(
      recording(turns),
      {
        fileInfo: {
          // A host that only looks like Slack's, and Slack's own over plain http.
          F0LOOKALIKE: { ...slackFile("F0LOOKALIKE", "a.png", 16), url_private_download: "https://files.slack.com.example.net/a.png" },
          F0PLAIN: { ...slackFile("F0PLAIN", "b.png", 16), url_private_download: "http://files.slack.com/b.png" },
        },
      },
      { fetchFile: downloads.fetchFile },
    );
    await handlers.onDm(
      WS,
      fileDm(
        [
          { id: "F0LOOKALIKE", name: "a.png", mimetype: "image/png" },
          { id: "F0PLAIN", name: "b.png", mimetype: "image/png" },
        ],
        "look",
      ),
    );

    assert.deepEqual(downloads.requests, []);
    assert.equal(turns[0]?.images, undefined);
    assert.match(turns[0]!.text, /2 images \(a\.png, b\.png\), which could not be opened: Slack would not give it to the bot\./);
    const warnings = harness.logs.filter((entry) => entry.level === "warn" && entry.message.includes("could not open an image"));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!.message, /no Slack download address/);
  });

  it(`hands Clippy at most ${MAX_DM_IMAGES} images from one message, as the app's composer does`, async () => {
    const turns: PluginChatTurnInput[] = [];
    const names = Array.from({ length: MAX_DM_IMAGES + 2 }, (_, index) => `shot-${index + 1}.png`);
    const downloads = fakeDownloads(Object.fromEntries(names.map((name) => [urlOf(`F0${name}`, name), () => imageResponse(PNG)])));
    const { handlers } = bridgesWith(
      recording(turns),
      { fileInfo: Object.fromEntries(names.map((name) => [`F0${name}`, slackFile(`F0${name}`, name, PNG.length)])) },
      { fetchFile: downloads.fetchFile },
    );
    await handlers.onDm(WS, fileDm(names.map((name) => ({ id: `F0${name}`, name, mimetype: "image/png" }))));

    assert.deepEqual(
      turns[0]?.images?.map((image) => image.name),
      names.slice(0, MAX_DM_IMAGES),
    );
    assert.equal(downloads.requests.length, MAX_DM_IMAGES);
    assert.match(
      turns[0]!.text,
      /attached 2 images \(shot-9\.png, shot-10\.png\), which could not be opened: only the first 8 images in a message can be shown\./,
    );
  });

  it("still tells Clippy an image came with the message when Paperclip is too old to take images, and logs it once", async () => {
    const turns: PluginChatTurnInput[] = [];
    // An older server's answer has no skippedImages: it dropped the images without a word.
    const olderServer: PluginChatTurnResult = {
      sessionId: "chat-session-1",
      replyText: "I cannot see an image. What does it show?",
      stopReason: "end_turn",
      pendingApprovals: [],
      needsConfirmation: [],
      toolCalls: [],
      error: null,
    };
    const downloads = fakeDownloads({
      [urlOf("F0IMG1", "a.png")]: () => imageResponse(PNG),
      [urlOf("F0IMG2", "b.png")]: () => imageResponse(PNG),
    });
    const { harness, slack, handlers } = bridgesWith(
      {
        pairedChannelUsers: [{ workspace: "main", externalUserId: PAT }],
        chatTurn: (input) => {
          turns.push(input);
          return olderServer;
        },
      },
      { fileInfo: { F0IMG1: slackFile("F0IMG1", "a.png", PNG.length), F0IMG2: slackFile("F0IMG2", "b.png", PNG.length) } },
      { fetchFile: downloads.fetchFile },
    );
    await handlers.onDm(WS, fileDm([{ id: "F0IMG1", name: "a.png", mimetype: "image/png" }], "", "1760000000.000810"));
    await handlers.onDm(WS, fileDm([{ id: "F0IMG2", name: "b.png", mimetype: "image/png" }], "", "1760000000.000820"));

    for (const turn of turns) {
      assert.match(turn.text, /sent with this message\. If you cannot see it, say so and ask what it shows\.\]$/);
    }
    assert.deepEqual(slack.posted.map((post) => post.text), [olderServer.replyText, olderServer.replyText]);
    const warnings = harness.logs.filter((entry) => entry.level === "warn" && entry.message.includes("does not take images"));
    assert.equal(warnings.length, 1);
  });

  it("logs an image Paperclip left out of the turn, with its reason", async () => {
    const turns: PluginChatTurnInput[] = [];
    const downloads = fakeDownloads({ [urlOf("F0IMG1", "a.png")]: () => imageResponse(PNG) });
    const { harness, handlers } = bridgesWith(
      recording(turns, {
        skippedImages: [{ name: "a.png", reason: "Unsupported attachment type: image/png" }],
      }),
      { fileInfo: { F0IMG1: slackFile("F0IMG1", "a.png", PNG.length) } },
      { fetchFile: downloads.fetchFile },
    );
    await handlers.onDm(WS, fileDm([{ id: "F0IMG1", name: "a.png", mimetype: "image/png" }], "see this"));

    const warnings = harness.logs.filter((entry) => entry.level === "warn" && entry.message.includes("left an image"));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!.message, /\(a\.png\): Unsupported attachment type: image\/png$/);
  });
});
