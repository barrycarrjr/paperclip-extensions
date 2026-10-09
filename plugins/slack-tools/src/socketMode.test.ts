import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  APPROVE_ACTION_ID,
  REJECT_ACTION_ID,
  SocketModeConnection,
  buildApprovalBlocks,
  buildDecidedBlocks,
  buildWakePrompt,
  chunkText,
  extractBlockAction,
  extractOperatorDm,
  openSocketModeUrl,
  slackLocalTime,
  toolLabel,
  withAttachmentNote,
  type SocketLike,
} from "./socketMode.js";

const OPERATOR = "U0TESTUSR01";

function dmEnvelope(overrides: Record<string, unknown> = {}, root: Record<string, unknown> = {}) {
  return {
    event_id: "Ev01",
    type: "event_callback",
    event: {
      type: "message",
      channel_type: "im",
      channel: "D0TESTDM001",
      user: OPERATOR,
      text: "pay the piano tuner",
      ts: "1791506867.255739",
      ...overrides,
    },
    ...root,
  };
}

describe("extractOperatorDm", () => {
  const opts = { workspaceKey: "main", fromUserIds: [OPERATOR] };

  it("accepts a plain direct message from the operator", () => {
    const dm = extractOperatorDm(dmEnvelope(), opts);
    assert.deepEqual(dm, {
      workspaceKey: "main",
      userId: OPERATOR,
      channelId: "D0TESTDM001",
      ts: "1791506867.255739",
      threadTs: null,
      text: "pay the piano tuner",
      files: [],
      eventId: "Ev01",
    });
  });

  it("ignores the bot's own posts, edits, channels, strangers and empty text", () => {
    assert.equal(extractOperatorDm(dmEnvelope({ bot_id: "B01" }), opts), null);
    assert.equal(extractOperatorDm(dmEnvelope({ subtype: "message_changed" }), opts), null);
    assert.equal(extractOperatorDm(dmEnvelope({ subtype: "message_deleted" }), opts), null);
    assert.equal(extractOperatorDm(dmEnvelope({ channel_type: "channel", channel: "C01" }), opts), null);
    assert.equal(extractOperatorDm(dmEnvelope({ user: "U9OTHER" }), opts), null);
    assert.equal(extractOperatorDm(dmEnvelope({ text: "   " }), opts), null);
    assert.equal(extractOperatorDm({ event: { type: "reaction_added" } }, opts), null);
    assert.equal(extractOperatorDm(null, opts), null);
  });

  // A screenshot sent with a question went unanswered when any subtype was dropped.
  it("takes a message with files attached, even one that is only a file", () => {
    const withText = extractOperatorDm(
      dmEnvelope({ subtype: "file_share", text: "the flowroute alert", files: [{ id: "F01", name: "image.png" }] }),
      opts,
    );
    assert.equal(withText?.text, "the flowroute alert");
    assert.deepEqual(withText?.files, [{ name: "image.png" }]);

    const fileOnly = extractOperatorDm(dmEnvelope({ subtype: "file_share", text: "", files: [{ id: "F02" }] }), opts);
    assert.equal(fileOnly?.text, "");
    assert.deepEqual(fileOnly?.files, [{ name: "a file" }]);
  });

  it("takes a thread reply that was also sent to the conversation", () => {
    const dm = extractOperatorDm(dmEnvelope({ subtype: "thread_broadcast", thread_ts: "1791506000.000100" }), opts);
    assert.equal(dm?.text, "pay the piano tuner");
    assert.equal(dm?.threadTs, "1791506000.000100");
  });

  it("keeps the thread when the operator replies inside one", () => {
    const dm = extractOperatorDm(dmEnvelope({ thread_ts: "1791506000.000100" }), opts);
    assert.equal(dm?.threadTs, "1791506000.000100");
  });
});

describe("buildWakePrompt", () => {
  it("names the sender, the time, the message and how to reply", () => {
    const dm = extractOperatorDm(dmEnvelope(), { workspaceKey: "main", fromUserIds: [OPERATOR] })!;
    const prompt = buildWakePrompt(dm);
    assert.ok(prompt.startsWith(`Slack DM from ${OPERATOR} at 2026-10-09T00:47:47.255Z (workspace main, channel D0TESTDM001, ts 1791506867.255739):`));
    assert.ok(prompt.includes("\n\npay the piano tuner\n\n"));
    // Answered in a thread under the message, like Clippy's answers.
    assert.ok(prompt.includes("reply in the same DM with slack_send_dm (workspace main, threadTs 1791506867.255739)"));
    assert.ok(prompt.includes("newer than ts 1791506867.255739"));
  });

  it("carries the thread when the message was inside one", () => {
    const dm = extractOperatorDm(dmEnvelope({ thread_ts: "1791506000.000100" }), { workspaceKey: "main", fromUserIds: [OPERATOR] })!;
    const prompt = buildWakePrompt(dm);
    assert.ok(prompt.includes("in thread 1791506000.000100"));
    assert.ok(prompt.includes("threadTs 1791506000.000100"));
  });

  it("says when files came with the message", () => {
    const dm = extractOperatorDm(
      dmEnvelope({ subtype: "file_share", files: [{ name: "image.png" }] }),
      { workspaceKey: "main", fromUserIds: [OPERATOR] },
    )!;
    assert.ok(buildWakePrompt(dm).includes("attached a file (image.png)"));
  });
});

