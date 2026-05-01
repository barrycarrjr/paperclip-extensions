import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { assertCompanyAccess } from "./companyAccess.js";

export type ProviderKind = "replicate" | "openai" | "stability" | "local";

export interface ConfigProvider {
  key?: string;
  displayName?: string;
  kind?: ProviderKind;
  apiKeyRef?: string;
  endpointUrl?: string;
  defaultModel?: string;
  defaultParams?: Record<string, unknown>;
  allowedCompanies?: string[];
}

export interface InstanceConfig {
  allowGeneration?: boolean;
  providers?: ConfigProvider[];
  defaultProvider?: string;
}

export interface ResolvedProvider {
  provider: ConfigProvider;
  providerKey: string;
  apiKey: string | null;
}

interface CachedAuth {
  apiKey: string | null;
  resolvedRef: string | null;
}

const authCache = new Map<string, CachedAuth>();
const cacheKey = (companyId: string, providerKey: string) =>
  `${companyId}::${providerKey.toLowerCase()}`;

export async function getProvider(
  ctx: PluginContext,
  runCtx: ToolRunContext,
  toolName: string,
  providerKeyParam: string | undefined,
): Promise<ResolvedProvider> {
  const config = (await ctx.config.get()) as InstanceConfig;
  const providers = config.providers ?? [];

  const requestedKey = (providerKeyParam ?? config.defaultProvider ?? "").trim();
  if (!requestedKey) {
    throw new Error(
      "[EPROVIDER_REQUIRED] No `provider` parameter provided and no `defaultProvider` configured on the plugin settings page.",
    );
  }

  const provider = providers.find(
    (p) => (p.key ?? "").toLowerCase() === requestedKey.toLowerCase(),
  );
  if (!provider) {
    throw new Error(
      `[EPROVIDER_NOT_FOUND] image-tools provider "${requestedKey}" is not configured on the plugin settings page.`,
    );
  }

  assertCompanyAccess(ctx, {
    tool: toolName,
    resourceLabel: `image-tools provider "${provider.key}"`,
    resourceKey: provider.key ?? requestedKey,
    allowedCompanies: provider.allowedCompanies,
    companyId: runCtx.companyId,
  });

  let apiKey: string | null = null;
  if (provider.apiKeyRef) {
    const ck = cacheKey(runCtx.companyId, provider.key ?? requestedKey);
    const cached = authCache.get(ck);
    if (cached && cached.resolvedRef === provider.apiKeyRef) {
      apiKey = cached.apiKey;
    } else {
      apiKey = (await ctx.secrets.resolve(provider.apiKeyRef)) ?? null;
      if (!apiKey) {
        throw new Error(
          `[ECONFIG] image-tools provider "${provider.key}": secret "${provider.apiKeyRef}" did not resolve.`,
        );
      }
      authCache.set(ck, { apiKey, resolvedRef: provider.apiKeyRef });
    }
  }

  return { provider, providerKey: provider.key ?? requestedKey, apiKey };
}
