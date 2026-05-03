import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { assertCompanyAccess } from "../companyAccess.js";
import type {
  ConfigAccount,
  EngineKind,
  InstanceConfig,
  PhoneEngine,
  ResolvedAccount,
} from "./types.js";
import { createVapiEngine } from "./vapi/vapiEngine.js";

/**
 * Cache resolved engines per (companyId, accountKey). Engines hold cached
 * auth tokens and (for DIY in v0.2) per-call audio relays, so we don't
 * want to instantiate them per tool call. Cache invalidation happens
 * implicitly because cache key includes the secret-ref UUID — if the
 * operator rotates the secret, the apiKeyRef changes and we miss.
 */
interface CacheEntry {
  account: ConfigAccount;
  engine: PhoneEngine;
  apiKey: string;
  webhookSecret: string | null;
  apiKeyRefAtBind: string;
  webhookSecretRefAtBind: string | null;
}

const engineCache = new Map<string, CacheEntry>();
const cacheKey = (companyId: string, accountKey: string): string =>
  `${companyId}::${accountKey.toLowerCase()}`;

/**
 * Drop every cached engine binding. Call from `onConfigChanged` so the
 * next tool call rebuilds against the fresh account list — picks up
 * added/removed accounts, allowedCompanies edits, and engineConfig
 * changes without a worker restart.
 */
export function clearEngineCache(): void {
  engineCache.clear();
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
      `[EACCOUNT_NOT_FOUND] phone-tools account "${requestedKey}" is not configured on the plugin settings page.`,
    );
  }

  assertCompanyAccess(ctx, {
    tool: toolName,
    resourceLabel: `phone-tools account "${account.key}"`,
    resourceKey: account.key ?? requestedKey,
    allowedCompanies: account.allowedCompanies,
    companyId: runCtx.companyId,
  });

  const engineKind: EngineKind = account.engine ?? "vapi";
  if (engineKind === "diy") {
    throw new Error(
      "[EENGINE_NOT_AVAILABLE] DIY engine (jambonz + OpenAI Realtime) ships in v0.2.0. Switch this account to engine='vapi' or wait for the v0.2.0 release.",
    );
  }
  if (engineKind !== "vapi") {
    throw new Error(
      `[EENGINE_UNKNOWN] phone-tools engine "${engineKind}" is not recognized. Supported in v0.1.0: 'vapi'.`,
    );
  }

  if (!account.apiKeyRef) {
    throw new Error(
      `[ECONFIG] phone-tools account "${account.key}" has no apiKeyRef configured.`,
    );
  }

  const ck = cacheKey(runCtx.companyId, account.key ?? requestedKey);
  const cached = engineCache.get(ck);
  if (
    cached &&
    cached.apiKeyRefAtBind === account.apiKeyRef &&
    cached.webhookSecretRefAtBind === (account.webhookSecretRef ?? null)
  ) {
    return {
      account,
      accountKey: account.key ?? requestedKey,
      apiKey: cached.apiKey,
      webhookSecret: cached.webhookSecret,
      engine: cached.engine,
    };
  }

  const apiKey = await ctx.secrets.resolve(account.apiKeyRef);
  if (!apiKey) {
    throw new Error(
      `[ECONFIG] phone-tools account "${account.key}": secret "${account.apiKeyRef}" did not resolve.`,
    );
  }

  let webhookSecret: string | null = null;
  if (account.webhookSecretRef) {
    const resolved = await ctx.secrets.resolve(account.webhookSecretRef);
    if (!resolved) {
      throw new Error(
        `[ECONFIG] phone-tools account "${account.key}": webhook secret "${account.webhookSecretRef}" did not resolve.`,
      );
    }
    webhookSecret = resolved;
  }

  const engine = createVapiEngine({
    apiKey,
    webhookSecret,
    engineConfig: account.engineConfig ?? {},
    recordingEnabled: !!account.recordingEnabled,
  });

  engineCache.set(ck, {
    account,
    engine,
    apiKey,
    webhookSecret,
    apiKeyRefAtBind: account.apiKeyRef,
    webhookSecretRefAtBind: account.webhookSecretRef ?? null,
  });

  return {
    account,
    accountKey: account.key ?? requestedKey,
    apiKey,
    webhookSecret,
    engine,
  };
}

/**
 * Webhook dispatcher needs to find the right engine without a runCtx
 * (no calling agent / company at webhook time — the inbound call defines
 * the context). We iterate accounts, instantiate each engine on the fly
 * (no per-company cache here — webhooks are infrequent enough), and let
 * the first engine whose signature verification passes claim the event.
 *
 * Returns the resolved account if exactly one engine claims the webhook,
 * otherwise null. The caller emits `plugin.phone-tools.call.<kind>` with
 * `companyId = account.allowedCompanies[0]` if the account is single-company,
 * or fans out to all allowed companies otherwise.
 */
export async function getEnginesForEndpoint(
  ctx: PluginContext,
  endpointKey: string,
): Promise<Array<{ accountKey: string; account: ConfigAccount; engine: PhoneEngine }>> {
  const config = (await ctx.config.get()) as InstanceConfig;
  const accounts = config.accounts ?? [];
  const out: Array<{
    accountKey: string;
    account: ConfigAccount;
    engine: PhoneEngine;
  }> = [];

  for (const account of accounts) {
    const engineKind: EngineKind = account.engine ?? "vapi";
    if (engineKind !== endpointKey) continue;
    if (engineKind === "diy") continue; // not yet shipped
    if (!account.apiKeyRef) continue;

    let apiKey: string;
    try {
      apiKey = (await ctx.secrets.resolve(account.apiKeyRef)) ?? "";
      if (!apiKey) continue;
    } catch {
      continue;
    }

    let webhookSecret: string | null = null;
    if (account.webhookSecretRef) {
      try {
        webhookSecret = (await ctx.secrets.resolve(account.webhookSecretRef)) ?? null;
      } catch {
        webhookSecret = null;
      }
    }

    const engine = createVapiEngine({
      apiKey,
      webhookSecret,
      engineConfig: account.engineConfig ?? {},
      recordingEnabled: !!account.recordingEnabled,
    });

    out.push({ accountKey: account.key ?? "(no-key)", account, engine });
  }

  return out;
}
