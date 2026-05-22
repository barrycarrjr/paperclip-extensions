import type { PluginContext } from "@paperclipai/plugin-sdk";
import { OAuth2Client } from "google-auth-library";
import type { AccountConfig, InstanceConfig } from "./types.js";

export const GBP_SCOPES = [
  "https://www.googleapis.com/auth/business.manage",
];

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
];

interface CachedClient {
  oauth2Client: OAuth2Client;
  clientIdRef: string;
  clientSecretRef: string;
  refreshTokenRef: string;
}

const clientCache = new Map<string, CachedClient>();

function cacheKey(companyId: string, accountKey: string): string {
  return `${companyId}::${accountKey.toLowerCase()}`;
}

export async function getOAuthClient(
  ctx: PluginContext,
  config: InstanceConfig,
  accountKey: string,
  companyId: string,
): Promise<OAuth2Client> {
  const account = (config.accounts ?? []).find(
    (a) => a.key.toLowerCase() === accountKey.toLowerCase(),
  );
  if (!account) {
    throw new Error(
      `[EACCOUNT_NOT_FOUND] GBP account "${accountKey}" is not configured in plugin settings.`,
    );
  }

  const allowed = account.allowedCompanies ?? [];
  if (allowed.length > 0 && !allowed.includes(companyId)) {
    throw new Error(
      `[ECOMPANY_NOT_ALLOWED] GBP account "${accountKey}" is not permitted for company ${companyId}.`,
    );
  }

  if (!account.clientIdRef) throw new Error(`[ECONFIG] Account "${accountKey}": clientIdRef is required.`);
  if (!account.clientSecretRef) throw new Error(`[ECONFIG] Account "${accountKey}": clientSecretRef is required.`);
  if (!account.refreshTokenRef) throw new Error(`[ECONFIG] Account "${accountKey}": refreshTokenRef is required.`);

  const ck = cacheKey(companyId, accountKey);
  const cached = clientCache.get(ck);
  if (
    cached &&
    cached.clientIdRef === account.clientIdRef &&
    cached.clientSecretRef === account.clientSecretRef &&
    cached.refreshTokenRef === account.refreshTokenRef
  ) {
    return cached.oauth2Client;
  }

  const [clientId, clientSecret, refreshToken] = await Promise.all([
    ctx.secrets.resolve(account.clientIdRef),
    ctx.secrets.resolve(account.clientSecretRef),
    ctx.secrets.resolve(account.refreshTokenRef),
  ]).catch((err) => {
    throw new Error(
      `[ECONFIG_SECRET_MISSING] Account "${accountKey}": ${(err as Error).message}. Check secret UUIDs in plugin settings.`,
    );
  });

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(`[ECONFIG] Account "${accountKey}": one or more secrets resolved to empty.`);
  }

  const oauth2Client = new OAuth2Client(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  clientCache.set(ck, {
    oauth2Client,
    clientIdRef: account.clientIdRef,
    clientSecretRef: account.clientSecretRef,
    refreshTokenRef: account.refreshTokenRef,
  });

  return oauth2Client;
}

export async function getAccessToken(oauth2Client: OAuth2Client): Promise<string> {
  const { token } = await oauth2Client.getAccessToken();
  if (!token) throw new Error("[EAUTH] Failed to obtain GBP access token.");
  return token;
}

export function wrapGbpError(err: unknown): string {
  if (err instanceof Error && /^\[E[A-Z_]+\]/.test(err.message)) return err.message;
  if (err instanceof Error) return `[EGBP_UNKNOWN] ${err.message}`;
  return `[EGBP_UNKNOWN] ${String(err)}`;
}

export function findAccount(config: InstanceConfig, key: string): AccountConfig | undefined {
  return (config.accounts ?? []).find((a) => a.key.toLowerCase() === key.toLowerCase());
}
