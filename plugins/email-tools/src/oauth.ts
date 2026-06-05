import { randomBytes, createHash } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";

/**
 * OAuth2 (XOAUTH2) support for Microsoft Outlook / Office 365 mailboxes.
 *
 * Microsoft disabled Basic Authentication (app passwords) for IMAP/POP/SMTP on
 * personal Outlook/Hotmail accounts (Sept 2024) and Exchange Online; modern auth
 * (OAuth2) is now the only supported method. This module implements the
 * authorization-code-with-PKCE flow so a mailbox can be connected by signing in
 * with Microsoft once — no app password, no client secret.
 *
 * Tokens:
 *  - A long-lived **refresh token** is stored in plugin state (keyed by mailbox).
 *  - Short-lived **access tokens** are minted on demand from the refresh token
 *    and used as the XOAUTH2 bearer for IMAP (imapflow) and SMTP (nodemailer).
 *
 * Security note: the refresh token is stored in plugin state (local DB), not the
 * encrypted secret vault, because the plugin SDK secrets client is read-only.
 * On a local single-user instance this is an acceptable tradeoff; PKCE means
 * there is no client secret to store at all.
 */

const STATE_NS = "oauth";
const PENDING_PREFIX = "pending:"; // pending auth flows, keyed by `state`
const TOKEN_PREFIX = "token:"; // stored refresh tokens, keyed by mailbox key
const PENDING_TTL_MS = 10 * 60 * 1000; // auth flow must complete within 10 min

export type OAuthProvider = "microsoft";

interface ProviderEndpoints {
  authorize: string;
  token: string;
  scopes: string[];
}

// /common supports both org (postcardeddm.com) and personal (hotmail.com) accounts.
const PROVIDERS: Record<OAuthProvider, ProviderEndpoints> = {
  microsoft: {
    authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: [
      "https://outlook.office.com/IMAP.AccessAsUser.All",
      "https://outlook.office.com/SMTP.Send",
      "offline_access",
      "openid",
      "email",
    ],
  },
};

interface PendingAuth {
  codeVerifier: string;
  mailboxKey: string;
  provider: OAuthProvider;
  createdAtMs: number;
}

interface StoredToken {
  provider: OAuthProvider;
  refreshToken: string;
  // Cached access token + expiry to avoid refreshing on every connection.
  accessToken?: string;
  accessTokenExpMs?: number;
  updatedAtMs: number;
}

// ── PKCE helpers ────────────────────────────────────────────────────────────

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeCodeVerifier(): string {
  return base64url(randomBytes(48)); // 64 chars, within the 43–128 RFC range
}

