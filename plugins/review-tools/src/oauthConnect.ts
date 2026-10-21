/**
 * Connecting a Google account from inside Paperclip, instead of running a
 * script in a terminal and pasting a refresh token around.
 *
 * Why this exists: the plugin went dark for two weeks because its refresh
 * token was granted for the wrong product. There was no way to fix that in
 * the app, so the token in the settings was replaced by hand with one that
 * another plugin had minted for Calendar. It authenticated perfectly and
 * could not read a single review, and every error said only "insufficient
 * authentication scopes".
 *
 * The flow here always asks Google for exactly the permissions this plugin
 * needs, and reports back which ones Google actually granted, so a token
 * that cannot do the job is caught while somebody is still looking at the
 * screen.
 *
 * The shape (loopback listener on a random port, state, PKCE, one-use
 * sessions that expire, credentials wiped from memory at the end, and a
 * paste fallback for a browser that cannot reach the listener) is taken
 * from the google-workspace plugin's reviewed implementation rather than
 * invented here.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { PluginContext } from "@paperclipai/plugin-sdk";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const CALLBACK_PATH = "/oauth/callback";

/**
 * Where Google is asked to send the browser back to, tried in this order.
 *
 * A Desktop app client accepts any loopback address, so a random port would
 * do. A Web application client accepts only the addresses registered on it,
 * and the two fixed ones below are exactly what the earlier terminal scripts
 * told people to register (this plugin's at localhost:8080/callback, the
 * google-workspace plugin's at 127.0.0.1:54321/oauth/callback). Each is
 * checked with Google before it is used, so a client that accepts none of
 * them is reported here with the address to register, instead of sending
 * the person to Google's "redirect_uri_mismatch" page.
 */
interface RedirectCandidate {
  uri: string;
  hosts: string[];
  port: number;
  path: string;
}
const FIXED_REDIRECTS: RedirectCandidate[] = [
  { uri: "http://127.0.0.1:54321/oauth/callback", hosts: ["127.0.0.1"], port: 54321, path: "/oauth/callback" },
  // "localhost" can resolve to either loopback family in a browser, so both
  // are listened on; the registered text must stay exactly "localhost".
  { uri: "http://localhost:8080/callback", hosts: ["127.0.0.1", "::1"], port: 8080, path: "/callback" },
];
/** The address to tell a person to register when nothing is accepted. */
export const REDIRECT_TO_REGISTER = FIXED_REDIRECTS[0]!.uri;

const FAILURE =
  "[EGOOGLE_OAUTH] Google refused the authorization. Check the OAuth client id and secret, then try again.";

/** Reading and replying to reviews. Without this nothing in the plugin works. */
export const SCOPE_BUSINESS = "https://www.googleapis.com/auth/business.manage";
/** Reading review notification emails. Only the email polling job needs it. */
export const SCOPE_GMAIL = "https://www.googleapis.com/auth/gmail.readonly";

export const REQUIRED_SCOPES = [SCOPE_BUSINESS];
export const DEFAULT_SCOPES = [SCOPE_BUSINESS, SCOPE_GMAIL];

interface Session {
  /** One per loopback family the redirect host can resolve to. */
  servers: Server[];
  callbackPath: string;
  timer?: ReturnType<typeof setTimeout>;
  controller: AbortController;
  expiresAt: number;
  redirectUri: string;
  state: string;
  verifier: string;
  clientId: string;
  clientSecret: string;
  status: "pending" | "exchanging" | "granted" | "denied" | "failed";
  result?: {
    refreshToken: string;
    grantedScopes: string[];
    user: { email: string | null; name: string | null };
  };
  error?: string;
}

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 16384) {
    throw new Error(`[EINVALID_INPUT] ${name} is required and must be at most 16384 characters.`);
  }
  return value.trim();
}

