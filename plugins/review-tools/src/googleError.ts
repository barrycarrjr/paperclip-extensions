/**
 * One place that turns a Google API refusal into a stable code and a
 * sentence that says what to do.
 *
 * Three refusals look alike from the outside (every one is an HTTP 403 or
 * 429 with a long JSON body) and each needs a different person to do a
 * different thing:
 *
 *  - the token was granted without the scope the call needs, so somebody
 *    has to reconnect the Google account (this is what happened on
 *    2026-10-19: a token minted for Calendar was pasted into this plugin);
 *  - the API is not enabled in the Google Cloud project, so somebody has to
 *    enable it in the console;
 *  - the project has no quota for the Business Profile API, which Google
 *    grants only after an access request is approved.
 *
 * Without this, all three were reported as "[EGBP_HTTP_403] Request had
 * insufficient authentication scopes." and the fix was guessed at.
 */

export type GoogleService = "gbp" | "gmail";

const SERVICE_PREFIX: Record<GoogleService, string> = { gbp: "EGBP", gmail: "EGMAIL" };

const RECONNECT = "Reconnect the Google account from the Reviews page (Google connection).";

interface GoogleErrorBody {
  error?: {
    message?: string;
    status?: string;
    details?: Array<{ "@type"?: string; reason?: string; metadata?: Record<string, string> }>;
    errors?: Array<{ reason?: string; message?: string }>;
  };
}

function parseBody(text: string): GoogleErrorBody | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as GoogleErrorBody) : null;
  } catch {
    return null;
  }
}

function reasonOf(body: GoogleErrorBody | null): string {
  const details = body?.error?.details ?? [];
  for (const d of details) if (typeof d.reason === "string") return d.reason;
  const errors = body?.error?.errors ?? [];
  for (const e of errors) if (typeof e.reason === "string") return e.reason;
  return "";
}

function serviceNameOf(body: GoogleErrorBody | null): string {
  const details = body?.error?.details ?? [];
  for (const d of details) {
    const service = d.metadata?.service;
    if (typeof service === "string" && service.length > 0) return service;
  }
  return "";
}

/**
 * The message for a failed Google call: `[CODE] sentence`. The code is what
 * the page and the worker map on; the sentence is what a person reads.
 */
export function describeGoogleApiError(service: GoogleService, status: number, text: string): string {
  const body = parseBody(text);
  const reason = reasonOf(body);
  const message = body?.error?.message ?? text;
  const prefix = SERVICE_PREFIX[service];
  const apiName = service === "gmail" ? "Gmail" : "Business Profile";
  const scopeName = service === "gmail" ? "gmail.readonly" : "business.manage";

  if (reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT" || /insufficient authentication scopes/i.test(message)) {
    return `[EAUTH_SCOPE] The Google token for this account was granted without the ${apiName} permission (${scopeName}). ${RECONNECT}`;
  }

  if (reason === "SERVICE_DISABLED" || /has not been used in project|is disabled/i.test(message)) {
    const which = serviceNameOf(body) || `the ${apiName} API`;
    return `[${prefix}_API_DISABLED] ${which} is not enabled in the Google Cloud project that owns the OAuth client. Enable it under APIs and Services, then try again.`;
  }

  if (status === 429 || reason === "RATE_LIMIT_EXCEEDED" || /quota/i.test(message)) {
    const quotaNote =
      service === "gbp"
        ? " A Business Profile quota of zero means Google has not yet approved API access for this project; a non-zero quota means the daily limit is used up."
        : "";
    return `[${prefix}_QUOTA] Google refused the call over quota: ${message.slice(0, 200)}.${quotaNote}`;
  }

  return `[${prefix}_HTTP_${status}] ${message.slice(0, 300)}`;
}

/**
 * The message for a token refresh that Google refused. google-auth-library
 * throws a bare Error whose message is Google's error code ("invalid_grant")
 * and nothing else, which told nobody what to do.
 */
export function describeTokenRefreshError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/invalid_grant/i.test(message)) {
    return `[EAUTH_INVALID_GRANT] Google no longer accepts this account's refresh token (it was revoked, expired, or belongs to a different OAuth client). ${RECONNECT}`;
  }
  if (/invalid_client|unauthorized_client/i.test(message)) {
    return "[EAUTH_CLIENT] Google does not recognise the OAuth client ID and secret in the plugin settings. Check the two secrets against the Google Cloud console.";
  }
  if (/^\[E[A-Z_0-9]+\]/.test(message)) return message;
  return `[EAUTH] Failed to obtain a Google access token: ${message.slice(0, 200)}`;
}
