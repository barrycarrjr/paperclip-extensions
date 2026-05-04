import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { assertCompanyAccess } from "../companyAccess.js";
import { buildScopeFilter } from "../scopeFilter.js";
import type {
  ConfigAccount,
  InstanceConfig,
  ResolvedAccount,
  ScopeFilter,
  ThreeCxEngine,
} from "./types.js";
import { XapiClient } from "./v20Xapi/xapiClient.js";
import { V20XapiEngine } from "./v20Xapi/v20XapiEngine.js";
import { clearAllTokens, clearToken } from "./v20Xapi/tokenStore.js";

/**
 * Cache resolved engines per (companyId, accountKey, tenantId?).
 *
 * - Engines hold cached OAuth tokens — instantiating fresh per tool call
 *   would defeat caching.
 * - Cache key includes companyId so two companies sharing an account in
 *   native mode get distinct engines (different tenantId headers).
 * - Cache key includes the secret-ref UUIDs so credential rotation
 *   transparently invalidates the cache.
 */
interface CacheEntry {
  account: ConfigAccount;
  engine: ThreeCxEngine;
  scope: ScopeFilter;
  clientIdRefAtBind: string;
  clientSecretRefAtBind: string;
  modeAtBind: string;
}

const engineCache = new Map<string, CacheEntry>();

const cacheKey = (companyId: string, accountKey: string): string =>
  `${companyId}::${accountKey.toLowerCase()}`;

/**
 * Drop every cached engine binding. Call from `onConfigChanged` or on
 * shutdown so the next tool call rebuilds against the fresh account list.
 */
export function clearEngineCache(): void {
  engineCache.clear();
  clearAllTokens();
}

export async function getResolvedAccount(
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
      `[EACCOUNT_NOT_FOUND] 3cx-tools account "${requestedKey}" is not configured on the plugin settings page.`,
    );
  }

  assertCompanyAccess(ctx, {
    tool: toolName,
    resourceLabel: `3cx-tools account "${account.key}"`,
    resourceKey: account.key ?? requestedKey,
    allowedCompanies: account.allowedCompanies,
    companyId: runCtx.companyId,
  });

  if ((account.pbxVersion ?? "20") !== "20") {
    throw new Error(
      `[EENGINE_NOT_AVAILABLE] 3CX v18 (Call Control API) engine ships in a future release. Use v20 (XAPI) or upgrade the PBX.`,
    );
  }

  if (!account.clientIdRef || !account.clientSecretRef) {
    throw new Error(
      `[ECONFIG] 3cx-tools account "${account.key}" is missing clientIdRef or clientSecretRef.`,
    );
  }

  // Build scope filter eagerly — this surfaces ECOMPANY_NOT_ROUTED before
  // we resolve secrets or hit the network.
  const scope = buildScopeFilter(account, runCtx.companyId);

  const ck = cacheKey(runCtx.companyId, account.key ?? requestedKey);
  const cached = engineCache.get(ck);
  if (
    cached &&
    cached.clientIdRefAtBind === account.clientIdRef &&
    cached.clientSecretRefAtBind === account.clientSecretRef &&
    cached.modeAtBind === account.mode
  ) {
    return {
      account,
      accountKey: account.key ?? requestedKey,
      scope,
    };
  }

  const [clientId, clientSecret] = await Promise.all([
    ctx.secrets.resolve(account.clientIdRef),
    ctx.secrets.resolve(account.clientSecretRef),
  ]);
  if (!clientId) {
    throw new Error(
      `[ECONFIG] 3cx-tools account "${account.key}": clientIdRef "${account.clientIdRef}" did not resolve.`,
    );
  }
  if (!clientSecret) {
    throw new Error(
      `[ECONFIG] 3cx-tools account "${account.key}": clientSecretRef "${account.clientSecretRef}" did not resolve.`,
    );
  }

  const tenantId = scope.mode === "native" ? scope.tenantId : undefined;

  const client = new XapiClient({
    ctx,
    accountKey: account.key ?? requestedKey,
    pbxBaseUrl: account.pbxBaseUrl,
    clientId,
    clientSecret,
    tenantId,
  });
  const engine: ThreeCxEngine = new V20XapiEngine(client);

  engineCache.set(ck, {
    account,
    engine,
    scope,
    clientIdRefAtBind: account.clientIdRef,
    clientSecretRefAtBind: account.clientSecretRef,
    modeAtBind: account.mode,
  });

  return {
    account,
    accountKey: account.key ?? requestedKey,
    scope,
  };
}

/**
 * Read the engine for an already-resolved (account, company) pair.
 * Always called immediately after `getResolvedAccount` so the cache is
 * guaranteed warm.
 */
export function getEngineFor(
  companyId: string,
  accountKey: string,
): ThreeCxEngine {
  const ck = cacheKey(companyId, accountKey);
  const entry = engineCache.get(ck);
  if (!entry) {
    throw new Error(
      `[EENGINE_NOT_INITIALIZED] No engine cached for company=${companyId} account=${accountKey}. Resolve the account first.`,
    );
  }
  return entry.engine;
}

/**
 * Iterate every (account, allowedCompany) pair so the WebSocket layer can
 * open one connection per (account, tenant?) and fan out events to each
 * matching company.
 */
export async function listAccountsForEvents(
  ctx: PluginContext,
): Promise<ConfigAccount[]> {
  const config = (await ctx.config.get()) as InstanceConfig;
  return (config.accounts ?? []).filter(
    (a) => a.clientIdRef && a.clientSecretRef && a.pbxBaseUrl,
  );
}

export function dropAccount(companyId: string, accountKey: string): void {
  engineCache.delete(cacheKey(companyId, accountKey));
  clearToken(`${accountKey}::*`);
}