describe("withAttachmentNote", () => {
  it("adds a note naming the files, and leaves a message without files alone", () => {
    assert.equal(withAttachmentNote("hello", []), "hello");
    assert.equal(
      withAttachmentNote("is this right?", [{ name: "image.png" }]),
      "is this right?\n\n[Slack: the sender also attached a file (image.png), which cannot be opened from Slack. If it matters, say so and ask what it shows.]",
    );
    assert.ok(withAttachmentNote("", [{ name: "a.png" }, { name: "b.pdf" }]).startsWith("[Slack: the sender also attached 2 files (a.png, b.pdf)"));
  });
});

describe("extractBlockAction", () => {
  it("reads the first button press with who pressed it and where", () => {
    const action = extractBlockAction({
      type: "block_actions",
      user: { id: OPERATOR, name: "pat" },
      channel: { id: "D0TESTDM001" },
      message: { ts: "1791507000.000100" },
      actions: [{ type: "button", action_id: REJECT_ACTION_ID, value: "approval-1" }],
    });
    assert.deepEqual(action, {
      actionId: REJECT_ACTION_ID,
      value: "approval-1",
      userId: OPERATOR,
      channelId: "D0TESTDM001",
      messageTs: "1791507000.000100",
    });
  });

  it("ignores payloads that are not button presses", () => {
    assert.equal(extractBlockAction({ type: "shortcut" }), null);
    assert.equal(extractBlockAction({ type: "block_actions", user: { id: OPERATOR }, actions: [] }), null);
    assert.equal(extractBlockAction(null), null);
  });
});

describe("approval blocks", () => {
  const pending = [{ id: "a1", toolName: "email-tools:email_send", summary: "Reply to Jacobs Piano" }];

  it("renders one section and one Approve/Reject row per approval", () => {
    const blocks = buildApprovalBlocks(pending) as Array<Record<string, any>>;
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0]!.text.text, "*Waiting for your approval:* Email send Reply to Jacobs Piano");
    assert.equal(blocks[1]!.block_id, "approval:a1");
    assert.deepEqual(
      blocks[1]!.elements.map((e: Record<string, string>) => [e.action_id, e.value]),
      [[APPROVE_ACTION_ID, "a1"], [REJECT_ACTION_ID, "a1"]],
    );
  });

  it("keeps the buttons with a note under them when a press did not go through", () => {
    const blocks = buildApprovalBlocks(pending, "That did not go through: timeout") as Array<Record<string, any>>;
    assert.equal(blocks.length, 3);
    assert.equal(blocks[1]!.type, "actions");
    assert.equal(blocks[2]!.elements[0].text, "That did not go through: timeout");
  });

  // The struck-through "Waiting for your approval" read as still waiting.
  it("replaces the buttons with what happened, first line first", () => {
    const blocks = buildDecidedBlocks({
      approval: { id: "a2", toolName: "slack-tools:slack_send_dm", summary: 'to Calystah: "Flowroute trouble has spread."' },
      headline: "Sent:",
      outcome: "Approved and sent at 2:14 PM.",
    }) as Array<Record<string, any>>;
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0]!.text.text, '*Sent:* Send Slack DM to Calystah: "Flowroute trouble has spread."');
    assert.ok(!blocks[0]!.text.text.includes("Waiting"));
    assert.equal(blocks[1]!.type, "context");
    assert.equal(blocks[1]!.elements[0].text, "Approved and sent at 2:14 PM.");
  });

  it("names an action in words, not by its internal name", () => {
    assert.equal(toolLabel("slack-tools:slack_send_dm"), "Send Slack DM");
    assert.equal(toolLabel("phone-tools:phone_call_make"), "Phone call make");
  });
});

describe("slackLocalTime", () => {
  it("lets Slack show the time in the reader's own time zone, with UTC as the fallback", () => {
    assert.equal(slackLocalTime(new Date("2026-10-09T18:14:31.821Z")), "<!date^1791569671^{time}|18:14 UTC>");
  });
});

describe("chunkText", () => {
  it("leaves short text alone and splits long text at paragraph breaks", () => {
    assert.deepEqual(chunkText("hello"), ["hello"]);
    const para = "x".repeat(2000);
    const chunks = chunkText(`${para}\n\n${para}\n\n${para}`, 4500);
    assert.deepEqual(chunks.map((c) => c.length), [4002, 2000]);
  });

  it("hard-splits a single paragraph longer than the limit", () => {
    const chunks = chunkText("y".repeat(10_000), 3800);
    assert.deepEqual(chunks.map((c) => c.length), [3800, 3800, 2400]);
  });
});

