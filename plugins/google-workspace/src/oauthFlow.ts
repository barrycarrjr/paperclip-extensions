/** Desktop-client consent sessions. Credentials stay in worker memory until completion or expiry. */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { DEFAULT_SCOPES } from "./googleAuth.js";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const CALLBACK_PATH = "/oauth/callback";
const FAILURE = "[EGOOGLE_OAUTH] Google authorization failed. Check the Desktop app client credentials and retry.";

interface Session {
  server: Server;
  timer?: ReturnType<typeof setTimeout>;
  controller: AbortController;
  expiresAt: number;
  redirectUri: string;
  state: string;
  verifier: string;
  clientId: string;
  clientSecret: string;
  status: "pending" | "exchanging" | "granted" | "denied" | "failed";
  result?: { refreshToken: string; user: { email: string | null; name: string | null; verified: boolean | null } };
  error?: string;
}

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 16384)
    throw new Error(`[EINVALID_INPUT] ${name} is required and must be at most 16384 characters.`);
  return value.trim();
}

function equalState(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class OAuthSessions {
  private readonly sessions = new Map<string, Session>();
  private stopped = false;

  constructor(
    private readonly request: typeof fetch = fetch,
    private readonly ttlMs = 10 * 60 * 1000,
    private readonly maxSessions = 8,
  ) {}

  async start(params: Record<string, unknown>) {
    const clientId = required(params.clientId, "clientId");
    const clientSecret = required(params.clientSecret, "clientSecret");
    const scopes = params.scopes === undefined || (Array.isArray(params.scopes) && params.scopes.length === 0)
      ? [...DEFAULT_SCOPES]
      : params.scopes;
    if (!Array.isArray(scopes) || scopes.length > 50 || scopes.some(s => typeof s !== "string" || !/^https:\/\/www\.googleapis\.com\/auth\/[A-Za-z0-9._/-]+$/.test(s)))
      throw new Error("[EINVALID_INPUT] Use Google scope URLs, separated by spaces or commas.");
    if (this.stopped) throw new Error("[EOAUTH_STOPPED] Setup worker is stopping. Retry after it restarts.");
    if (this.sessions.size >= this.maxSessions)
      throw new Error("[EOAUTH_BUSY] Too many setup sessions. Cancel another session or wait ten minutes.");

    const sessionId = randomBytes(32).toString("base64url");
    const session: Session = {
      server: createServer(), controller: new AbortController(), expiresAt: Date.now() + this.ttlMs,
      redirectUri: "", state: randomBytes(32).toString("base64url"),
      verifier: randomBytes(32).toString("base64url"), clientId, clientSecret, status: "pending",
    };
    // Reserve before awaiting listen, so concurrent starts respect the limit.
    this.sessions.set(sessionId, session);
    session.timer = setTimeout(() => this.remove(sessionId), this.ttlMs);
    session.timer.unref();
    session.server.requestTimeout = 5000;
    session.server.headersTimeout = 5000;
    session.server.on("request", (req, res) => {
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.setHeader("referrer-policy", "no-referrer");
      if (req.method !== "GET") { res.writeHead(405); res.end("Use the Google redirect."); return; }
      void this.accept(sessionId, req.url ?? "", true, () => {
        res.end("Google response received. Close this tab and return to Paperclip.");
        session.server.close();
        session.server.closeIdleConnections();
      }).catch(() => {
        // Never reflect the callback, code, state, or provider error in a page or log.
        if (res.writableEnded) return;
        res.writeHead(400); res.end("Invalid or expired callback. Return to Paperclip and retry.");
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        session.server.once("error", reject);
        session.server.once("close", () => reject(new Error("listener closed")));
        session.server.listen(0, "127.0.0.1", resolve);
      });
      if (!this.sessions.has(sessionId)) throw new Error("expired");
      const address = session.server.address();
      if (!address || typeof address === "string") throw new Error("listener unavailable");
      session.redirectUri = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`;
      const url = new URL(AUTH_URL);
      url.search = new URLSearchParams({
        client_id: clientId, redirect_uri: session.redirectUri, response_type: "code",
        scope: scopes.join(" "), access_type: "offline", prompt: "consent", state: session.state,
        code_challenge: createHash("sha256").update(session.verifier).digest("base64url"),
        code_challenge_method: "S256",
      }).toString();
      return { sessionId, authorizationUrl: url.toString(), expiresIn: this.ttlMs / 1000, scopes };
    } catch {
      this.remove(sessionId);
      throw new Error("[EOAUTH_LISTENER] Could not start the local callback listener. Retry or use the CLI helper.");
    }
  }

  private active(sessionId: unknown): Session | undefined {
    if (typeof sessionId !== "string") throw new Error("[EINVALID_INPUT] sessionId is required.");
    const session = this.sessions.get(sessionId);
    if (session && Date.now() >= session.expiresAt) { this.remove(sessionId); return undefined; }
    return session;
  }

  async accept(sessionId: string, callback: string, fromListener = false, onAccepted?: () => void): Promise<void> {
    const session = this.active(sessionId);
    if (!session || session.status !== "pending")
      throw new Error("[EOAUTH_SESSION] Callback session expired or already used. Start over.");
    let url: URL;
    try {
      if (typeof callback !== "string" || callback.length > 16384) throw new Error("invalid");
      // Pasted callbacks must be complete URLs. Local requests are relative paths.
      url = fromListener ? new URL(callback, session.redirectUri) : new URL(callback);
      const expected = new URL(session.redirectUri);
      if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.username || url.password || url.hash)
        throw new Error("invalid");
      if (url.searchParams.getAll("state").length !== 1 || !equalState(url.searchParams.get("state") ?? "", session.state))
        throw new Error("invalid");
      const codes = url.searchParams.getAll("code");
      const errors = url.searchParams.getAll("error");
      if (codes.length + errors.length !== 1 || (codes.length === 1 && (!codes[0] || codes[0].length > 4096)))
        throw new Error("invalid");
    } catch {
      throw new Error("[EOAUTH_CALLBACK] Callback URL or state did not match this session. Paste the complete redirect URL from this consent attempt.");
    }
    // Lock before awaiting any provider request. Neither paste nor loopback can replay it.
    session.status = url.searchParams.has("error") ? "denied" : "exchanging";
    onAccepted?.();
    // Paste fallback does not have a local HTTP response to finish.
    if (!fromListener) { session.server.close(); session.server.closeAllConnections(); }
    if (session.status === "denied") { this.clearCredentials(session); return; }

    const timeout = setTimeout(() => session.controller.abort(), 15000);
    timeout.unref();
    try {
      const response = await this.request(TOKEN_URL, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: session.clientId, client_secret: session.clientSecret,
          code: url.searchParams.get("code")!, redirect_uri: session.redirectUri,
          code_verifier: session.verifier, grant_type: "authorization_code",
        }).toString(), signal: session.controller.signal, redirect: "error",
      });
      const json = await response.json() as Record<string, unknown>;
      if (!response.ok || json.error) throw new Error("provider rejected request");
      if (typeof json.refresh_token !== "string" || !json.refresh_token) {
        session.error = "[EGOOGLE_NO_REFRESH_TOKEN] No refresh token returned. Check the Desktop app client and retry consent.";
        throw new Error("no refresh token");
      }
      let user: NonNullable<Session["result"]>["user"] = { email: null, name: null, verified: null };
      if (typeof json.access_token === "string" && json.access_token) {
        try {
          const infoResponse = await this.request(USERINFO_URL, {
            headers: { authorization: `Bearer ${json.access_token}` }, signal: session.controller.signal, redirect: "error",
          });
          if (infoResponse.ok) {
            const info = await infoResponse.json() as Record<string, unknown>;
            user = { email: typeof info.email === "string" ? info.email : null,
              name: typeof info.name === "string" ? info.name : null,
              verified: typeof info.verified_email === "boolean" ? info.verified_email : null };
          }
        } catch { /* Email is informational; failure does not discard a successful grant. */ }
      }
      if (this.active(sessionId) !== session) return;
      session.result = { refreshToken: json.refresh_token, user };
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
    const result = { status: session.status, ...session.result, error: session.error };
    this.remove(sessionId as string);
    return result;
  }

  cancel(sessionId: unknown) { this.active(sessionId); this.remove(sessionId as string); return { status: "cancelled" }; }

  private clearCredentials(session: Session) { session.clientId = ""; session.clientSecret = ""; session.verifier = ""; }

  private remove(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    clearTimeout(session.timer);
    session.controller.abort();
    session.server.close();
    session.server.closeAllConnections();
    this.clearCredentials(session);
    session.result = undefined;
  }

  shutdown(): void {
    this.stopped = true;
    for (const id of this.sessions.keys()) this.remove(id);
  }
}

export function registerOAuthFlow(ctx: PluginContext): () => void {
  // Use Node fetch directly so host HTTP tracing never captures credentials or tokens.
  const sessions = new OAuthSessions();
  ctx.actions.register("oauth_start_loopback_flow", params => sessions.start(params));
  ctx.actions.register("oauth_poll_loopback_flow", async params => sessions.poll(params.sessionId));
  ctx.actions.register("oauth_submit_callback", async params => {
    await sessions.accept(required(params.sessionId, "sessionId"), required(params.callbackUrl, "callbackUrl"));
    return { status: "received" };
  });
  ctx.actions.register("oauth_cancel_loopback_flow", async params => sessions.cancel(params.sessionId));
  return () => sessions.shutdown();
}
