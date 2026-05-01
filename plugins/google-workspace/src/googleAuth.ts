import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { OAuth2Client } from "google-auth-library";
import { assertCompanyAccess } from "./companyAccess.js";

export interface ConfigAccount {
  key?: string;
  displayName?: string;
  userEmail?: string;
  clientIdRef?: string;
  clientSecretRef?: string;
  refreshTokenRef?: string;
  scopes?: string[];
  allowedCompanies?: string[];
}

export interface InstanceConfig {
  accounts?: ConfigAccount[];
  defaultAccount?: string;
  allowMutations?: boolean;
}

export interface ResolvedAccount {
  account: ConfigAccount;
  accountKey: string;
  oauth2Client: OAuth2Client;
  scopes: string[];
}

interface CachedClient {
  oauth2Client: OAuth2Client;
  resolvedClientIdRef: string;
  resolvedClientSecretRef: string;
  resolvedRefreshTokenRef: string;
  scopes: string[];
}

export const DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/tasks",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

const clientCache = new Map<string, CachedClient>();
const cacheKey = (companyId: string, accountKey: string) =>
  `${companyId}::${accountKey.toLowerCase()}`;

export async function getGoogleAccount(
  ctx: PluginContext,
  runCtx: ToolRunContext,
  toolName: string,
  accountKeyParam: string | undefined,
): Promise<ResolvedAccount> {
  const config = (await ctx.config.get()) as InstanceConfig;
  const accounts = config.accounts ?? [];

  const requestedKey = (accountKeyParam ?? config.defaultAccount ?? "").trim();
  if (!requestedKey) {
    throw new Error(
      "[EACCOUNT_REQUIRED] No `account` parameter provided and no `defaultAccount` configured on the plugin settings page.",
    );
  }

  const account = accounts.find(
    (a) => (a.key ?? "").toLowerCase() === requestedKey.toLowerCase(),
  );
  if (!account) {
    throw new Error(
      `[EACCOUNT_NOT_FOUND] Google account "${requestedKey}" is not configured on the plugin settings page.`,
    );
  }

  assertCompanyAccess(ctx, {
    tool: toolName,
    resourceLabel: `google-workspace account "${account.key}"`,
    resourceKey: account.key ?? requestedKey,
    allowedCompanies: account.allowedCompanies,
    companyId: runCtx.companyId,
  });

  if (!account.clientIdRef) {
    throw new Error(`[ECONFIG] Google account "${account.key}" has no clientIdRef configured.`);
  }
  if (!account.clientSecretRef) {
    throw new Error(`[ECONFIG] Google account "${account.key}" has no clientSecretRef configured.`);
  }
  if (!account.refreshTokenRef) {
    throw new Error(`[ECONFIG] Google account "${account.key}" has no refreshTokenRef configured.`);
  }

  const scopes = account.scopes && account.scopes.length > 0 ? account.scopes : DEFAULT_SCOPES;
  const ck = cacheKey(runCtx.companyId, account.key ?? requestedKey);
  const cached = clientCache.get(ck);
  if (
    cached &&
    cached.resolvedClientIdRef === account.clientIdRef &&
    cached.resolvedClientSecretRef === account.clientSecretRef &&
    cached.resolvedRefreshTokenRef === account.refreshTokenRef
  ) {
    return {
      account,
      accountKey: account.key ?? requestedKey,
      oauth2Client: cached.oauth2Client,
      scopes: cached.scopes,
    };
  }

  let clientId: string | undefined;
  let clientSecret: string | undefined;
  let refreshToken: string | undefined;
  try {
    [clientId, clientSecret, refreshToken] = await Promise.all([
      ctx.secrets.resolve(account.clientIdRef),
      ctx.secrets.resolve(account.clientSecretRef),
      ctx.secrets.resolve(account.refreshTokenRef),
    ]);
  } catch (err) {
    throw new Error(
      `[ECONFIG_SECRET_MISSING] Google account "${account.key}": ${(err as Error).message}. Verify the secret UUIDs on the plugin settings page point at existing secrets in the company's Secrets page.`,
    );
  }

  if (!clientId) {
    throw new Error(
      `[ECONFIG] Google account "${account.key}": clientIdRef "${account.clientIdRef}" did not resolve.`,
    );
  }
  if (!clientSecret) {
    throw new Error(
      `[ECONFIG] Google account "${account.key}": clientSecretRef "${account.clientSecretRef}" did not resolve.`,
    );
  }
  if (!refreshToken) {
    throw new Error(
      `[ECONFIG] Google account "${account.key}": refreshTokenRef "${account.refreshTokenRef}" did not resolve.`,
    );
  }

  const oauth2Client = new OAuth2Client(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  clientCache.set(ck, {
    oauth2Client,
    resolvedClientIdRef: account.clientIdRef,
    resolvedClientSecretRef: account.clientSecretRef,
    resolvedRefreshTokenRef: account.refreshTokenRef,
    scopes,
  });

  return {
    account,
    accountKey: account.key ?? requestedKey,
    oauth2Client,
    scopes,
  };
}

export function wrapGoogleError(err: unknown): string {
  // Pass through errors already tagged by this plugin (e.g. [ECOMPANY_NOT_ALLOWED],
  // [EMUTATIONS_DISABLED], [ECONFIG], [EINVALID_INPUT]) so we don't double-wrap.
  if (err instanceof Error && /^\[E[A-Z_]+\]/.test(err.message)) {
    return err.message;
  }
  if (err && typeof err === "object" && "response" in err) {
    const e = err as {
      response?: { data?: { error?: string; error_description?: string } };
      message?: string;
      code?: number | string;
    };
    const data = e.response?.data;
    if (data?.error === "invalid_grant") {
      return `[EGOOGLE_INVALID_GRANT] ${data.error_description ?? "Refresh token rejected. Re-run scripts/grant-google-access.ts and update the refreshTokenRef secret."}`;
    }
    if (data?.error) {
      return `[EGOOGLE_${String(data.error).toUpperCase()}] ${data.error_description ?? e.message ?? "Unknown error"}`;
    }
    if (e.code === 403 || e.code === "403") {
      return `[EGOOGLE_FORBIDDEN] ${e.message ?? "Forbidden"}`;
    }
    if (e.code === 404 || e.code === "404") {
      return `[EGOOGLE_NOT_FOUND] ${e.message ?? "Not found"}`;
    }
    if (e.code === 429 || e.code === "429") {
      return `[EGOOGLE_RATE_LIMIT] ${e.message ?? "Rate limited"}`;
    }
  }
  if (err instanceof Error) return `[EGOOGLE_UNKNOWN] ${err.message}`;
  return `[EGOOGLE_UNKNOWN] ${String(err)}`;
}

export type ResolveResult =
  | { ok: true; resolved: ResolvedAccount }
  | { ok: false; error: string };

export async function resolveOrError(
  ctx: PluginContext,
  runCtx: ToolRunContext,
  toolName: string,
  accountKeyParam: string | undefined,
): Promise<ResolveResult> {
  try {
    const resolved = await getGoogleAccount(ctx, runCtx, toolName, accountKeyParam);
    return { ok: true, resolved };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function ensureMutationsAllowed(
  ctx: PluginContext,
  config: InstanceConfig,
  toolName: string,
): void {
  if (!config.allowMutations) {
    throw new Error(
      `[EMUTATIONS_DISABLED] ${toolName} is a mutation tool. Set "Allow create/update/delete tools" to true on the google-workspace plugin settings page.`,
    );
  }
}
