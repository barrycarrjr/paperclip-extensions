import Stripe from "stripe";
import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { assertCompanyAccess } from "./companyAccess.js";

export interface ConfigAccount {
  name?: string;
  key?: string;
  mode?: "live" | "test";
  secretKeyRef?: string;
  apiVersion?: string;
  allowedCompanies?: string[];
}

export interface InstanceConfig {
  allowMutations?: boolean;
  accounts?: ConfigAccount[];
  defaultAccount?: string;
}

export interface ResolvedAccount {
  account: ConfigAccount;
  accountKey: string;
  client: Stripe;
}

interface CachedClient {
  client: Stripe;
  resolvedSecretRef: string;
}

const clientCache = new Map<string, CachedClient>();
const cacheKey = (companyId: string, accountKey: string) =>
  `${companyId}::${accountKey.toLowerCase()}`;

export async function getStripeClient(
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
      `[EACCOUNT_NOT_FOUND] Stripe account "${requestedKey}" is not configured on the plugin settings page.`,
    );
  }

  assertCompanyAccess(ctx, {
    tool: toolName,
    resourceLabel: `stripe-tools account "${account.key}"`,
    resourceKey: account.key ?? requestedKey,
    allowedCompanies: account.allowedCompanies,
    companyId: runCtx.companyId,
  });

  if (!account.secretKeyRef) {
    throw new Error(
      `[ECONFIG] Stripe account "${account.key}" has no secretKeyRef configured.`,
    );
  }

  const ck = cacheKey(runCtx.companyId, account.key ?? requestedKey);
  const cached = clientCache.get(ck);
  if (cached && cached.resolvedSecretRef === account.secretKeyRef) {
    return { account, accountKey: account.key ?? requestedKey, client: cached.client };
  }

  const apiKey = await ctx.secrets.resolve(account.secretKeyRef);
  if (!apiKey) {
    throw new Error(
      `[ECONFIG] Stripe account "${account.key}": secret "${account.secretKeyRef}" did not resolve.`,
    );
  }

  type StripeConfigArg = NonNullable<ConstructorParameters<typeof Stripe>[1]>;
  const stripeConfig: StripeConfigArg = {
    appInfo: { name: "paperclip-plugin-stripe-tools" },
  };
  if (account.apiVersion) {
    stripeConfig.apiVersion = account.apiVersion as StripeConfigArg["apiVersion"];
  }

  const client = new Stripe(apiKey, stripeConfig);
  clientCache.set(ck, { client, resolvedSecretRef: account.secretKeyRef });
  return { account, accountKey: account.key ?? requestedKey, client };
}

export function wrapStripeError(err: unknown): string {
  if (err instanceof Stripe.errors.StripeAuthenticationError) {
    return `[ESTRIPE_AUTH] ${err.message}`;
  }
  if (err instanceof Stripe.errors.StripePermissionError) {
    return `[ESTRIPE_PERM] ${err.message}`;
  }
  if (err instanceof Stripe.errors.StripeRateLimitError) {
    return `[ESTRIPE_RATE_LIMIT] ${err.message}`;
  }
  if (err instanceof Stripe.errors.StripeInvalidRequestError) {
    return `[ESTRIPE_INVALID_REQUEST] ${err.message}`;
  }
  if (err instanceof Stripe.errors.StripeIdempotencyError) {
    return `[ESTRIPE_IDEMPOTENCY] ${err.message}`;
  }
  if (err instanceof Stripe.errors.StripeConnectionError) {
    return `[ESTRIPE_CONNECTION] ${err.message}`;
  }
  if (err instanceof Stripe.errors.StripeAPIError) {
    return `[ESTRIPE_API] ${err.message}`;
  }
  if (err instanceof Stripe.errors.StripeError) {
    return `[ESTRIPE_UNKNOWN] ${err.message}`;
  }
  if (err instanceof Error) return `[ESTRIPE_UNKNOWN] ${err.message}`;
  return `[ESTRIPE_UNKNOWN] ${String(err)}`;
}

export function isoToUnix(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new Error(`[EINVALID_INPUT] Invalid ISO 8601 timestamp: "${iso}"`);
  }
  return Math.floor(ms / 1000);
}
