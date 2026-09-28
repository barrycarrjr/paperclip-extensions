import assert from "node:assert/strict";
import test from "node:test";
import { pollSlackWorkflows, syncSlackThread, type SlackPollDeps } from "./slack-poller.js";
import type { Connection, IncomingMessage } from "./routing.js";

const companyA = "11111111-1111-4111-8111-111111111111";
const connection: Connection = {
  id: "example-workspace", source: "slack", externalAccountId: "TEXAMPLE01", ingestAgentId: "agent-1",
  allowedCompanies: [companyA], routes: [{ externalRouteId: "CEXAMPLE01:companyalpha", companyId: companyA }],
};

function reply(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

test("first poll baselines; next poll ingests new workflow post and advances cursor", async () => {
  const cursors = new Map<string, string>();
  const received: IncomingMessage[] = [];
  const calls: string[] = [];
  const deps: SlackPollDeps = {
    token: "test-token",
    fetch: async (url) => {
      calls.push(url);
      if (url.endsWith("auth.test")) return reply({ ok: true, team_id: "TEXAMPLE01" });
      const oldest = new URL(url).searchParams.get("oldest");
      if (oldest === "0") return reply({ ok: true, messages: [{ ts: "1700000000.000100", text: "old" }], has_more: false });
      return reply({ ok: true, messages: [{
        ts: "1700000100.000200", username: "Help Desk Request Manager",
        text: "Company: Company Alpha\nRequest: Checkout error\nDetails: Checkout failed",
      }], has_more: false });
    },
    getCursor: async (channelId) => cursors.get(channelId) ?? null,
    setCursor: async (channelId, ts) => { cursors.set(channelId, ts); },
    ingest: async (message) => { received.push(message); },
  };
  assert.equal(await pollSlackWorkflows(connection, deps), 0);
  assert.equal(cursors.get("CEXAMPLE01"), "1700000000.000100");
  assert.equal(await pollSlackWorkflows(connection, deps), 1);
  assert.equal(received[0]?.companyId, companyA);
  assert.equal(received[0]?.externalRouteId, "CEXAMPLE01:companyalpha");
  assert.equal(received[0]?.externalUrl, "https://app.slack.com/archives/CEXAMPLE01/p1700000100000200");
  assert.equal(cursors.get("CEXAMPLE01"), "1700000100.000200");
  assert.ok(calls.some((url) => new URL(url).searchParams.get("oldest") === "1700000000.000100"));
});

test("missing Company on a workflow post leaves cursor for retry", async () => {
  let cursor = "1700000000.000100";
  const deps: SlackPollDeps = {
    token: "test-token",
    fetch: async (url) => url.endsWith("auth.test")
      ? reply({ ok: true, team_id: "TEXAMPLE01" })
      : reply({ ok: true, messages: [{ ts: "1700000100.000200", username: "Help Desk Request Manager", text: "Request: Checkout error" }] }),
    getCursor: async () => cursor,
    setCursor: async (_channel, ts) => { cursor = ts; },
    ingest: async () => { throw new Error("must not ingest"); },
  };
  await assert.rejects(() => pollSlackWorkflows(connection, deps), /Company answer/);
  assert.equal(cursor, "1700000000.000100");
});

test("token from another workspace is refused before reading channels", async () => {
  const deps: SlackPollDeps = {
    token: "test-token", fetch: async () => reply({ ok: true, team_id: "DIFFERENT" }),
    getCursor: async () => null, setCursor: async () => {}, ingest: async () => {},
  };
  await assert.rejects(() => pollSlackWorkflows(connection, deps), /different workspace/);
});

test("thread sync captures replies and attachment references with a stable cursor", async () => {
  const received: IncomingMessage[] = [];
  const calls: string[] = [];
  const thread = {
    companyId: companyA, externalRouteId: "CEXAMPLE01:companyalpha", parentTs: "1700000100.000200",
    title: "Prepress computer", cursorTs: null as string | null,
  };
  const deps = {
    token: "test-token",
    fetch: async (url: string) => {
      calls.push(url);
      const oldest = new URL(url).searchParams.get("oldest");
      return reply({ ok: true, has_more: false, messages: oldest
        ? [{ ts: "1700000300.000400", thread_ts: thread.parentTs, user: "U-STAFF", text: "Resolved after checking display" }]
        : [
          { ts: thread.parentTs, bot_id: "B-WORKFLOW", text: "Company: Company Alpha\nRequest: Prepress computer" },
          { ts: "1700000200.000300", thread_ts: thread.parentTs, user: "U-STAFF", text: "",
            files: [{ id: "F-IMAGE", name: "screen.png", mimetype: "image/png", permalink: "https://slack.com/files/example" }] },
        ] });
    },
    ingest: async (message: IncomingMessage) => { received.push(message); },
  };
  const first = await syncSlackThread(connection, thread, deps);
  assert.deepEqual(first, { ingested: 2, cursorTs: "1700000200.000300" });
  assert.equal(received[0]?.authorKind, "bot");
  assert.equal(received[1]?.body, "[Attachment shared]");
  assert.deepEqual(received[1]?.attachments, [{ id: "F-IMAGE", name: "screen.png", mimeType: "image/png", permalink: "https://slack.com/files/example" }]);
  assert.equal(received[1]?.externalConversationId, thread.parentTs);
  assert.equal(received[1]?.companyId, companyA);

  const second = await syncSlackThread(connection, { ...thread, cursorTs: first.cursorTs }, deps);
  assert.deepEqual(second, { ingested: 1, cursorTs: "1700000300.000400" });
  assert.equal(received[2]?.body, "Resolved after checking display");
  assert.equal(new URL(calls[1]!).searchParams.get("oldest"), first.cursorTs);
});

test("thread sync refuses a cross-company route and leaves failed ingestion for retry", async () => {
  const thread = {
    companyId: "22222222-2222-4222-8222-222222222222",
    externalRouteId: "CEXAMPLE01:companyalpha", parentTs: "1700000100.000200", title: "Help", cursorTs: null,
  };
  let calls = 0;
  const deps = {
    token: "test-token",
    fetch: async () => { calls += 1; return reply({ ok: true, messages: [{ ts: "1700000200.000300", text: "Reply" }] }); },
    ingest: async () => { throw new Error("store failed"); },
  };
  await assert.rejects(syncSlackThread(connection, thread, deps), /route/);
  assert.equal(calls, 0);
  await assert.rejects(syncSlackThread(connection, { ...thread, companyId: companyA }, deps), /store failed/);
  assert.equal(calls, 1);
});
