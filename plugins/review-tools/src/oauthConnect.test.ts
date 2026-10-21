/**
 * The connection flow, with Google replaced by a stub.
 *
 * The case that matters most is the last one: a grant that comes back
 * without permission to manage business listings must be reported as
 * missing, because saving it is exactly how this plugin ended up holding a
 * Calendar token and failing every call for two weeks.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { setTimeout as delay } from "node:timers/promises";
import {
  ConnectSessions,
  DEFAULT_SCOPES,
  REQUIRED_SCOPES,
  SCOPE_BUSINESS,
  SCOPE_GMAIL,
  describeGrantedScopes,
  missingScopes,
  REDIRECT_TO_REGISTER,
} from "./oauthConnect.js";

const credentials = { clientId: "synthetic-client", clientSecret: "synthetic-private-secret" };

function stubGoogle(scope: string, overrides: Record<string, unknown> = {}): typeof fetch {
  return async (url, init) => {
    assert.ok(init?.signal, "every call must be abortable");
    const target = String(url);
    assert.match(target, /^https:\/\/(oauth2\.googleapis\.com|www\.googleapis\.com)\//);
    if (target.endsWith("userinfo")) return Response.json({ email: "owner@example.test" });
    return Response.json({
      refresh_token: "synthetic-private-refresh-token",
      access_token: "synthetic-private-access-token",
      scope,
      ...overrides,
    });
  };
}

function callbackFor(started: { authorizationUrl: string }, query: Record<string, string> = { code: "synthetic-code" }) {
  const auth = new URL(started.authorizationUrl);
  const url = new URL(auth.searchParams.get("redirect_uri")!);
  url.search = new URLSearchParams({ state: auth.searchParams.get("state")!, ...query }).toString();
  return url.toString();
}

async function settled(sessions: ConnectSessions, id: string) {
  for (let i = 0; i < 100; i++) {
    const result = sessions.poll(id);
    if (result.status !== "pending") return result;
    await delay(5);
  }
  throw new Error("the stub never finished");
}

test("consent asks for both permissions, on a loopback port, with state and PKCE", async (t) => {
  const sessions = new ConnectSessions(stubGoogle(DEFAULT_SCOPES.join(" ")));
  t.after(() => sessions.shutdown());

  const started = await sessions.start(credentials);
  const auth = new URL(started.authorizationUrl);
  assert.equal(auth.origin, "https://accounts.google.com");
  assert.deepEqual(auth.searchParams.get("scope")!.split(" "), DEFAULT_SCOPES);
  assert.equal(auth.searchParams.get("access_type"), "offline");
  assert.equal(auth.searchParams.get("prompt"), "consent");
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  // One of the two fixed addresses a Web client may have registered, or a
  // random loopback port; whichever this machine had free.
  assert.match(auth.searchParams.get("redirect_uri")!, /^http:\/\/(127\.0\.0\.1|localhost):\d+\/(oauth\/)?callback$/);
  assert.equal(started.redirectUri, auth.searchParams.get("redirect_uri"));
  // Neither the client secret nor the session id may travel to Google.
  assert.ok(!started.authorizationUrl.includes(credentials.clientSecret));
  assert.ok(!started.authorizationUrl.includes(started.sessionId));
});

test("leaving Gmail out asks only for the permission the plugin cannot work without", async (t) => {
  const sessions = new ConnectSessions(stubGoogle(SCOPE_BUSINESS));
  t.after(() => sessions.shutdown());
  const started = await sessions.start({ ...credentials, includeGmail: false });
  assert.deepEqual(new URL(started.authorizationUrl).searchParams.get("scope")!.split(" "), REQUIRED_SCOPES);
});

test("a granted callback returns the token, the granted scopes, and nothing missing", async (t) => {
  const sessions = new ConnectSessions(stubGoogle(DEFAULT_SCOPES.join(" ")));
  t.after(() => sessions.shutdown());
  const started = await sessions.start(credentials);

  const response = await fetch(callbackFor(started));
  assert.equal(response.status, 200);
  const page = await response.text();
  // The page a browser lands on must never echo the code or the token.
  assert.ok(!page.includes("synthetic-private"));
  assert.ok(!page.includes("synthetic-code"));

  const result = await settled(sessions, started.sessionId);
  assert.equal(result.status, "granted");
  assert.equal(result.refreshToken, "synthetic-private-refresh-token");
  assert.deepEqual(result.missingScopes, []);
  assert.equal(result.user?.email, "owner@example.test");
});

test("a grant without business.manage is reported as missing it", async (t) => {
  // Exactly the live failure: a token good for Calendar and nothing else.
  const calendarOnly = "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/userinfo.email";
  const sessions = new ConnectSessions(stubGoogle(calendarOnly));
  t.after(() => sessions.shutdown());
  const started = await sessions.start(credentials);
  await fetch(callbackFor(started));

  const result = await settled(sessions, started.sessionId);
  assert.equal(result.status, "granted");
  assert.deepEqual(result.missingScopes, [SCOPE_BUSINESS]);
  // A Calendar token carries neither of the two permissions this plugin
  // uses, so the summary says none rather than naming one of them.
  assert.match(String(result.scopeSummary), /none of the permissions/);
});

test("a session is one use only", async (t) => {
  const sessions = new ConnectSessions(stubGoogle(DEFAULT_SCOPES.join(" ")));
  t.after(() => sessions.shutdown());
  const started = await sessions.start(credentials);
  await fetch(callbackFor(started));
  await settled(sessions, started.sessionId);
  assert.equal(sessions.poll(started.sessionId).status, "expired");
});

test("a callback carrying the wrong state is refused", async (t) => {
  const sessions = new ConnectSessions(stubGoogle(DEFAULT_SCOPES.join(" ")));
  t.after(() => sessions.shutdown());
  const started = await sessions.start(credentials);
  const auth = new URL(started.authorizationUrl);
  const forged = new URL(auth.searchParams.get("redirect_uri")!);
  forged.search = new URLSearchParams({ state: "not-the-state", code: "x" }).toString();

  await assert.rejects(
    () => sessions.accept(started.sessionId, forged.toString()),
    /EOAUTH_CALLBACK/,
  );
});

test("Google declining is reported as declined, not as a failure to fix", async (t) => {
  const sessions = new ConnectSessions(stubGoogle(DEFAULT_SCOPES.join(" ")));
  t.after(() => sessions.shutdown());
  const started = await sessions.start(credentials);
  await sessions.accept(started.sessionId, callbackFor(started, { error: "access_denied" }));
  assert.equal(sessions.poll(started.sessionId).status, "denied");
});

test("a response with no refresh token says how to force one", async (t) => {
  const sessions = new ConnectSessions(stubGoogle(DEFAULT_SCOPES.join(" "), { refresh_token: undefined }));
  t.after(() => sessions.shutdown());
  const started = await sessions.start(credentials);
  await fetch(callbackFor(started));
  const result = await settled(sessions, started.sessionId);
  assert.equal(result.status, "failed");
  assert.match(String(result.error), /EGOOGLE_NO_REFRESH_TOKEN/);
  assert.match(String(result.error), /myaccount\.google\.com\/permissions/);
});

test("missingScopes and the summary describe a grant plainly", () => {
  assert.deepEqual(missingScopes([SCOPE_BUSINESS], REQUIRED_SCOPES), []);
  assert.deepEqual(missingScopes([SCOPE_GMAIL], REQUIRED_SCOPES), [SCOPE_BUSINESS]);
  assert.match(describeGrantedScopes([SCOPE_BUSINESS, SCOPE_GMAIL]), /read and reply to reviews/);
  assert.match(describeGrantedScopes([SCOPE_BUSINESS]), /will not be polled/);
  assert.match(describeGrantedScopes([]), /none of the permissions/);
});

/** Google, answering the pre-check: an address is accepted unless the stub says otherwise. */
function stubWebClient(acceptedRedirects: string[], scope = DEFAULT_SCOPES.join(" ")): typeof fetch {
  const base = stubGoogle(scope);
  return async (url, init) => {
    const target = String(url);
    if (target.startsWith("https://accounts.google.com/o/oauth2/v2/auth")) {
      const redirect = new URL(target).searchParams.get("redirect_uri") ?? "";
      const ok = acceptedRedirects.includes(redirect);
      return new Response("", {
        status: 302,
        headers: { location: ok ? "https://accounts.google.com/signin/identifier" : "https://accounts.google.com/signin/oauth/error?authError=x" },
      });
    }
    return base(url, init);
  };
}

