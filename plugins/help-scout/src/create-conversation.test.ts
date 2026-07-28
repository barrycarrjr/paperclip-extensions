import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  conversationIdFromLocation,
  helpScoutRequest,
  type ResolvedAccount,
} from "./helpScoutClient.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function account(): ResolvedAccount {
  return {
    account: { key: "acme" },
    accountKey: "acme",
    apiKey: "token-abc",
    reportCache: new Map(),
    refreshAccessToken: async () => "token-abc",
  };
}

/** Answers one request, with headers the caller can actually read. */
function stubFetchWithHeaders(status: number, headers: Record<string, string>, body: unknown) {
  globalThis.fetch = (async () => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  })) as unknown as typeof fetch;
}

describe("conversationIdFromLocation", () => {
  it("pulls the id out of a Help Scout Location header", () => {
    assert.equal(
      conversationIdFromLocation("https://api.helpscout.net/v2/conversations/2913724936"),
      "2913724936",
    );
  });

  it("tolerates a query string on the location", () => {
    assert.equal(
      conversationIdFromLocation("https://api.helpscout.net/v2/conversations/42?embed=threads"),
      "42",
    );
  });

  it("returns null when there is nothing to parse", () => {
    assert.equal(conversationIdFromLocation(null), null);
    assert.equal(conversationIdFromLocation(undefined), null);
    assert.equal(conversationIdFromLocation(""), null);
    assert.equal(conversationIdFromLocation("https://api.helpscout.net/v2/mailboxes/9"), null);
  });
});

describe("helpScoutRequest on a create", () => {
  it("surfaces the Location header for a 201 with an empty body", async () => {
    stubFetchWithHeaders(
      201,
      { location: "https://api.helpscout.net/v2/conversations/2913724936" },
      undefined,
    );

    const resp = await helpScoutRequest(account(), "/conversations", {
      method: "POST",
      body: { subject: "Hello" },
      expectStatus: [201],
    });

    assert.equal(resp.status, 201);
    assert.equal(resp.body, null);
    assert.equal(conversationIdFromLocation(resp.location), "2913724936");
  });

  it("reports null location when Help Scout omits the header", async () => {
    stubFetchWithHeaders(201, {}, { id: 7 });

    const resp = await helpScoutRequest<{ id: number }>(account(), "/conversations", {
      method: "POST",
      body: { subject: "Hello" },
      expectStatus: [201],
    });

    assert.equal(resp.location, null);
    assert.equal(resp.body?.id, 7);
  });
});
