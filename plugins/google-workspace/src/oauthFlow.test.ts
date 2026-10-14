import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { DEFAULT_SCOPES } from "./googleAuth.js";
import { OAuthSessions, registerOAuthFlow } from "./oauthFlow.js";

const credentials = { clientId: "synthetic-client", clientSecret: "synthetic-private-client-secret" };
const grant = { refresh_token: "synthetic-private-refresh-token", access_token: "synthetic-private-access-token" };
const mockProvider: typeof fetch = async (url, init) => {
  assert.ok(init?.signal);
  assert.equal(init?.redirect, "error");
  assert.match(String(url), /^https:\/\/(oauth2\.googleapis\.com|www\.googleapis\.com)\//);
  return Response.json(String(url).endsWith("userinfo") ? { email: "synthetic@example.test", verified_email: true } : grant);
};

function callback(started: Awaited<ReturnType<OAuthSessions["start"]>>, query: Record<string, string> = { code: "synthetic-private-code" }) {
  const auth = new URL(started.authorizationUrl);
  const url = new URL(auth.searchParams.get("redirect_uri")!);
  url.search = new URLSearchParams({ state: auth.searchParams.get("state")!, ...query }).toString();
  return url.toString();
}

async function terminal(sessions: OAuthSessions, id: string) {
  for (let i = 0; i < 100; i++) {
    const result = sessions.poll(id);
    if (result.status !== "pending") return result;
    await delay(5);
  }
  throw new Error("synthetic provider did not finish");
}

test("Desktop consent includes all scopes, random loopback port, state, PKCE, offline and consent; HTTP callback grants once", async t => {
  let tokenCalls = 0;
  let tokenBody: URLSearchParams | undefined;
  const sessions = new OAuthSessions(async (url, init) => {
    if (String(url).endsWith("/token")) { tokenCalls++; tokenBody = new URLSearchParams(String(init?.body)); }
    return mockProvider(url, init);
  });
  t.after(() => sessions.shutdown());
  const started = await sessions.start(credentials);
  const auth = new URL(started.authorizationUrl);
  assert.equal(auth.origin, "https://accounts.google.com");
  assert.deepEqual(auth.searchParams.get("scope")!.split(" "), DEFAULT_SCOPES);
  for (const scope of ["calendar", "tasks", "spreadsheets", "drive"]) assert.ok(started.scopes.includes(`https://www.googleapis.com/auth/${scope}`));
  assert.equal(auth.searchParams.get("access_type"), "offline");
  assert.equal(auth.searchParams.get("prompt"), "consent");
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  assert.match(auth.searchParams.get("state")!, /^[A-Za-z0-9_-]{43}$/);
  assert.match(auth.searchParams.get("redirect_uri")!, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
  assert.ok(!started.authorizationUrl.includes(credentials.clientSecret));
  assert.ok(!started.authorizationUrl.includes(started.sessionId));
  const response = await fetch(callback(started));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.ok(!(await response.text()).includes("synthetic-private"));
  const result = await terminal(sessions, started.sessionId);
  assert.equal(result.status, "granted");
  assert.equal("refreshToken" in result && result.refreshToken, grant.refresh_token);
  assert.equal("user" in result && result.user?.email, "synthetic@example.test");
  assert.ok(!JSON.stringify(result).includes(grant.access_token));
  assert.equal(tokenBody!.get("grant_type"), "authorization_code");
  assert.equal(tokenBody!.get("client_secret"), credentials.clientSecret);
  assert.equal(tokenBody!.get("redirect_uri"), auth.searchParams.get("redirect_uri"));
  const verifier = tokenBody!.get("code_verifier")!;
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(createHash("sha256").update(verifier).digest("base64url"), auth.searchParams.get("code_challenge"));
  assert.equal(tokenCalls, 1);
  await assert.rejects(sessions.accept(started.sessionId, callback(started)), /EOAUTH_SESSION/);
  assert.equal(sessions.poll(started.sessionId).status, "expired");
});

test("shutdown while a listener is starting rejects promptly without leaving a session", { timeout: 1000 }, async () => {
  const sessions = new OAuthSessions(mockProvider);
  const starting = sessions.start(credentials);
  sessions.shutdown();
  await assert.rejects(starting, /EOAUTH_LISTENER/);
});

test("scope overrides are preserved; bad inputs never start a session", async t => {
  const sessions = new OAuthSessions(mockProvider);
  t.after(() => sessions.shutdown());
  const started = await sessions.start({ ...credentials, scopes: [DEFAULT_SCOPES[0]] });
  assert.deepEqual(started.scopes, [DEFAULT_SCOPES[0]]);
  await assert.rejects(sessions.start({ ...credentials, scopes: ["https://malicious.test/scope"] }), /EINVALID_INPUT/);
  await assert.rejects(sessions.start({ ...credentials, scopes: "calendar" }), /EINVALID_INPUT/);
  await assert.rejects(sessions.start({ ...credentials, clientSecret: "" }), /EINVALID_INPUT/);
});

test("HTTP callback rejects wrong or missing state, path and method without consuming the valid session", async t => {
  let calls = 0;
  const sessions = new OAuthSessions(async (url, init) => { calls++; return mockProvider(url, init); });
  t.after(() => sessions.shutdown());
  const started = await sessions.start(credentials);
  const valid = callback(started);
  for (const wrong of [valid.replace(/state=[^&]+/, "state=wrong"), valid.replace(/state=[^&]+&/, ""), valid.replace("/oauth/callback", "/wrong")]) {
    const response = await fetch(wrong);
    assert.equal(response.status, 400);
    assert.ok(!(await response.text()).includes("synthetic-private-code"));
  }
  assert.equal((await fetch(valid, { method: "POST" })).status, 405);
  assert.equal(calls, 0);
  assert.equal(sessions.poll(started.sessionId).status, "pending");
  assert.equal((await fetch(valid)).status, 200);
  assert.equal((await terminal(sessions, started.sessionId)).status, "granted");
});

test("denied callback ignores provider descriptions and closes the listener", async t => {
  let calls = 0;
  const sessions = new OAuthSessions(async () => { calls++; throw new Error("must not call provider"); });
  t.after(() => sessions.shutdown());
  const started = await sessions.start(credentials);
  const url = callback(started, { error: "access_denied", error_description: "synthetic-private-secret<script>" });
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.ok(!(await response.text()).includes("synthetic-private"));
  assert.equal(sessions.poll(started.sessionId).status, "denied");
  assert.equal(calls, 0);
  await assert.rejects(fetch(url));
});

test("remote/Docker pasted callbacks require exact original loopback address and state, and cannot replay", async t => {
  let calls = 0;
  const sessions = new OAuthSessions(async (url, init) => { calls++; return mockProvider(url, init); });
  t.after(() => sessions.shutdown());
  const started = await sessions.start(credentials);
  const other = await sessions.start(credentials);
  assert.notEqual(new URL(started.authorizationUrl).searchParams.get("state"), new URL(other.authorizationUrl).searchParams.get("state"));
  for (const wrong of [callback(started).replace("127.0.0.1", "remote.example"), callback(started).replace("127.0.0.1", "localhost"), callback(other), "/oauth/callback?code=some-code", callback(started) + "&state=duplicate", callback(started) + "&error=access_denied", callback(started) + "#fragment"]) {
    await assert.rejects(sessions.accept(started.sessionId, wrong), /EOAUTH_CALLBACK/);
  }
  const paste = sessions.accept(started.sessionId, callback(started));
  await assert.rejects(sessions.accept(started.sessionId, callback(started)), /EOAUTH_SESSION/);
  await paste;
  assert.equal(sessions.poll(started.sessionId).status, "granted");
  assert.equal(calls, 2);
  await assert.rejects(fetch(callback(started)));
});

test("expiry closes listener and cannot accept callback or deliver credentials", async t => {
  const sessions = new OAuthSessions(mockProvider, 80);
  t.after(() => sessions.shutdown());
  const started = await sessions.start(credentials);
  await delay(100);
  assert.equal(sessions.poll(started.sessionId).status, "expired");
  await assert.rejects(sessions.accept(started.sessionId, callback(started)), /EOAUTH_SESSION/);
  await assert.rejects(fetch(callback(started)));
});

test("provider failures redact JSON, non-JSON and network error descriptions", async t => {
  const responses = [
    async () => Response.json({ error: "invalid_client", error_description: credentials.clientSecret }, { status: 400 }),
    async () => new Response(grant.refresh_token, { status: 502 }),
    async () => { throw new Error(`Network problem ${credentials.clientSecret}`); },
    async () => Response.json({ access_token: grant.access_token }),
  ];
  for (const response of responses) {
    const sessions = new OAuthSessions(response);
    t.after(() => sessions.shutdown());
    const started = await sessions.start(credentials);
    await sessions.accept(started.sessionId, callback(started));
    const result = sessions.poll(started.sessionId);
    assert.equal(result.status, "failed");
    assert.ok(!JSON.stringify(result).includes("synthetic-private"));
    assert.match("error" in result ? result.error! : "", /EGOOGLE_(OAUTH|NO_REFRESH_TOKEN)/);
  }
});

test("cancel during token exchange aborts the request, closes listener and discards results", async t => {
  let aborted = false;
  const sessions = new OAuthSessions(async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => { aborted = true; reject(new Error(credentials.clientSecret)); });
  }));
  t.after(() => sessions.shutdown());
  const started = await sessions.start(credentials);
  const response = await fetch(callback(started));
  assert.equal(response.status, 200);
  assert.equal(sessions.poll(started.sessionId).status, "pending");
  sessions.cancel(started.sessionId);
  await delay(5);
  assert.equal(aborted, true);
  assert.equal(sessions.poll(started.sessionId).status, "expired");
  await assert.rejects(fetch(callback(started)));
});