test("a Web client that accepts only the legacy localhost:8080 address gets exactly that address, and the callback still lands", async (t) => {
  const sessions = new ConnectSessions(stubWebClient(["http://localhost:8080/callback"]));
  t.after(() => sessions.shutdown());
  let started;
  try {
    started = await sessions.start(credentials);
  } catch (err) {
    // Port 8080 belongs to something else on this machine. The flow must
    // then say exactly that, not tell the person to register an address
    // Google already accepts.
    if (String(err).includes("EOAUTH_PORT_BUSY")) {
      assert.match(String(err), /port 8080 is already in use/);
      t.skip("port 8080 is in use here; the busy-port message was checked instead");
      return;
    }
    throw err;
  }
  assert.equal(started.redirectUri, "http://localhost:8080/callback");
  const response = await fetch(callbackFor(started));
  assert.equal(response.status, 200);
  const result = await settled(sessions, started.sessionId);
  assert.equal(result.status, "granted");
});

test("a Web client that accepts none of the addresses is told what to register, and nothing is left listening", async (t) => {
  const sessions = new ConnectSessions(stubWebClient([]));
  t.after(() => sessions.shutdown());
  await assert.rejects(() => sessions.start(credentials), (err: Error) => {
    assert.match(err.message, /^\[EOAUTH_REDIRECT\]/);
    assert.ok(err.message.includes(REDIRECT_TO_REGISTER));
    assert.match(err.message, /Desktop app/);
    return true;
  });
  assert.equal(sessions.poll("anything").status, "expired");
});

test("a network failure during the pre-check does not block a connection", async (t) => {
  const base = stubGoogle(DEFAULT_SCOPES.join(" "));
  const sessions = new ConnectSessions(async (url, init) => {
    if (String(url).startsWith("https://accounts.google.com/o/oauth2/v2/auth")) throw new Error("offline");
    return base(url, init);
  });
  t.after(() => sessions.shutdown());
  const started = await sessions.start(credentials);
  assert.ok(started.authorizationUrl.startsWith("https://accounts.google.com/"));
});
