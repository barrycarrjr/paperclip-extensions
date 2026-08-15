/**
 * Tests for the short-lived mailbox password cache.
 *
 * The bug these guard: every mailbox operation asked the host to decrypt the
 * password again. The host rate-limits secret resolution, so a burst of
 * operator actions plus background polling exhausted the budget and the
 * failures surfaced in the UI as 502s.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { SecretCache } from "./secret-cache.js";

/** A resolver that counts calls, standing in for `ctx.secrets.resolve`. */
function countingResolver(value = "app-password") {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    resolve: async () => {
      calls += 1;
      return value;
    },
  };
}

test("repeat operations inside the window resolve the secret once", async () => {
  const cache = new SecretCache({ ttlMs: 60_000 });
  const resolver = countingResolver();

  for (let i = 0; i < 20; i++) {
    const value = await cache.resolve("personal", "secret-a", resolver.resolve);
    assert.equal(value, "app-password");
  }

  assert.equal(resolver.calls, 1);
});

test("concurrent callers share a single resolution", async () => {
  const cache = new SecretCache({ ttlMs: 60_000 });
  let calls = 0;
  let release: (v: string) => void = () => {};
  const resolve = async () => {
    calls += 1;
    return new Promise<string>((r) => {
      release = r;
    });
  };

  const inFlight = Promise.all(
    Array.from({ length: 8 }, () => cache.resolve("personal", "secret-a", resolve)),
  );
  release("app-password");
  const values = await inFlight;

  assert.equal(calls, 1);
  assert.deepEqual(new Set(values), new Set(["app-password"]));
});

test("the value is re-resolved once the window expires, so rotation is honoured", async () => {
  let clock = 1_000;
  const cache = new SecretCache({ ttlMs: 60_000, now: () => clock });
  let current = "old-password";
  let calls = 0;
  const resolve = async () => {
    calls += 1;
    return current;
  };

  assert.equal(await cache.resolve("personal", "secret-a", resolve), "old-password");

  // Rotated at the provider, but still inside the reuse window.
  current = "new-password";
  assert.equal(await cache.resolve("personal", "secret-a", resolve), "old-password");
  assert.equal(calls, 1);

  clock += 60_001;
  assert.equal(await cache.resolve("personal", "secret-a", resolve), "new-password");
  assert.equal(calls, 2);
});

test("a different secret ref never reads another ref's cached value", async () => {
  const cache = new SecretCache({ ttlMs: 60_000 });
  const resolve = async () => "from-resolver";

  await cache.resolve("personal", "secret-a", async () => "value-a");
  const b = await cache.resolve("personal", "secret-b", resolve);

  assert.equal(b, "from-resolver");
});

test("mailboxes do not share cache entries", async () => {
  const cache = new SecretCache({ ttlMs: 60_000 });

  const personal = await cache.resolve("personal", "secret-a", async () => "personal-pass");
  const work = await cache.resolve("shared-inbox", "secret-a", async () => "work-pass");

  assert.equal(personal, "personal-pass");
  assert.equal(work, "work-pass");
});

test("a failed resolution is not cached and the next caller retries", async () => {
  const cache = new SecretCache({ ttlMs: 60_000 });
  let calls = 0;
  const resolve = async () => {
    calls += 1;
    if (calls === 1) throw new Error("Rate limit exceeded for secret resolution");
    return "app-password";
  };

  await assert.rejects(() => cache.resolve("personal", "secret-a", resolve), /Rate limit/);
  assert.equal(await cache.resolve("personal", "secret-a", resolve), "app-password");
  assert.equal(calls, 2);
});

test("clear and invalidateMailbox drop cached values", async () => {
  const cache = new SecretCache({ ttlMs: 60_000 });
  await cache.resolve("personal", "secret-a", async () => "one");
  await cache.resolve("shared-inbox", "secret-b", async () => "two");
  assert.equal(cache.size, 2);

  cache.invalidateMailbox("personal");
  assert.equal(cache.size, 1);

  cache.clear();
  assert.equal(cache.size, 0);

  // After clearing, the next call goes back to the resolver.
  const refetched = await cache.resolve("personal", "secret-a", async () => "fresh");
  assert.equal(refetched, "fresh");
});