class FakeSocket implements SocketLike {
  sent: string[] = [];
  closed: Array<{ code?: number; reason?: string }> = [];
  private listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  send(data: string) {
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.closed.push({ code, reason });
  }
  addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  emit(type: string, event: { data?: unknown } = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const quietLogger = { info() {}, warn() {}, error() {} };

function fakeFetch(body: Record<string, unknown>, status = 200): typeof fetch {
  return (async () => ({ status, json: async () => body })) as unknown as typeof fetch;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("openSocketModeUrl", () => {
  it("returns the socket url Slack hands out", async () => {
    assert.equal(await openSocketModeUrl("xapp-1", fakeFetch({ ok: true, url: "wss://x/1" })), "wss://x/1");
  });

  it("fails with Slack's error when the token is refused", async () => {
    await assert.rejects(
      openSocketModeUrl("xapp-bad", fakeFetch({ ok: false, error: "invalid_auth" })),
      /invalid_auth/,
    );
  });
});

describe("SocketModeConnection", () => {
  function connect(onEnvelope: (payload: Record<string, unknown>) => void | Promise<void>) {
    const sockets: FakeSocket[] = [];
    const connection = new SocketModeConnection({
      appToken: "xapp-1",
      logger: quietLogger,
      onEnvelope,
      fetchImpl: fakeFetch({ ok: true, url: "wss://x/1" }),
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 2,
    });
    return { connection, sockets };
  }

  it("acknowledges every envelope first and hands the payload to the handler once", async () => {
    const received: Record<string, unknown>[] = [];
    const { connection, sockets } = connect((payload) => {
      received.push(payload);
    });
    await connection.start();
    const socket = sockets[0]!;
    socket.emit("open");
    socket.emit("message", { data: JSON.stringify({ type: "hello" }) });
    const envelope = { envelope_id: "env-1", type: "events_api", payload: dmEnvelope() };
    socket.emit("message", { data: JSON.stringify(envelope) });
    socket.emit("message", { data: JSON.stringify(envelope) }); // Slack retry of the same envelope
    await sleep(5);
    assert.deepEqual(socket.sent, [JSON.stringify({ envelope_id: "env-1" }), JSON.stringify({ envelope_id: "env-1" })]);
    assert.equal(received.length, 1);
    assert.equal((received[0]!.event as { text: string }).text, "pay the piano tuner");
    connection.stop();
  });

  it("reconnects when Slack asks for it, and stops reconnecting once stopped", async () => {
    const { connection, sockets } = connect(() => {});
    await connection.start();
    sockets[0]!.emit("open");
    sockets[0]!.emit("message", { data: JSON.stringify({ type: "disconnect", reason: "refresh_requested" }) });
    await sleep(20);
    assert.equal(sockets.length, 2, "a second socket is opened after a disconnect request");
    assert.equal(sockets[0]!.closed.length, 1);
    connection.stop();
    sockets[1]!.emit("close");
    await sleep(20);
    assert.equal(sockets.length, 2, "no reconnect after stop()");
    assert.equal(sockets[1]!.closed.length, 1);
  });

  it("routes button presses to the interactive handler and acknowledges them", async () => {
    const presses: Record<string, unknown>[] = [];
    const sockets: FakeSocket[] = [];
    const connection = new SocketModeConnection({
      appToken: "xapp-1",
      logger: quietLogger,
      onEnvelope: () => {},
      onInteractive: (payload) => {
        presses.push(payload);
      },
      fetchImpl: fakeFetch({ ok: true, url: "wss://x/1" }),
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await connection.start();
    const socket = sockets[0]!;
    socket.emit("message", {
      data: JSON.stringify({
        envelope_id: "env-9",
        type: "interactive",
        payload: { type: "block_actions", user: { id: OPERATOR }, actions: [{ action_id: APPROVE_ACTION_ID, value: "a1" }] },
      }),
    });
    await sleep(5);
    assert.deepEqual(socket.sent, [JSON.stringify({ envelope_id: "env-9" })]);
    assert.equal(presses.length, 1);
    connection.stop();
  });

  it("keeps going when the handler throws", async () => {
    let calls = 0;
    const { connection, sockets } = connect(() => {
      calls += 1;
      throw new Error("boom");
    });
    await connection.start();
    const socket = sockets[0]!;
    socket.emit("message", { data: JSON.stringify({ envelope_id: "a", type: "events_api", payload: dmEnvelope() }) });
    socket.emit("message", { data: JSON.stringify({ envelope_id: "b", type: "events_api", payload: dmEnvelope({ ts: "2" }) }) });
    await sleep(5);
    assert.equal(calls, 2);
    connection.stop();
  });
});
