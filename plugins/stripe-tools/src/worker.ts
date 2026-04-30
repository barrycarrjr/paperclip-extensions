import {
  definePlugin,
  runWorker,
  type PluginContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import {
  type ConfigAccount,
  type InstanceConfig,
  type ResolvedAccount,
  getStripeClient,
  isoToUnix,
  wrapStripeError,
} from "./stripeClient.js";
import { computeMetricsSnapshot } from "./metrics.js";
import { exportChargesCsv } from "./csvExport.js";

type ResolveResult =
  | { ok: true; resolved: ResolvedAccount }
  | { ok: false; error: string };

async function resolveOrError(
  ctx: PluginContext,
  runCtx: ToolRunContext,
  toolName: string,
  accountKey: string | undefined,
): Promise<ResolveResult> {
  try {
    const resolved = await getStripeClient(ctx, runCtx, toolName, accountKey);
    return { ok: true, resolved };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function track(
  ctx: PluginContext,
  runCtx: ToolRunContext,
  tool: string,
  accountKey: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  try {
    await ctx.telemetry.track(`stripe-tools.${tool}`, {
      account: accountKey,
      companyId: runCtx.companyId,
      runId: runCtx.runId,
      ...extra,
    });
  } catch {
    // telemetry failures should never break tool calls
  }
}

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    ctx.logger.info("stripe-tools plugin setup");

    const rawConfig = (await ctx.config.get()) as InstanceConfig;
    const allowMutations = !!rawConfig.allowMutations;
    const accounts: ConfigAccount[] = rawConfig.accounts ?? [];

    if (accounts.length === 0) {
      ctx.logger.warn(
        "stripe-tools: no accounts configured. Add them on /instance/settings/plugins/stripe-tools.",
      );
    } else {
      const summary = accounts
        .map((a) => {
          const k = a.key ?? "(no-key)";
          const mode = a.mode ?? "live";
          const allowed = a.allowedCompanies;
          const access =
            !allowed || allowed.length === 0
              ? "no companies — UNUSABLE"
              : allowed.includes("*")
                ? "portfolio-wide"
                : `${allowed.length} company(s)`;
          return `${k} [${mode}, ${access}]`;
        })
        .join(", ");
      ctx.logger.info(
        `stripe-tools: ready (mutations ${allowMutations ? "ENABLED" : "disabled"}). Accounts — ${summary}`,
      );

      const orphans = accounts.filter(
        (a) => !a.allowedCompanies || a.allowedCompanies.length === 0,
      );
      if (orphans.length > 0) {
        ctx.logger.warn(
          `stripe-tools: ${orphans.length} account(s) have no allowedCompanies and will reject every call. ` +
            `Backfill on the plugin settings page: ${orphans
              .map((a) => a.key ?? "(no-key)")
              .join(", ")}`,
        );
      }
    }

    ctx.tools.register(
      "stripe_search_customers",
      {
        displayName: "Search Stripe customers",
        description:
          "Search Stripe customers using Stripe Search query syntax. Returns up to `limit` customers (max 100).",
        parametersSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            account: { type: "string" },
            limit: { type: "number" },
          },
          required: ["query"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as { query?: string; account?: string; limit?: number };
        if (!p.query) return { error: "[EINVALID_INPUT] `query` is required" };
        const limit = clampLimit(p.limit, 25);

        const r = await resolveOrError(ctx, runCtx, "stripe_search_customers", p.account);
        if (!r.ok) return { error: r.error };
        try {
          const result = await r.resolved.client.customers.search({ query: p.query, limit });
          await track(ctx, runCtx, "stripe_search_customers", r.resolved.accountKey, {
            count: result.data.length,
          });
          return {
            content: `Found ${result.data.length} customer(s) on ${r.resolved.accountKey}.`,
            data: {
              customers: result.data.map(slimCustomer),
              hasMore: result.has_more,
              nextPage: result.next_page ?? null,
            },
          };
        } catch (err) {
          return { error: wrapStripeError(err) };
        }
      },
    );

    ctx.tools.register(
      "stripe_get_customer",
      {
        displayName: "Get Stripe customer",
        description: "Retrieve a Stripe customer by ID, with optional expansions.",
        parametersSchema: {
          type: "object",
          properties: {
            customerId: { type: "string" },
            account: { type: "string" },
            expand: { type: "array", items: { type: "string" } },
          },
          required: ["customerId"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as { customerId?: string; account?: string; expand?: string[] };
        if (!p.customerId) return { error: "[EINVALID_INPUT] `customerId` is required" };

        const r = await resolveOrError(ctx, runCtx, "stripe_get_customer", p.account);
        if (!r.ok) return { error: r.error };
        try {
          const customer = await r.resolved.client.customers.retrieve(p.customerId, {
            expand: p.expand,
          });
          await track(ctx, runCtx, "stripe_get_customer", r.resolved.accountKey);
          return {
            content: `Retrieved customer ${p.customerId}.`,
            data: customer,
          };
        } catch (err) {
          return { error: wrapStripeError(err) };
        }
      },
    );

    ctx.tools.register(
      "stripe_list_subscriptions",
      {
        displayName: "List Stripe subscriptions",
        description: "List subscriptions filtered by customer / status / price / created.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            customerId: { type: "string" },
            status: { type: "string" },
            priceId: { type: "string" },
            createdAfter: { type: "string" },
            limit: { type: "number" },
            startingAfter: { type: "string" },
          },
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as {
          account?: string;
          customerId?: string;
          status?: string;
          priceId?: string;
          createdAfter?: string;
          limit?: number;
          startingAfter?: string;
        };
        const r = await resolveOrError(ctx, runCtx, "stripe_list_subscriptions", p.account);
        if (!r.ok) return { error: r.error };
        try {
          const listParams: Record<string, unknown> = {
            limit: clampLimit(p.limit, 25),
          };
          if (p.customerId) listParams.customer = p.customerId;
          if (p.status) listParams.status = p.status;
          if (p.priceId) listParams.price = p.priceId;
          if (p.startingAfter) listParams.starting_after = p.startingAfter;
          const created = isoToUnix(p.createdAfter);
          if (created !== undefined) listParams.created = { gte: created };

          const result = await r.resolved.client.subscriptions.list(
            listParams as Parameters<typeof r.resolved.client.subscriptions.list>[0],
          );
          await track(ctx, runCtx, "stripe_list_subscriptions", r.resolved.accountKey, {
            count: result.data.length,
          });
          return {
            content: `Listed ${result.data.length} subscription(s).`,
            data: {
              subscriptions: result.data,
              hasMore: result.has_more,
              nextPage: result.data.length > 0 ? result.data[result.data.length - 1].id : null,
            },
          };
        } catch (err) {
          return { error: wrapStripeError(err) };
        }
      },
    );

    ctx.tools.register(
      "stripe_get_subscription",
      {
        displayName: "Get Stripe subscription",
        description: "Retrieve one subscription by ID.",
        parametersSchema: {
          type: "object",
          properties: {
            subscriptionId: { type: "string" },
            account: { type: "string" },
          },
          required: ["subscriptionId"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as { subscriptionId?: string; account?: string };
        if (!p.subscriptionId) return { error: "[EINVALID_INPUT] `subscriptionId` is required" };

        const r = await resolveOrError(ctx, runCtx, "stripe_get_subscription", p.account);
        if (!r.ok) return { error: r.error };
        try {
          const sub = await r.resolved.client.subscriptions.retrieve(p.subscriptionId, {
            expand: ["latest_invoice", "items.data.price"],
          });
          await track(ctx, runCtx, "stripe_get_subscription", r.resolved.accountKey);
          return {
            content: `Retrieved subscription ${p.subscriptionId} (${sub.status}).`,
            data: sub,
          };
        } catch (err) {
          return { error: wrapStripeError(err) };
        }
      },
    );

    ctx.tools.register(
      "stripe_list_charges",
      {
        displayName: "List Stripe charges",
        description: "List charges filtered by customer / status / created window.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            customerId: { type: "string" },
            createdAfter: { type: "string" },
            createdBefore: { type: "string" },
            status: { type: "string" },
            limit: { type: "number" },
            startingAfter: { type: "string" },
          },
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as {
          account?: string;
          customerId?: string;
          createdAfter?: string;
          createdBefore?: string;
          status?: string;
          limit?: number;
          startingAfter?: string;
        };
        const r = await resolveOrError(ctx, runCtx, "stripe_list_charges", p.account);
        if (!r.ok) return { error: r.error };
        try {
          const listParams: Record<string, unknown> = { limit: clampLimit(p.limit, 25) };
          if (p.customerId) listParams.customer = p.customerId;
          if (p.startingAfter) listParams.starting_after = p.startingAfter;
          const after = isoToUnix(p.createdAfter);
          const before = isoToUnix(p.createdBefore);
          if (after !== undefined || before !== undefined) {
            const created: Record<string, number> = {};
            if (after !== undefined) created.gte = after;
            if (before !== undefined) created.lte = before;
            listParams.created = created;
          }
          const result = await r.resolved.client.charges.list(
            listParams as Parameters<typeof r.resolved.client.charges.list>[0],
          );
          const filtered = p.status
            ? result.data.filter((c) => c.status === p.status)
            : result.data;
          await track(ctx, runCtx, "stripe_list_charges", r.resolved.accountKey, {
            count: filtered.length,
          });
          return {
            content: `Listed ${filtered.length} charge(s).`,
            data: {
              charges: filtered,
              hasMore: result.has_more,
              nextPage: filtered.length > 0 ? filtered[filtered.length - 1].id : null,
            },
          };
        } catch (err) {
          return { error: wrapStripeError(err) };
        }
      },
    );

    ctx.tools.register(
      "stripe_get_balance_summary",
      {
        displayName: "Get Stripe balance summary",
        description:
          "Return the account's current available, pending, and reserved balances.",
        parametersSchema: {
          type: "object",
          properties: { account: { type: "string" } },
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as { account?: string };
        const r = await resolveOrError(ctx, runCtx, "stripe_get_balance_summary", p.account);
        if (!r.ok) return { error: r.error };
        try {
          const balance = await r.resolved.client.balance.retrieve();
          await track(ctx, runCtx, "stripe_get_balance_summary", r.resolved.accountKey);
          return {
            content: `Balance retrieved for ${r.resolved.accountKey}.`,
            data: {
              available: balance.available.map((b) => ({ currency: b.currency, amount: b.amount })),
              pending: balance.pending.map((b) => ({ currency: b.currency, amount: b.amount })),
              reserved: balance.connect_reserved?.map((b) => ({
                currency: b.currency,
                amount: b.amount,
              })),
            },
          };
        } catch (err) {
          return { error: wrapStripeError(err) };
        }
      },
    );

    ctx.tools.register(
      "stripe_list_disputes",
      {
        displayName: "List Stripe disputes",
        description: "List disputes (chargebacks). Default status filter: needs_response.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            status: { type: "string" },
            limit: { type: "number" },
          },
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as { account?: string; status?: string; limit?: number };
        const r = await resolveOrError(ctx, runCtx, "stripe_list_disputes", p.account);
        if (!r.ok) return { error: r.error };
        try {
          const limit = clampLimit(p.limit, 25);
          const result = await r.resolved.client.disputes.list({ limit });
          const status = p.status ?? "needs_response";
          const filtered =
            status === "all" ? result.data : result.data.filter((d) => d.status === status);
          await track(ctx, runCtx, "stripe_list_disputes", r.resolved.accountKey, {
            count: filtered.length,
            status,
          });
          return {
            content: `Listed ${filtered.length} dispute(s) (status=${status}).`,
            data: {
              disputes: filtered.map((d) => ({
                id: d.id,
                charge: typeof d.charge === "string" ? d.charge : d.charge.id,
                amount: d.amount,
                currency: d.currency,
                reason: d.reason,
                status: d.status,
                dueBy: d.evidence_details?.due_by
                  ? new Date(d.evidence_details.due_by * 1000).toISOString()
                  : null,
              })),
              hasMore: result.has_more,
            },
          };
        } catch (err) {
          return { error: wrapStripeError(err) };
        }
      },
    );

    ctx.tools.register(
      "stripe_get_metrics_snapshot",
      {
        displayName: "Get Stripe metrics snapshot",
        description:
          "Approximate revenue / growth / churn snapshot. Errors with [ESTRIPE_MIXED_CURRENCY] if active subs span multiple currencies.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            asOfDate: { type: "string" },
          },
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as { account?: string; asOfDate?: string };
        const r = await resolveOrError(ctx, runCtx, "stripe_get_metrics_snapshot", p.account);
        if (!r.ok) return { error: r.error };
        try {
          const snapshot = await computeMetricsSnapshot({
            client: r.resolved.client,
            asOfDate: p.asOfDate,
            companyId: runCtx.companyId,
            accountKey: r.resolved.accountKey,
          });
          await track(ctx, runCtx, "stripe_get_metrics_snapshot", r.resolved.accountKey, {
            mrr: snapshot.mrrCents,
            activeSubs: snapshot.activeSubs,
          });
          return {
            content: `Snapshot (${r.resolved.accountKey} as of ${snapshot.asOfDate}): MRR ${snapshot.mrrCents} ${snapshot.currency}, ${snapshot.activeSubs} active subs.`,
            data: snapshot,
          };
        } catch (err) {
          if (err instanceof Error && err.message.startsWith("[E")) {
            return { error: err.message };
          }
          return { error: wrapStripeError(err) };
        }
      },
    );

    ctx.tools.register(
      "stripe_create_coupon",
      {
        displayName: "Create Stripe coupon",
        description:
          "Create a new Stripe coupon. Gated by allowMutations. Provide either percentOff OR (amountOff + currency).",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            name: { type: "string" },
            duration: { type: "string", enum: ["once", "repeating", "forever"] },
            durationInMonths: { type: "number" },
            percentOff: { type: "number" },
            amountOff: { type: "number" },
            currency: { type: "string" },
            maxRedemptions: { type: "number" },
            metadata: { type: "object", additionalProperties: { type: "string" } },
            idempotencyKey: { type: "string" },
          },
          required: ["name", "duration"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const config = (await ctx.config.get()) as InstanceConfig;
        if (!config.allowMutations) {
          return {
            error:
              "[EDISABLED] Stripe mutations are disabled. Enable allowMutations on the plugin config to use stripe_create_coupon.",
          };
        }

        const p = params as {
          account?: string;
          name?: string;
          duration?: "once" | "repeating" | "forever";
          durationInMonths?: number;
          percentOff?: number;
          amountOff?: number;
          currency?: string;
          maxRedemptions?: number;
          metadata?: Record<string, string>;
          idempotencyKey?: string;
        };
        if (!p.name) return { error: "[EINVALID_INPUT] `name` is required" };
        if (!p.duration) return { error: "[EINVALID_INPUT] `duration` is required" };
        if (p.duration === "repeating" && !p.durationInMonths) {
          return {
            error: "[EINVALID_INPUT] `durationInMonths` is required when duration='repeating'",
          };
        }
        const hasPercent = typeof p.percentOff === "number";
        const hasAmount = typeof p.amountOff === "number";
        if (hasPercent === hasAmount) {
          return {
            error:
              "[EINVALID_INPUT] Provide exactly one of `percentOff` or `amountOff`.",
          };
        }
        if (hasAmount && !p.currency) {
          return { error: "[EINVALID_INPUT] `currency` is required with `amountOff`." };
        }

        const r = await resolveOrError(ctx, runCtx, "stripe_create_coupon", p.account);
        if (!r.ok) return { error: r.error };
        try {
          const couponParams: Record<string, unknown> = {
            name: p.name,
            duration: p.duration,
          };
          if (p.duration === "repeating") couponParams.duration_in_months = p.durationInMonths;
          if (hasPercent) couponParams.percent_off = p.percentOff;
          if (hasAmount) {
            couponParams.amount_off = p.amountOff;
            couponParams.currency = p.currency;
          }
          if (typeof p.maxRedemptions === "number") couponParams.max_redemptions = p.maxRedemptions;
          if (p.metadata) couponParams.metadata = p.metadata;

          const coupon = await r.resolved.client.coupons.create(
            couponParams as Parameters<typeof r.resolved.client.coupons.create>[0],
            p.idempotencyKey ? { idempotencyKey: p.idempotencyKey } : undefined,
          );
          await track(ctx, runCtx, "stripe_create_coupon", r.resolved.accountKey, {
            couponId: coupon.id,
          });
          return {
            content: `Created coupon ${coupon.id}.`,
            data: coupon,
          };
        } catch (err) {
          return { error: wrapStripeError(err) };
        }
      },
    );

    ctx.tools.register(
      "stripe_create_promotion_code",
      {
        displayName: "Create Stripe promotion code",
        description:
          "Create a promotion code wrapping a coupon. Gated by allowMutations. If `code` is omitted, Stripe auto-generates one.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            couponId: { type: "string" },
            code: { type: "string" },
            customerId: { type: "string" },
            maxRedemptions: { type: "number" },
            expiresAt: { type: "string" },
            idempotencyKey: { type: "string" },
          },
          required: ["couponId"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const config = (await ctx.config.get()) as InstanceConfig;
        if (!config.allowMutations) {
          return {
            error:
              "[EDISABLED] Stripe mutations are disabled. Enable allowMutations on the plugin config to use stripe_create_promotion_code.",
          };
        }

        const p = params as {
          account?: string;
          couponId?: string;
          code?: string;
          customerId?: string;
          maxRedemptions?: number;
          expiresAt?: string;
          idempotencyKey?: string;
        };
        if (!p.couponId) return { error: "[EINVALID_INPUT] `couponId` is required" };

        const r = await resolveOrError(ctx, runCtx, "stripe_create_promotion_code", p.account);
        if (!r.ok) return { error: r.error };
        try {
          const expiresUnix = isoToUnix(p.expiresAt);
          const pcParams: Parameters<typeof r.resolved.client.promotionCodes.create>[0] = {
            promotion: { coupon: p.couponId, type: "coupon" },
          };
          if (p.code) pcParams.code = p.code;
          if (p.customerId) pcParams.customer = p.customerId;
          if (typeof p.maxRedemptions === "number") pcParams.max_redemptions = p.maxRedemptions;
          if (expiresUnix !== undefined) pcParams.expires_at = expiresUnix;

          const promo = await r.resolved.client.promotionCodes.create(
            pcParams,
            p.idempotencyKey ? { idempotencyKey: p.idempotencyKey } : undefined,
          );
          await track(ctx, runCtx, "stripe_create_promotion_code", r.resolved.accountKey, {
            promotionCodeId: promo.id,
          });
          return {
            content: `Created promotion code ${promo.code} (${promo.id}).`,
            data: promo,
          };
        } catch (err) {
          return { error: wrapStripeError(err) };
        }
      },
    );

    ctx.tools.register(
      "stripe_export_charges_csv",
      {
        displayName: "Export Stripe charges to CSV",
        description:
          "Stream charges between `from` and `to` into a CSV file. Returns path + row count + summary.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            from: { type: "string" },
            to: { type: "string" },
            columns: { type: "array", items: { type: "string" } },
            outputPath: { type: "string" },
          },
          required: ["from", "to"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as {
          account?: string;
          from?: string;
          to?: string;
          columns?: string[];
          outputPath?: string;
        };
        if (!p.from || !p.to) {
          return { error: "[EINVALID_INPUT] `from` and `to` are required ISO 8601 timestamps." };
        }
        let fromUnix: number | undefined;
        let toUnix: number | undefined;
        try {
          fromUnix = isoToUnix(p.from);
          toUnix = isoToUnix(p.to);
        } catch (err) {
          return { error: (err as Error).message };
        }
        if (fromUnix === undefined || toUnix === undefined || fromUnix > toUnix) {
          return { error: "[EINVALID_INPUT] `from` must be before `to`." };
        }

        const r = await resolveOrError(ctx, runCtx, "stripe_export_charges_csv", p.account);
        if (!r.ok) return { error: r.error };
        try {
          const result = await exportChargesCsv({
            client: r.resolved.client,
            fromUnix,
            toUnix,
            columns: p.columns,
            outputPath: p.outputPath,
            accountKey: r.resolved.accountKey,
            runId: runCtx.runId,
          });
          await track(ctx, runCtx, "stripe_export_charges_csv", r.resolved.accountKey, {
            rows: result.rowCount,
            totalGross: result.summary.totalGross,
          });
          return {
            content: `Exported ${result.rowCount} charge(s) to ${result.path}.`,
            data: result,
          };
        } catch (err) {
          return { error: wrapStripeError(err) };
        }
      },
    );
  },

  async onHealth() {
    return { status: "ok", message: "stripe-tools ready" };
  },
});

function clampLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(100, Math.floor(value)));
}

interface SlimCustomer {
  id: string;
  email: string | null;
  name: string | null;
  created: number;
  metadata: Record<string, string> | null;
}

function slimCustomer(c: import("stripe").Stripe.Customer): SlimCustomer {
  return {
    id: c.id,
    email: c.email ?? null,
    name: c.name ?? null,
    created: c.created,
    metadata: (c.metadata as Record<string, string> | null) ?? null,
  };
}

export default plugin;
runWorker(plugin, import.meta.url);
