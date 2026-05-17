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
import { createDiyEngine, type DiyEngine } from "./diy/diyEngine.js";

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
  if (engineKind !== "vapi" && engineKind !== "diy") {
    throw new Error(
      `[EENGINE_UNKNOWN] phone-tools engine "${engineKind}" is not recognized. Supported: 'vapi', 'diy'.`,
    );
  }

  if (!account.apiKeyRef && engineKind === "vapi") {
    throw new Error(
      `[ECONFIG] phone-tools account "${account.key}" has no apiKeyRef configured.`,
    );
  }
  if (engineKind === "diy") {
    const missing = listMissingDiyFields(account);
    if (missing.length > 0) {
      throw new Error(
        `[ECONFIG] phone-tools DIY account "${account.key}" is missing required fields: ${missing.join(", ")}. See the Setup tab for the DIY engine walkthrough.`,
      );
    }
  }

  const ck = cacheKey(runCtx.companyId, account.key ?? requestedKey);
  const cached = engineCache.get(ck);
  if (
    cached &&
    cached.apiKeyRefAtBind === (account.apiKeyRef ?? "") &&
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

  let apiKey = "";
  if (engineKind === "vapi") {
    const resolved = await ctx.secrets.resolve(account.apiKeyRef!);
    if (!resolved) {
      throw new Error(
        `[ECONFIG] phone-tools account "${account.key}": secret "${account.apiKeyRef}" did not resolve.`,
      );
    }
    apiKey = resolved;
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

  let engine: PhoneEngine;
  if (engineKind === "vapi") {
    engine = createVapiEngine({
      apiKey,
      webhookSecret,
      engineConfig: account.engineConfig ?? {},
      recordingEnabled: !!account.recordingEnabled,
    });
  } else {
    const jambonzApiKey = await ctx.secrets.resolve(account.jambonzApiKeyRef!);
    if (!jambonzApiKey) {
      throw new Error(
        `[ECONFIG] DIY account "${account.key}": jambonzApiKeyRef "${account.jambonzApiKeyRef}" did not resolve.`,
      );
    }
    const llmApiKey = await ctx.secrets.resolve(account.diyLlmApiKeyRef!);
    if (!llmApiKey) {
      throw new Error(
        `[ECONFIG] DIY account "${account.key}": diyLlmApiKeyRef "${account.diyLlmApiKeyRef}" did not resolve.`,
      );
    }
    engine = createDiyEngine({
      jambonzApiUrl: account.jambonzApiUrl!,
      jambonzApiKey,
      jambonzAccountSid: account.jambonzAccountSid!,
      jambonzApplicationSid: account.jambonzApplicationSid!,
      webhookSecret,
      hostBaseUrl: account.hostBaseUrl!,
      pluginId: "phone-tools",
      accountKey: account.key ?? requestedKey,
      llmProvider: account.diyLlmProvider ?? "anthropic",
      llmApiKey,
      llmModelOverride: account.diyLlmModel,
      ttsVendor: account.diyTtsVendor ?? "google",
      ttsVoice: account.diyTtsVoice ?? "en-US-Wavenet-D",
      ttsLanguage: account.diyTtsLanguage ?? "en-US",
      sttVendor: account.diySttVendor ?? "deepgram",
      sttLanguage: account.diySttLanguage ?? "en-US",
      recordingEnabled: !!account.recordingEnabled,
    });
  }

  engineCache.set(ck, {
    account,
    engine,
    apiKey,
    webhookSecret,
    apiKeyRefAtBind: account.apiKeyRef ?? "",
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

function listMissingDiyFields(account: ConfigAccount): string[] {
  const missing: string[] = [];
  if (!account.jambonzApiUrl) missing.push("jambonzApiUrl");
  if (!account.jambonzApiKeyRef) missing.push("jambonzApiKeyRef");
  if (!account.jambonzAccountSid) missing.push("jambonzAccountSid");
  if (!account.jambonzApplicationSid) missing.push("jambonzApplicationSid");
  if (!account.diyLlmProvider) missing.push("diyLlmProvider");
  if (!account.diyLlmApiKeyRef) missing.push("diyLlmApiKeyRef");
  if (!account.hostBaseUrl) missing.push("hostBaseUrl");
  return missing;
}

/**
 * Resolve the DIY engine for an account by key without requiring a runCtx
 * (Jambonz webhooks don't carry a calling company). Used by the
 * onApiRequest dispatcher for /diy/jambonz/* hooks. Returns the cached
 * engine when available, otherwise instantiates fresh.
 */
export async function getDiyEngineForAccount(
  ctx: PluginContext,
  accountKey: string,
): Promise<{ account: ConfigAccount; engine: DiyEngine } | null> {
  const config = (await ctx.config.get()) as InstanceConfig;
  const account = (config.accounts ?? []).find(
    (a) => (a.key ?? "").toLowerCase() === accountKey.toLowerCase(),
  );
  if (!account) return null;
  if ((account.engine ?? "vapi") !== "diy") return null;
  if (listMissingDiyFields(account).length > 0) return null;

  // Reuse the per-company cache if possible — the engine is per-(company, accountKey)
  // but the underlying Jambonz/LLM clients don't actually depend on companyId,
  // so any entry for this accountKey works for hook dispatch.
  for (const [, entry] of engineCache.entries()) {
    if (entry.account.key === account.key && entry.engine.engineKind === "diy") {
      return { account, engine: entry.engine as DiyEngine };
    }
  }

  // Cold path — instantiate without caching. (Caching would require a
  // companyId, which webhook dispatch doesn't have. The next agent-side
  // tool call for this account will populate the proper cache entry.)
  const [jambonzApiKey, llmApiKey, webhookSecret] = await Promise.all([
    ctx.secrets.resolve(account.jambonzApiKeyRef!),
    ctx.secrets.resolve(account.diyLlmApiKeyRef!),
    account.webhookSecretRef
      ? ctx.secrets.resolve(account.webhookSecretRef)
      : Promise.resolve(null),
  ]);
  if (!jambonzApiKey || !llmApiKey) return null;

  const engine = createDiyEngine({
    jambonzApiUrl: account.jambonzApiUrl!,
    jambonzApiKey,
    jambonzAccountSid: account.jambonzAccountSid!,
    jambonzApplicationSid: account.jambonzApplicationSid!,
    webhookSecret,
    hostBaseUrl: account.hostBaseUrl!,
    pluginId: "phone-tools",
    accountKey: account.key ?? accountKey,
    llmProvider: account.diyLlmProvider ?? "anthropic",
    llmApiKey,
    llmModelOverride: account.diyLlmModel,
    ttsVendor: account.diyTtsVendor ?? "google",
    ttsVoice: account.diyTtsVoice ?? "en-US-Wavenet-D",
    ttsLanguage: account.diyTtsLanguage ?? "en-US",
    sttVendor: account.diySttVendor ?? "deepgram",
    sttLanguage: account.diySttLanguage ?? "en-US",
    recordingEnabled: !!account.recordingEnabled,
  });
  return { account, engine };
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
    if (engineKind === "diy") {
      // DIY webhooks land on apiRoutes (verb-array responses required),
      // not the void-returning onWebhook surface. The /webhooks/diy
      // endpoint is reserved for future status-only events.
      continue;
    }
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