test("userinfo failure preserves the refresh token and never exposes the provider's error", async t => {
  const sessions = new OAuthSessions(async (url, init) => {
    if (String(url).endsWith("userinfo")) throw new Error(`synthetic-private-provider-error ${grant.access_token}`);
    return mockProvider(url, init);
  });
  t.after(() => sessions.shutdown());
  const started = await sessions.start(credentials);
  await sessions.accept(started.sessionId, callback(started));
  const result = sessions.poll(started.sessionId);
  assert.equal(result.status, "granted");
  assert.equal("refreshToken" in result && result.refreshToken, grant.refresh_token);
  assert.deepEqual("user" in result && result.user, {email:null,name:null,verified:null});
  assert.ok(!JSON.stringify(result).includes("synthetic-private-provider-error"));
});

test("concurrent starts honor the cap; cancel frees it and shutdown closes all sessions", async t => {
  const sessions = new OAuthSessions(mockProvider, 600000, 1);
  t.after(() => sessions.shutdown());
  const [first, second] = await Promise.allSettled([sessions.start(credentials), sessions.start(credentials)]);
  assert.equal(first.status, "fulfilled");
  assert.equal(second.status, "rejected");
  if (first.status !== "fulfilled" || second.status !== "rejected") throw new Error("unexpected cap result");
  assert.match(second.reason.message, /EOAUTH_BUSY/);
  sessions.cancel(first.value.sessionId);
  await assert.rejects(fetch(callback(first.value)));
  const next = await sessions.start(credentials);
  sessions.shutdown();
  assert.equal(sessions.poll(next.sessionId).status, "expired");
  await assert.rejects(fetch(callback(next)));
  await assert.rejects(sessions.start(credentials), /EOAUTH_STOPPED/);
});

test("registered UI actions expose only loopback sessions; shutdown closes the pending listener", async () => {
  const actions = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
  const ctx = { actions: { register: (key: string, handler: (params: Record<string, unknown>) => Promise<unknown>) => actions.set(key, handler) } } as unknown as PluginContext;
  const shutdown = registerOAuthFlow(ctx);
  assert.deepEqual([...actions.keys()], ["oauth_start_loopback_flow", "oauth_poll_loopback_flow", "oauth_submit_callback", "oauth_cancel_loopback_flow"]);
  const started = await actions.get("oauth_start_loopback_flow")!(credentials) as Awaited<ReturnType<OAuthSessions["start"]>>;
  shutdown();
  await assert.rejects(fetch(callback(started)));
  assert.deepEqual(await actions.get("oauth_poll_loopback_flow")!({ sessionId: started.sessionId }), { status: "expired" });
});
