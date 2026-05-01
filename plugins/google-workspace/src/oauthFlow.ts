/**
 * Google OAuth 2.0 device flow — bridge actions exposed to the plugin's UI.
 *
 * The device flow lets a user grant OAuth access without the plugin needing a
 * publicly-routable redirect URI. The plugin worker requests a device code
 * from Google, the user visits a verification URL on any device and enters
 * the displayed user code, and the worker polls the token endpoint until
 * either approval or expiry.
 *
 * This is what powers the UI-driven setup flow in /plugins/google-workspace
 * — operators don't need to touch the CLI helper unless they want to.
 *
 * Why these are bridge actions (not agent tools): they're invoked from the
 * plugin's settings/setup UI page running in the operator's browser, not
 * from agent runs. They have no `runContext` and no per-company access
 * control — the operator is in a board context where they can already see
 * any plugin config, and the resulting refresh token is written to a
 * specific company's secret store as the final step.
 *
 * The HTTP calls go through `ctx.fetch` (which requires the `http.outbound`
 * capability) so the worker is the right place — the browser would hit a
 * CORS wall trying to call `oauth2.googleapis.com` directly.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { DEFAULT_SCOPES } from "./googleAuth.js";

const DEVICE_CODE_URL = "https://oauth2.googleapis.com/device/code";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface UserInfo {
  email?: string;
  name?: string;
  picture?: string;
  verified_email?: boolean;
}

function asString(v: unknown, label: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`[EINVALID_INPUT] ${label} is required`);
  }
  return v;
}

function formEncode(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

export function registerOAuthFlow(ctx: PluginContext): void {
  ctx.actions.register("oauth_start_device_flow", async (params) => {
    const clientId = asString(params.clientId, "clientId");
    asString(params.clientSecret, "clientSecret"); // validated, used in poll
    const scopes =
      Array.isArray(params.scopes) && params.scopes.length > 0
        ? params.scopes.map(String)
        : DEFAULT_SCOPES;

    const res = await fetch(DEVICE_CODE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formEncode({ client_id: clientId, scope: scopes.join(" ") }),
    });

    const text = await res.text();
    let json: Partial<DeviceCodeResponse> & { error?: string; error_description?: string };
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`[EGOOGLE_UNKNOWN] device-code endpoint returned non-JSON: ${text.slice(0, 200)}`);
    }

    if (!res.ok || !json.device_code) {
      const code = json.error ? `EGOOGLE_${json.error.toUpperCase()}` : "EGOOGLE_DEVICE_CODE";
      throw new Error(
        `[${code}] ${json.error_description ?? json.error ?? `HTTP ${res.status}`}. ` +
          `Common cause: the OAuth client type is not "TVs and Limited Input devices" (or doesn't have device-flow enabled). ` +
          `Recreate the OAuth client in Google Cloud Console with that type, or use the CLI helper as a fallback.`,
      );
    }

    return {
      deviceCode: json.device_code,
      userCode: json.user_code,
      verificationUrl: json.verification_url,
      interval: json.interval ?? 5,
      expiresIn: json.expires_in ?? 600,
      scopes,
    };
  });

  ctx.actions.register("oauth_poll_device_flow", async (params) => {
    const clientId = asString(params.clientId, "clientId");
    const clientSecret = asString(params.clientSecret, "clientSecret");
    const deviceCode = asString(params.deviceCode, "deviceCode");

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formEncode({
        client_id: clientId,
        client_secret: clientSecret,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    const text = await res.text();
    let json: TokenResponse;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`[EGOOGLE_UNKNOWN] token endpoint returned non-JSON: ${text.slice(0, 200)}`);
    }

    if (json.error === "authorization_pending") {
      return { status: "pending" };
    }
    if (json.error === "slow_down") {
      return { status: "pending", slowDown: true };
    }
    if (json.error === "expired_token") {
      return { status: "expired" };
    }
    if (json.error === "access_denied") {
      return { status: "denied" };
    }
    if (json.error) {
      throw new Error(
        `[EGOOGLE_${json.error.toUpperCase()}] ${json.error_description ?? json.error}`,
      );
    }
    if (!json.refresh_token) {
      throw new Error(
        `[EGOOGLE_NO_REFRESH_TOKEN] Token granted but no refresh_token was returned. The OAuth client may have already issued one for this account — revoke at https://myaccount.google.com/permissions and retry.`,
      );
    }

    return {
      status: "granted",
      refreshToken: json.refresh_token,
      accessToken: json.access_token,
      expiresIn: json.expires_in,
      scope: json.scope,
    };
  });

  ctx.actions.register("oauth_lookup_user", async (params) => {
    const clientId = asString(params.clientId, "clientId");
    const clientSecret = asString(params.clientSecret, "clientSecret");
    const refreshToken = asString(params.refreshToken, "refreshToken");

    // Exchange refresh token for an access token.
    const tokRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formEncode({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    const tokText = await tokRes.text();
    let tokJson: TokenResponse;
    try {
      tokJson = JSON.parse(tokText);
    } catch {
      throw new Error(`[EGOOGLE_UNKNOWN] token-refresh response was not JSON: ${tokText.slice(0, 200)}`);
    }
    if (!tokRes.ok || !tokJson.access_token) {
      const code = tokJson.error ? `EGOOGLE_${tokJson.error.toUpperCase()}` : "EGOOGLE_TOKEN_REFRESH";
      throw new Error(`[${code}] ${tokJson.error_description ?? tokJson.error ?? `HTTP ${tokRes.status}`}`);
    }

    // Fetch userinfo with the access token.
    const userRes = await fetch(USERINFO_URL, {
      headers: { authorization: `Bearer ${tokJson.access_token}` },
    });
    const userText = await userRes.text();
    let userJson: UserInfo;
    try {
      userJson = JSON.parse(userText);
    } catch {
      throw new Error(`[EGOOGLE_UNKNOWN] userinfo response was not JSON: ${userText.slice(0, 200)}`);
    }
    if (!userRes.ok) {
      throw new Error(`[EGOOGLE_USERINFO] HTTP ${userRes.status}: ${userText.slice(0, 200)}`);
    }

    return {
      email: userJson.email ?? null,
      name: userJson.name ?? null,
      verified: userJson.verified_email ?? null,
    };
  });
}
