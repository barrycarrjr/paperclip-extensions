import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  extractValidationDetail,
  helpScoutRequest,
  resolveReplyCustomer,
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

/** Records every request the client makes and answers each with a queued response. */
function stubFetch(queue: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const next = queue.shift();
    assert.ok(next, `unexpected extra fetch to ${String(input)}`);
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return {
      status: next.status,
      ok: next.status >= 200 && next.status < 300,
      headers: { get: () => null },
      text: async () => JSON.stringify(next.body),
    };
  }) as unknown as typeof fetch;
  return calls;
}

describe("resolveReplyCustomer", () => {
  it("falls back to the conversation's primary customer id", async () => {
    const calls = stubFetch([
      { status: 200, body: { id: 3399326055, primaryCustomer: { id: 55, email: "a@b.com" } } },
    ]);

    const customer = await resolveReplyCustomer(account(), "3399326055");

    assert.deepEqual(customer, { id: 55 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "GET");
    assert.match(calls[0].url, /\/conversations\/3399326055$/);
  });

  it("uses an explicit customerId without hitting the API", async () => {
    const calls = stubFetch([]);

    const customer = await resolveReplyCustomer(account(), "42", { customerId: "77" });

    assert.deepEqual(customer, { id: 77 });
    assert.equal(calls.length, 0);
  });

  it("rejects a non-numeric customerId", async () => {
    stubFetch([]);
    await assert.rejects(
      () => resolveReplyCustomer(account(), "42", { customerId: "not-a-number" }),
      /EINVALID_INPUT/,
    );
  });

  it("prefers the id when customerEmail matches the primary customer", async () => {
    stubFetch([{ status: 200, body: { primaryCustomer: { id: 55, email: "A@B.com" } } }]);

    const customer = await resolveReplyCustomer(account(), "42", { customerEmail: "a@b.com" });

    assert.deepEqual(customer, { id: 55 });
  });

  it("passes the address through when replying to someone else", async () => {
    stubFetch([{ status: 200, body: { primaryCustomer: { id: 55, email: "a@b.com" } } }]);

    const customer = await resolveReplyCustomer(account(), "42", {
      customerEmail: "someone-else@example.com",
    });

    assert.deepEqual(customer, { email: "someone-else@example.com" });
  });

  it("explains itself when the conversation has no customer to reply to", async () => {
    stubFetch([{ status: 200, body: { id: 42 } }]);

    await assert.rejects(
      () => resolveReplyCustomer(account(), "42"),
      /EHELP_SCOUT_NO_CUSTOMER/,
    );
  });
});

describe("Help Scout error detail", () => {
  it("surfaces the rejected field instead of a bare 'Bad Request'", async () => {
    stubFetch([
      {
        status: 400,
        body: {
          message: "Bad Request",
          _embedded: { errors: [{ path: "customer", message: "may not be null" }] },
        },
      },
    ]);

    await assert.rejects(
      () => helpScoutRequest(account(), "/conversations/42/reply", { method: "POST", body: {} }),
      /\[EHELP_SCOUT_400\] Bad Request \(customer: may not be null\)/,
    );
  });

  it("keeps the bare message when there are no field errors", () => {
    assert.equal(extractValidationDetail({ message: "Bad Request" }), null);
    assert.equal(extractValidationDetail(null), null);
    assert.equal(extractValidationDetail({ _embedded: { errors: [] } }), null);
  });

  it("joins several field errors and caps the list", () => {
    const errors = Array.from({ length: 7 }, (_, i) => ({ path: `f${i}`, message: "bad" }));
    assert.equal(
      extractValidationDetail({ _embedded: { errors } }),
      "f0: bad; f1: bad; f2: bad; f3: bad; f4: bad; +2 more",
    );
  });
});
