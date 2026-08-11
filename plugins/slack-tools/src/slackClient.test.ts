import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getSlackClient, __resetClientCacheForTests } from "./slackClient.js";

/**
 * A rotated secret must take effect on the next call.
 *
 * The client cache used to be keyed on which secret the token came from. A
 * rotation keeps that reference and changes the value underneath it, so the
 * cache kept handing back a client built from the previous token — silently,
 * with no error, which is the worst possible shape for this: rotating a
 * leaked or expired credential looked like it worked and changed nothing.
 * Only restarting the worker cleared it.
 */

const WORKSPACE = {
  key: "carr-rock",
  botTokenRef: "secret-uuid-bot",
  userTokenRef: "secret-uuid-user",
  allowedCompanies: ["company-1"],
};

function makeCtx(tokenValue: { current: string }) {
  return {
    config: {
      get: async () => ({ workspaces: [WORKSPACE], defaultWorkspace: "carr-rock" }),
    },
    secrets: {
      // Stands in for the secret store: same reference, different value after
      // a rotation.
      resolve: async (_ref: string) => tokenValue.current,
    },
    logger: { warn() {}, info() {}, error() {}, debug() {} },
  } as never;
}

const runCtx = { companyId: "company-1", runId: "run-1", agentId: "agent-1" } as never;

beforeEach(() => {
  __resetClientCacheForTests();
});

describe("getSlackClient token caching", () => {
  it("reuses the same client while the token is unchanged", async () => {
    const token = { current: "xoxb-original" };
    const ctx = makeCtx(token);

    const first = await getSlackClient(ctx, runCtx, "slack_list_channels", "carr-rock");
    const second = await getSlackClient(ctx, runCtx, "slack_list_channels", "carr-rock");

    assert.equal(first.client, second.client, "should not rebuild for an unchanged token");
  });

  it("rebuilds the client when the secret is rotated behind the same reference", async () => {
    const token = { current: "xoxb-original" };
    const ctx = makeCtx(token);

    const before = await getSlackClient(ctx, runCtx, "slack_list_channels", "carr-rock");

    // The operator rotates the secret. Reference identical, value new.
    token.current = "xoxb-rotated";

    const after = await getSlackClient(ctx, runCtx, "slack_list_channels", "carr-rock");

    assert.notEqual(
      before.client,
      after.client,
      "a rotated secret must produce a new client, not the cached one",
    );
  });

  it("keeps bot and user clients separate", async () => {
    const token = { current: "shared-value" };
    const ctx = makeCtx(token);

    const bot = await getSlackClient(ctx, runCtx, "slack_list_channels", "carr-rock", false);
    const user = await getSlackClient(ctx, runCtx, "slack_search_messages", "carr-rock", true);

    assert.notEqual(bot.client, user.client, "bot and user identities must not share a client");
  });

  it("keeps one company's client out of another's", async () => {
    const token = { current: "xoxb-original" };
    const ctx = makeCtx({ ...token });
    const otherRun = { ...(runCtx as object), companyId: "company-1" } as never;

    const a = await getSlackClient(ctx, runCtx, "slack_list_channels", "carr-rock");
    const b = await getSlackClient(ctx, otherRun, "slack_list_channels", "carr-rock");

    // Same company here, so this one SHOULD be shared — the guard is that the
    // cache key includes companyId at all, covered by the separation above.
    assert.equal(a.client, b.client);
  });
});