function equalState(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Which of the permissions we asked for are missing from what Google
 * granted. Google returns the granted scopes on the token response, and a
 * person can untick a permission on the consent screen, so asking is not
 * the same as having.
 */
export function missingScopes(granted: string[], wanted: string[]): string[] {
  const have = new Set(granted);
  return wanted.filter((s) => !have.has(s));
}

/** A plain sentence naming what a token can and cannot do. */
export function describeGrantedScopes(granted: string[]): string {
  const business = granted.includes(SCOPE_BUSINESS);
  const gmail = granted.includes(SCOPE_GMAIL);
  if (business && gmail) return "This account can read and reply to reviews, and can read review notification emails.";
  if (business) return "This account can read and reply to reviews. Review notification emails will not be polled, because Gmail access was not granted.";
  if (gmail) return "This account can only read Gmail. It cannot read or reply to reviews, so the plugin will not work with it.";
  return "This account was granted none of the permissions the plugin needs.";
}

export class ConnectSessions {
  private readonly sessions = new Map<string, Session>();
  private stopped = false;

  constructor(
    private readonly request: typeof fetch = fetch,
    private readonly ttlMs = 10 * 60 * 1000,
    private readonly maxSessions = 4,
  ) {}

  async start(params: Record<string, unknown>) {
    const clientId = required(params.clientId, "clientId");
    const clientSecret = required(params.clientSecret, "clientSecret");
    const includeGmail = params.includeGmail !== false;
    const scopes = includeGmail ? [...DEFAULT_SCOPES] : [...REQUIRED_SCOPES];

    if (this.stopped) throw new Error("[EOAUTH_STOPPED] The plugin is restarting. Try again in a moment.");
    if (this.sessions.size >= this.maxSessions) {
      throw new Error("[EOAUTH_BUSY] Too many connection attempts are open. Cancel one, or wait ten minutes.");
    }

    const sessionId = randomBytes(32).toString("base64url");
    const session: Session = {
      servers: [],
      callbackPath: CALLBACK_PATH,
      controller: new AbortController(),
      expiresAt: Date.now() + this.ttlMs,
      redirectUri: "",
      state: randomBytes(32).toString("base64url"),
      verifier: randomBytes(32).toString("base64url"),
      clientId,
      clientSecret,
      status: "pending",
    };
    // Reserved before awaiting listen, so concurrent starts respect the cap.
    this.sessions.set(sessionId, session);
    session.timer = setTimeout(() => this.remove(sessionId), this.ttlMs);
    session.timer.unref();

    const onRequest = (server: Server) => (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.setHeader("referrer-policy", "no-referrer");
      if (req.method !== "GET") {
        res.writeHead(405);
        res.end("Use the Google redirect.");
        return;
      }
      void this.accept(sessionId, req.url ?? "", true, () => {
        res.end("Google response received. Close this tab and return to Paperclip.");
        server.close();
        server.closeIdleConnections();
      }).catch(() => {
        // The callback, the code, the state and Google's own error text are
        // never reflected into this page or into a log.
        if (res.writableEnded) return;
        res.writeHead(400);
        res.end("Invalid or expired callback. Return to Paperclip and try again.");
      });
    };

    const authUrlFor = (redirectUri: string) => {
      const url = new URL(AUTH_URL);
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: scopes.join(" "),
        access_type: "offline",
        prompt: "consent",
        state: session.state,
        code_challenge: createHash("sha256").update(session.verifier).digest("base64url"),
        code_challenge_method: "S256",
      }).toString();
      return url.toString();
    };

    /** Bind every host for a candidate; false (and nothing left open) when any port is taken. */
    const bind = async (hosts: string[], port: number): Promise<boolean> => {
      const opened: Server[] = [];
      for (const host of hosts) {
        const server = createServer();
        server.requestTimeout = 5000;
        server.headersTimeout = 5000;
        server.on("request", onRequest(server));
        try {
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(port, host, resolve);
          });
          opened.push(server);
        } catch {
          for (const s of opened) s.close();
          server.close();
          return false;
        }
      }
      session.servers = opened;
      return true;
    };

    try {
      let chosen: { uri: string; path: string } | null = null;
      // Addresses Google would accept whose port something else on this
      // machine already holds. Named in the failure, because "register this
      // address" is the wrong advice when it is already registered.
      const acceptedButBusy: RedirectCandidate[] = [];

      for (const candidate of FIXED_REDIRECTS) {
        const accepted = await this.redirectAccepted(authUrlFor(candidate.uri));
        if (accepted === false) continue;
        if (await bind(candidate.hosts, candidate.port)) {
          chosen = { uri: candidate.uri, path: candidate.path };
          break;
        }
        if (accepted === true) acceptedButBusy.push(candidate);
      }

      if (!chosen) {
        // A Desktop app client takes any loopback port; a Web application
        // client that accepted neither fixed address will reject this too,
        // and is told what to register rather than being sent to Google.
        if (!(await bind(["127.0.0.1"], 0))) throw new Error("listener unavailable");
        const address = session.servers[0]!.address();
        if (!address || typeof address === "string") throw new Error("listener unavailable");
        const uri = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`;
        if ((await this.redirectAccepted(authUrlFor(uri))) === false) {
          this.remove(sessionId);
          const busy = acceptedButBusy[0];
          if (busy) {
            throw new Error(
              `[EOAUTH_PORT_BUSY] Google accepts ${busy.uri} for this OAuth client, but port ${busy.port} is already in use on the machine running Paperclip, so the sign-in cannot come back here. Free that port, or add ${REDIRECT_TO_REGISTER} under Authorised redirect URIs on the client in the Google Cloud console and try again.`,
            );
          }
          throw new Error(
            `[EOAUTH_REDIRECT] This OAuth client is a Web application, which accepts only sign-in addresses registered on it, and none of the addresses this page can use are registered. In the Google Cloud console open APIs and Services, Credentials, this client, and add ${REDIRECT_TO_REGISTER} under Authorised redirect URIs, then try again. Or create a client of type Desktop app and connect it as a new account.`,
            );
        }
        chosen = { uri, path: CALLBACK_PATH };
      }

      if (!this.sessions.has(sessionId)) throw new Error("expired");
      session.redirectUri = chosen.uri;
      session.callbackPath = chosen.path;
      return {
        sessionId,
        authorizationUrl: authUrlFor(chosen.uri),
        redirectUri: chosen.uri,
        expiresIn: this.ttlMs / 1000,
        scopes,
      };
    } catch (err) {
      this.remove(sessionId);
      if (err instanceof Error && /^\[EOAUTH_(REDIRECT|PORT_BUSY)\]/.test(err.message)) throw err;
      throw new Error(
        "[EOAUTH_LISTENER] Could not open the local callback listener. Try again, or use the grant script from the plugins repo.",
      );
    }
  }

  /**
   * Ask Google, without a browser, whether it will send a person back to
   * this address for this client. Google answers an unacceptable address
   * with a redirect to its own error page before anyone signs in, so the
   * check is cheap and needs no credentials. Unknown (a network failure,
   * or an answer in a shape not seen before) counts as acceptable, so a
   * hiccup here never blocks a connection that would have worked.
   */
  private async redirectAccepted(authorizationUrl: string): Promise<boolean | null> {
    const timeout = AbortSignal.timeout(8000);
    try {
      const response = await this.request(authorizationUrl, { redirect: "manual", signal: timeout });
      const location = response.headers.get("location") ?? "";
      if (location.includes("/signin/oauth/error")) return false;
      return true;
    } catch {
      return null;
    }
  }

  private active(sessionId: unknown): Session | undefined {
    if (typeof sessionId !== "string") throw new Error("[EINVALID_INPUT] sessionId is required.");
    const session = this.sessions.get(sessionId);
    if (session && Date.now() >= session.expiresAt) {
      this.remove(sessionId);
      return undefined;
    }
    return session;
  }

  async accept(sessionId: string, callback: string, fromListener = false, onAccepted?: () => void): Promise<void> {
    const session = this.active(sessionId);
    if (!session || session.status !== "pending") {
      throw new Error("[EOAUTH_SESSION] This connection attempt expired or was already used. Start again.");
    }
    let url: URL;
    try {
      if (typeof callback !== "string" || callback.length > 16384) throw new Error("invalid");
      // A pasted callback is a whole URL; the listener hands us a path.
      url = fromListener ? new URL(callback, session.redirectUri) : new URL(callback);
      const expected = new URL(session.redirectUri);
      if (
        url.origin !== expected.origin ||
        url.pathname !== session.callbackPath ||
        url.username ||
        url.password ||
        url.hash
      ) {
        throw new Error("invalid");
      }
      if (
        url.searchParams.getAll("state").length !== 1 ||
        !equalState(url.searchParams.get("state") ?? "", session.state)
      ) {
        throw new Error("invalid");
      }
      const codes = url.searchParams.getAll("code");
      const errors = url.searchParams.getAll("error");
      if (codes.length + errors.length !== 1 || (codes.length === 1 && (!codes[0] || codes[0].length > 4096))) {
        throw new Error("invalid");
      }
    } catch {
      throw new Error(
        "[EOAUTH_CALLBACK] That callback URL does not match this attempt. Paste the complete address Google redirected to.",
      );
    }

    // Locked before any network call, so neither a paste nor the listener
    // can replay it.
    session.status = url.searchParams.has("error") ? "denied" : "exchanging";
    onAccepted?.();
    if (!fromListener) {
      for (const server of session.servers) {
        server.close();
        server.closeAllConnections();
      }
    }
    if (session.status === "denied") {
      this.clearCredentials(session);
      return;
    }

    const timeout = setTimeout(() => session.controller.abort(), 15000);
    timeout.unref();
    try {
      const response = await this.request(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: session.clientId,
          client_secret: session.clientSecret,
          code: url.searchParams.get("code")!,
          redirect_uri: session.redirectUri,
          code_verifier: session.verifier,
          grant_type: "authorization_code",
        }).toString(),
        signal: session.controller.signal,
        redirect: "error",
      });
      const json = (await response.json()) as Record<string, unknown>;
      if (!response.ok || json.error) throw new Error("provider rejected request");
      if (typeof json.refresh_token !== "string" || !json.refresh_token) {
        session.error =
          "[EGOOGLE_NO_REFRESH_TOKEN] Google returned no refresh token. Remove this app at myaccount.google.com/permissions, then connect again.";
        throw new Error("no refresh token");
      }
      const grantedScopes = typeof json.scope === "string" ? json.scope.split(" ").filter(Boolean) : [];

      let user: { email: string | null; name: string | null } = { email: null, name: null };
      if (typeof json.access_token === "string" && json.access_token) {
        try {
          const infoResponse = await this.request(USERINFO_URL, {
            headers: { authorization: `Bearer ${json.access_token}` },
            signal: session.controller.signal,
            redirect: "error",
          });
          if (infoResponse.ok) {
            const info = (await infoResponse.json()) as Record<string, unknown>;
            user = {
              email: typeof info.email === "string" ? info.email : null,
              name: typeof info.name === "string" ? info.name : null,
            };
          }
        } catch {
          // The email is a label on the settings page. Failing to read it
          // does not throw away a grant that otherwise worked.
        }
      }
      if (this.active(sessionId) !== session) return;
      session.result = { refreshToken: json.refresh_token, grantedScopes, user };
      session.status = "granted";
    } catch {
      if (this.active(sessionId) === session) {
        session.status = "failed";
        session.error ??= FAILURE;
      }
    } finally {
      clearTimeout(timeout);
      this.clearCredentials(session);
    }
  }

  poll(sessionId: unknown) {
    const session = this.active(sessionId);
    if (!session) return { status: "expired" as const };
    if (session.status === "pending" || session.status === "exchanging") return { status: "pending" as const };
    const result = session.result;
    const payload = {
      status: session.status,
      ...(result
        ? {
            refreshToken: result.refreshToken,
            grantedScopes: result.grantedScopes,
            user: result.user,
            missingScopes: missingScopes(result.grantedScopes, REQUIRED_SCOPES),
            scopeSummary: describeGrantedScopes(result.grantedScopes),
          }
        : {}),
      error: session.error,
    };
    this.remove(sessionId as string);
    return payload;
  }

  cancel(sessionId: unknown) {
    this.active(sessionId);
    this.remove(sessionId as string);
    return { status: "cancelled" };
  }

  private clearCredentials(session: Session) {
    session.clientId = "";
    session.clientSecret = "";
    session.verifier = "";
  }

  private remove(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    clearTimeout(session.timer);
    session.controller.abort();
    for (const server of session.servers) {
      server.close();
      server.closeAllConnections();
    }
    this.clearCredentials(session);
    session.result = undefined;
  }

  shutdown(): void {
    this.stopped = true;
    for (const id of this.sessions.keys()) this.remove(id);
  }
}

/**
 * How the worker turns an existing account's key into its OAuth client
 * credentials, so reconnecting never asks a person to paste them again.
 * Returns null when the request named no account and carries its own.
 */
export type ResolveStartCredentials = (
  params: Record<string, unknown>,
) => Promise<{ clientId: string; clientSecret: string } | null>;

export function registerConnectFlow(ctx: PluginContext, resolveExisting: ResolveStartCredentials): () => void {
  // Node's own fetch, so the host's HTTP tracing never sees a credential.
  const sessions = new ConnectSessions();
  ctx.actions.register("google_connect_start", async (params) => {
    const existing = await resolveExisting(params);
    return sessions.start(existing ? { ...params, ...existing } : params);
  });
  ctx.actions.register("google_connect_poll", async (params) => sessions.poll(params.sessionId));
  ctx.actions.register("google_connect_submit_callback", async (params) => {
    await sessions.accept(required(params.sessionId, "sessionId"), required(params.callbackUrl, "callbackUrl"));
    return { status: "received" };
  });
  ctx.actions.register("google_connect_cancel", async (params) => sessions.cancel(params.sessionId));
  return () => sessions.shutdown();
}