function codeChallengeFor(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

function makeState(): string {
  return base64url(randomBytes(24));
}

// ── state storage ───────────────────────────────────────────────────────────

function pendingKey(state: string) {
  return { scopeKind: "instance" as const, namespace: STATE_NS, stateKey: PENDING_PREFIX + state };
}
function tokenKey(mailboxKey: string) {
  return { scopeKind: "instance" as const, namespace: STATE_NS, stateKey: TOKEN_PREFIX + mailboxKey.toLowerCase() };
}

export async function hasOAuthToken(ctx: PluginContext, mailboxKey: string): Promise<boolean> {
  const t = (await ctx.state.get(tokenKey(mailboxKey))) as StoredToken | undefined;
  return !!t?.refreshToken;
}

export async function clearOAuthToken(ctx: PluginContext, mailboxKey: string): Promise<void> {
  await ctx.state.delete(tokenKey(mailboxKey));
}

// ── authorization flow ──────────────────────────────────────────────────────

/**
 * Begin an OAuth sign-in. Persists a pending flow (PKCE verifier + target
 * mailbox) and returns the Microsoft authorize URL to redirect the operator to.
 */
export async function startAuth(
  ctx: PluginContext,
  opts: { clientId: string; redirectUri: string; mailboxKey: string; provider?: OAuthProvider; loginHint?: string },
): Promise<string> {
  const provider = opts.provider ?? "microsoft";
  const ep = PROVIDERS[provider];
  const codeVerifier = makeCodeVerifier();
  const state = makeState();

  const pending: PendingAuth = {
    codeVerifier,
    mailboxKey: opts.mailboxKey,
    provider,
    createdAtMs: nowMs(),
  };
  await ctx.state.set(pendingKey(state), pending);

  const params = new URLSearchParams({
    client_id: opts.clientId,
    response_type: "code",
    redirect_uri: opts.redirectUri,
    response_mode: "query",
    scope: ep.scopes.join(" "),
    state,
    code_challenge: codeChallengeFor(codeVerifier),
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  if (opts.loginHint) params.set("login_hint", opts.loginHint);
  return `${ep.authorize}?${params.toString()}`;
}

/**
 * Handle the redirect back from Microsoft: exchange the auth code for tokens
 * (using the stored PKCE verifier) and persist the refresh token for the mailbox.
 * Returns the mailbox key the tokens were stored for.
 */
export async function handleCallback(
  ctx: PluginContext,
  opts: { clientId: string; redirectUri: string; code: string; state: string },
): Promise<{ mailboxKey: string }> {
  const pending = (await ctx.state.get(pendingKey(opts.state))) as PendingAuth | undefined;
  if (!pending) throw new Error("OAuth state not recognized or expired. Restart the sign-in.");
  await ctx.state.delete(pendingKey(opts.state));
  if (nowMs() - pending.createdAtMs > PENDING_TTL_MS) {
    throw new Error("OAuth sign-in timed out. Restart the sign-in.");
  }

  const ep = PROVIDERS[pending.provider];
  const body = new URLSearchParams({
    client_id: opts.clientId,
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: pending.codeVerifier,
    scope: ep.scopes.join(" "),
  });
  const tok = await postToken(ep.token, body);
  if (!tok.refresh_token) {
    throw new Error("Microsoft did not return a refresh token (offline_access scope may be missing).");
  }
  const stored: StoredToken = {
    provider: pending.provider,
    refreshToken: tok.refresh_token,
    accessToken: tok.access_token,
    accessTokenExpMs: tok.expires_in ? nowMs() + (tok.expires_in - 60) * 1000 : undefined,
    updatedAtMs: nowMs(),
  };
  await ctx.state.set(tokenKey(pending.mailboxKey), stored);
  return { mailboxKey: pending.mailboxKey };
}

/**
 * Return a valid access token for a mailbox, refreshing from the stored refresh
 * token when the cached access token is missing or near expiry. Throws if the
 * mailbox has never been connected.
 */
export async function getAccessToken(
  ctx: PluginContext,
  opts: { clientId: string; mailboxKey: string },
): Promise<string> {
  const stored = (await ctx.state.get(tokenKey(opts.mailboxKey))) as StoredToken | undefined;
  if (!stored?.refreshToken) {
    throw new Error(`Mailbox "${opts.mailboxKey}" is not connected via OAuth. Click "Connect with Microsoft".`);
  }
  if (stored.accessToken && stored.accessTokenExpMs && stored.accessTokenExpMs > nowMs()) {
    return stored.accessToken;
  }
  const ep = PROVIDERS[stored.provider];
  const body = new URLSearchParams({
    client_id: opts.clientId,
    grant_type: "refresh_token",
    refresh_token: stored.refreshToken,
    scope: ep.scopes.join(" "),
  });
  const tok = await postToken(ep.token, body);
  const next: StoredToken = {
    provider: stored.provider,
    // Microsoft rotates refresh tokens; keep the newest, fall back to the prior one.
    refreshToken: tok.refresh_token ?? stored.refreshToken,
    accessToken: tok.access_token,
    accessTokenExpMs: tok.expires_in ? nowMs() + (tok.expires_in - 60) * 1000 : undefined,
    updatedAtMs: nowMs(),
  };
  await ctx.state.set(tokenKey(opts.mailboxKey), next);
  if (!tok.access_token) throw new Error("Token refresh did not return an access token.");
  return tok.access_token;
}

// ── low-level ───────────────────────────────────────────────────────────────

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
}

async function postToken(url: string, body: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || json.error) {
    throw new Error(`OAuth token request failed (${res.status}): ${json.error ?? ""} ${json.error_description ?? ""}`.trim());
  }
  return json;
}

function nowMs(): number {
  return Date.now();
}
