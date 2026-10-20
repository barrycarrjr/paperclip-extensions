import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createRequestId } from "./request-id.js";

function withCrypto(value: unknown, run: () => void) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { configurable: true, value });
  try { run(); }
  finally {
    if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
    else Reflect.deleteProperty(globalThis, "crypto");
  }
}

test("request IDs prefer native UUIDs with the crypto receiver intact", () => {
  const crypto = {
    randomUUID() { assert.equal(this, crypto); return "native-request-id"; },
    getRandomValues() { throw new Error("UUID support should take priority"); },
  };
  withCrypto(crypto, () => assert.equal(createRequestId(), "native-request-id"));
});

test("HTTP request IDs use 128 random bits when randomUUID is unavailable", () => {
  let calls = 0;
  const crypto = {
    getRandomValues(bytes: Uint8Array) {
      assert.equal(this, crypto);
      assert.equal(bytes.length, 16);
      calls += 1;
      bytes.set(Array.from({ length: 16 }, (_, index) => index));
      return bytes;
    },
  };
  withCrypto(crypto, () => assert.equal(createRequestId(), "000102030405060708090a0b0c0d0e0f"));
  assert.equal(calls, 1);
});

test("HTTP request IDs remain unique across rapid calls with real getRandomValues", () => {
  const browserCrypto = globalThis.crypto;
  withCrypto({ getRandomValues: browserCrypto.getRandomValues.bind(browserCrypto) }, () => {
    const ids = Array.from({ length: 1000 }, createRequestId);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.every((id) => /^[0-9a-f]{32}$/.test(id)));
  });
});

test("no-crypto fallback stays unique even with a frozen clock and repeated randomness", (t) => {
  t.mock.method(Date, "now", () => 0);
  t.mock.method(Math, "random", () => 0);
  for (const crypto of [undefined, {}]) {
    withCrypto(crypto, () => {
      const ids = Array.from({ length: 1000 }, createRequestId);
      assert.equal(new Set(ids).size, ids.length);
      assert.ok(ids.every((id) => id.length > 0 && id.length < 200));
    });
  }
});
