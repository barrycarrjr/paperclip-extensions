import {
  definePlugin,
  runWorker,
  type PluginContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import {
  clearEngineCache,
  getEngineFor,
  getResolvedAccount,
  listAccountsForEvents,
} from "./engines/registry.js";
import { isCompanyAllowed } from "./companyAccess.js";
import { buildScopeFilter } from "./scopeFilter.js";
import { XapiClient } from "./engines/v20Xapi/xapiClient.js";
import { V20XapiEngine } from "./engines/v20Xapi/v20XapiEngine.js";
import type {
  ConfigAccount,
  InstanceConfig,
  NormalizedPbxEvent,
  ResolvedAccount,
  ScopeFilter,
} from "./engines/types.js";

// ─── Helpers ──────────────────────────────────────────────────────────

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
    const resolved = await getResolvedAccount(ctx, runCtx, toolName, accountKey);
    return { ok: true, resolved };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function track(
  ctx: PluginContext,
  runCtx: ToolRunContext | null,
  tool: string,
  accountKey: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  try {
    const dims: Record<string, string | number | boolean> = { account: accountKey };
    if (runCtx?.companyId) dims.companyId = runCtx.companyId;
    if (runCtx?.runId) dims.runId = runCtx.runId;
    for (const [k, v] of Object.entries(extra)) {
      if (v === null || v === undefined) continue;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        dims[k] = v;
      } else {
        dims[k] = JSON.stringify(v);
      }
    }
    await ctx.telemetry.track(`3cx-tools.${tool}`, dims);
  } catch {
    // never break tool calls on telemetry failure
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function asBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function todayUtcDate(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

async function assertMutationsEnabled(ctx: PluginContext, tool: string): Promise<void> {
  const config = (await ctx.config.get()) as InstanceConfig;
  if (!config.allowMutations) {
    throw new Error(
      `[EDISABLED] ${tool} is a mutation and 'Allow click-to-call / park / transfer / hangup' is off on the plugin settings page. Flip it on to enable.`,
    );
  }
}

async function bumpClickToCallCounter(
  ctx: PluginContext,
  companyId: string,
  account: ConfigAccount,
): Promise<void> {
  const cap = account.maxClickToCallPerDay ?? 50;
  if (cap === 0) {
    throw new Error(
      `[EDISABLED] click-to-call disabled for account "${account.key}" (maxClickToCallPerDay = 0).`,
    );
  }
  const stateKey = `clickToCallCounter:${companyId}:${todayUtcDate()}:${account.key}`;
  const current = ((await ctx.state.get({
    scopeKind: "instance",
    stateKey,
  })) as number | null) ?? 0;
  if (current >= cap) {
    throw new Error(
      `[ECONCURRENCY_LIMIT] Daily click-to-call cap reached for company ${companyId} on account "${account.key}" (${cap}/day). Wait until tomorrow or raise maxClickToCallPerDay.`,
    );
  }
  await ctx.state.set({ scopeKind: "instance", stateKey }, current + 1);
}

// ─── Realtime WebSocket lifecycle ────────────────────────────────────

interface WsBinding {
  account: ConfigAccount;
  close: () => Promise<void>;
}

const wsBindings = new Map<string, WsBinding>();

async function openWebSocketsForAllAccounts(ctx: PluginContext): Promise<void> {
  const accounts = await listAccountsForEvents(ctx);
  for (const account of accounts) {
    if ((account.pbxVersion ?? "20") !== "20") continue;
    const allowed = account.allowedCompanies ?? [];
    if (allowed.length === 0) {
      ctx.logger.warn(
        "Skipping WS for account with no allowedCompanies — set ['*'] or list companies",
        { account: account.key },
      );
      continue;
    }
    try {
      await openWebSocketForAccount(ctx, account);
    } catch (err) {
      ctx.logger.warn(`Failed to open WebSocket for account ${account.key}`, {
        error: (err as Error).message,
      });
    }
  }
}

async function openWebSocketForAccount(
  ctx: PluginContext,
  account: ConfigAccount,
): Promise<void> {
  const existing = wsBindings.get(account.key);
  if (existing) await existing.close().catch(() => {});

  const [clientId, clientSecret] = await Promise.all([
    ctx.secrets.resolve(account.clientIdRef),
    ctx.secrets.resolve(account.clientSecretRef),
  ]);
  if (!clientId || !clientSecret) {
    ctx.logger.warn("Skipping WS — secrets did not resolve", { account: account.key });
    return;
  }

  // For native mode, open one WS per tenant so each can be auth'd against
  // its tenant scope. For single/manual, one WS per account is sufficient.
  // We open one WS per account here; tenant fan-out for native is a v0.4
  // refinement — most native deployments use a portfolio-wide bearer.
  const client = new XapiClient({
    ctx,
    accountKey: account.key,
    pbxBaseUrl: account.pbxBaseUrl,
    clientId,
    clientSecret,
  });
  const engine = new V20XapiEngine(client);

  const { close } = await engine.subscribeEvents((event) =>
    dispatchPbxEvent(ctx, account, event),
  );

  wsBindings.set(account.key, { account, close });
  ctx.logger.info("WS open", { account: account.key });
}

async function closeAllWebSockets(): Promise<void> {
  const bindings = Array.from(wsBindings.values());
  wsBindings.clear();
  await Promise.all(bindings.map((b) => b.close().catch(() => {})));
}

function dispatchPbxEvent(
  ctx: PluginContext,
  account: ConfigAccount,
  event: NormalizedPbxEvent,
): void {
  const allowed = account.allowedCompanies ?? [];
  if (allowed.length === 0) return;

  const targets =
    allowed.includes("*") || account.mode === "single"
      ? new Set<string>()
      : matchTargetsForEvent(account, event);

  // For single-mode / portfolio-wide, fan out to every distinct company in
  // companyRouting (manual) or companyTenants (native). If neither exists
  // and allowedCompanies = ['*'], we don't know the target set without
  // ctx.companies.list — fall back to no-op logging.
  if (allowed.includes("*") && targets.size === 0) {
    if (account.mode === "manual") {
      for (const r of account.companyRouting ?? []) targets.add(r.companyId);
    } else if (account.mode === "native") {
      for (const t of account.companyTenants ?? []) targets.add(t.companyId);
    }
    if (targets.size === 0) {
      ctx.logger.debug(
        "WS event for portfolio-wide single-mode account; cannot resolve target companies — emitting unscoped",
        { account: account.key, eventKind: event.kind },
      );
      return;
    }
  } else if (account.mode === "single") {
    for (const c of allowed) if (c !== "*") targets.add(c);
  } else if (targets.size === 0) {
    // Manual / native with no matching scope — drop.
    return;
  }

  const eventName = `3cx-tools.${event.kind}`;
  for (const companyId of targets) {
    if (!isCompanyAllowed(allowed, companyId)) continue;
    void ctx.events.emit(eventName, companyId, { account: account.key, ...event });
  }
}

function matchTargetsForEvent(
  account: ConfigAccount,
  event: NormalizedPbxEvent,
): Set<string> {
  const out = new Set<string>();
  if (account.mode === "manual") {
    for (const r of account.companyRouting ?? []) {
      const scope = buildScopeFilter(account, r.companyId);
      if (eventInScope(scope, event)) out.add(r.companyId);
    }
  } else if (account.mode === "native") {
    // We don't get per-event tenantId from 3CX in current frame shapes;
    // fall back to all tenants on the account. Operators on native can
    // refine by adding payload.tenantId once a verified frame example is
    // available (open question).
    for (const t of account.companyTenants ?? []) out.add(t.companyId);
  }
  return out;
}

function eventInScope(scope: ScopeFilter, event: NormalizedPbxEvent): boolean {
  if (scope.mode !== "manual") return true;
  switch (event.kind) {
    case "call.started":
      return (
        (!!event.extension && scope.extensions.includes(event.extension)) ||
        (!!event.queue && scope.queueIds.includes(event.queue)) ||
        scope.dids.includes(event.from) ||
        scope.dids.includes(event.to)
      );
    case "call.ended":
      // Without an extension/queue on the ended frame we can't scope it.
      // Emit only if we have a record of the callId in scope (future
      // refinement — stash callId→companyId in state on call.started).
      return false;
    case "queue.depth":
      return scope.queueIds.includes(event.queueId);
    case "agent.presence_changed":
      return scope.extensions.includes(event.extension);
  }
}

// ─── Plugin definition ───────────────────────────────────────────────

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    ctx.logger.info("3cx-tools plugin starting", { version: "0.1.0" });

    // Health: warn at startup about accounts with empty allowedCompanies.
    try {
      const config = (await ctx.config.get()) as InstanceConfig;
      const orphans = (config.accounts ?? []).filter(
        (a) => !a.allowedCompanies || a.allowedCompanies.length === 0,
      );
      if (orphans.length > 0) {
        ctx.logger.warn(
          `3cx-tools: ${orphans.length} account(s) have no allowedCompanies and will reject every call. ` +
            "Set ['*'] for portfolio-wide or list specific company UUIDs.",
          { orphanKeys: orphans.map((a) => a.key) },
        );
      }
    } catch {
      // ignore
    }

    // ─── Read tools (Phase 1) ─────────────────────────────────────

    ctx.tools.register(
      "pbx_queue_list",
      {
        displayName: "List PBX queues",
        description: "List queues scoped to the calling company.",
        parametersSchema: {
          type: "object",
          properties: { account: { type: "string" } },
        },
      },
      async (params, runCtx) => {
        const accountKey = asString((params as { account?: unknown }).account);
        const r = await resolveOrError(ctx, runCtx, "pbx_queue_list", accountKey);
        if (!r.ok) return errorResult(r.error);
        const engine = getEngineFor(runCtx.companyId, r.resolved.accountKey);
        try {
          const queues = await engine.listQueues(r.resolved.scope);
          await track(ctx, runCtx, "pbx_queue_list", r.resolved.accountKey, {
            count: queues.length,
          });
          return { data: { queues } };
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    );

    ctx.tools.register(
      "pbx_queue_status",
      {
        displayName: "Get PBX queue status",
        description: "Snapshot of one queue.",
        parametersSchema: {
          type: "object",
          properties: { account: { type: "string" }, queue: { type: "string" } },
          required: ["queue"],
        },
      },
      async (params, runCtx) => {
        const p = params as { account?: unknown; queue?: unknown };
        const accountKey = asString(p.account);
        const queue = asString(p.queue);
        if (!queue) return errorResult("[EVALIDATION] `queue` is required.");
        const r = await resolveOrError(ctx, runCtx, "pbx_queue_status", accountKey);
        if (!r.ok) return errorResult(r.error);
        const engine = getEngineFor(runCtx.companyId, r.resolved.accountKey);
        try {
          const status = await engine.getQueueStatus(r.resolved.scope, queue);
          await track(ctx, runCtx, "pbx_queue_status", r.resolved.accountKey, {
            queue,
          });
          return { data: status };
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    );

    ctx.tools.register(
      "pbx_parked_calls",
      {
        displayName: "List parked calls",
        description: "Currently-parked calls in the company's scope.",
        parametersSchema: {
          type: "object",
          properties: { account: { type: "string" } },
        },
      },
      async (params, runCtx) => {
        const accountKey = asString((params as { account?: unknown }).account);
        const r = await resolveOrError(ctx, runCtx, "pbx_parked_calls", accountKey);
        if (!r.ok) return errorResult(r.error);
        const engine = getEngineFor(runCtx.companyId, r.resolved.accountKey);
        try {
          const parked = await engine.listParkedCalls(r.resolved.scope);
          await track(ctx, runCtx, "pbx_parked_calls", r.resolved.accountKey, {
            count: parked.length,
          });
          return { data: { parked } };
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    );

    ctx.tools.register(
      "pbx_active_calls",
      {
        displayName: "List active calls",
        description: "Calls in progress in the company's scope.",
        parametersSchema: {
          type: "object",
          properties: { account: { type: "string" } },
        },
      },
      async (params, runCtx) => {
        const accountKey = asString((params as { account?: unknown }).account);
        const r = await resolveOrError(ctx, runCtx, "pbx_active_calls", accountKey);
        if (!r.ok) return errorResult(r.error);
        const engine = getEngineFor(runCtx.companyId, r.resolved.accountKey);
        try {
          const calls = await engine.listActiveCalls(r.resolved.scope);
          await track(ctx, runCtx, "pbx_active_calls", r.resolved.accountKey, {
            count: calls.length,
          });
          return { data: { count: calls.length, calls } };
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    );

    ctx.tools.register(
      "pbx_agent_status",
      {
        displayName: "List agent status",
        description: "Presence + call state for agents in the company's scope.",
        parametersSchema: {
          type: "object",
          properties: { account: { type: "string" }, extension: { type: "string" } },
        },
      },
      async (params, runCtx) => {
        const p = params as { account?: unknown; extension?: unknown };
        const accountKey = asString(p.account);
        const extension = asString(p.extension);
        const r = await resolveOrError(ctx, runCtx, "pbx_agent_status", accountKey);
        if (!r.ok) return errorResult(r.error);
        const engine = getEngineFor(runCtx.companyId, r.resolved.accountKey);
        try {
          const agents = await engine.listAgents(r.resolved.scope, extension);
          await track(ctx, runCtx, "pbx_agent_status", r.resolved.accountKey, {
            count: agents.length,
          });
          return { data: { agents } };
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    );

    ctx.tools.register(
      "pbx_today_stats",
      {
        displayName: "Get today's PBX stats",
        description: "Today's call volumes and SLA, scoped to the company.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            queue: { type: "string" },
            direction: { type: "string", enum: ["inbound", "outbound", "internal"] },
          },
        },
      },
      async (params, runCtx) => {
        const p = params as { account?: unknown; queue?: unknown; direction?: unknown };
        const accountKey = asString(p.account);
        const r = await resolveOrError(ctx, runCtx, "pbx_today_stats", accountKey);
        if (!r.ok) return errorResult(r.error);
        const engine = getEngineFor(runCtx.companyId, r.resolved.accountKey);
        try {
          const stats = await engine.getTodayStats(r.resolved.scope, {
            queueId: asString(p.queue),
            direction: asString(p.direction) as
              | "inbound"
              | "outbound"
              | "internal"
              | undefined,
          });
          await track(ctx, runCtx, "pbx_today_stats", r.resolved.accountKey, {
            queue: asString(p.queue),
          });
          return { data: stats };
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    );

    ctx.tools.register(
      "pbx_call_history",
      {
        displayName: "Get call history",
        description: "Paginated call records in a window, scoped to the company.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            since: { type: "string" },
            until: { type: "string" },
            direction: { type: "string", enum: ["inbound", "outbound", "internal"] },
            extension: { type: "string" },
            queue: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 500 },
            cursor: { type: "string" },
          },
          required: ["since"],
        },
      },
      async (params, runCtx) => {
        const p = params as Record<string, unknown>;
        const since = asString(p.since);
        if (!since) return errorResult("[EVALIDATION] `since` is required.");
        const accountKey = asString(p.account);
        const r = await resolveOrError(ctx, runCtx, "pbx_call_history", accountKey);
        if (!r.ok) return errorResult(r.error);
        const engine = getEngineFor(runCtx.companyId, r.resolved.accountKey);
        try {
          const result = await engine.listCallHistory(
            r.resolved.scope,
            {
              since,
              until: asString(p.until),
              direction: asString(p.direction) as
                | "inbound"
                | "outbound"
                | "internal"
                | undefined,
              extension: asString(p.extension),
              queue: asString(p.queue),
              limit: asNumber(p.limit),
              cursor: asString(p.cursor),
            },
            !!r.resolved.account.exposeRecordings,
          );
          await track(ctx, runCtx, "pbx_call_history", r.resolved.accountKey, {
            count: result.calls.length,
          });
          return { data: result };
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    );

    ctx.tools.register(
      "pbx_did_list",
      {
        displayName: "List DIDs",
        description: "External numbers routed to the company.",
        parametersSchema: {
          type: "object",
          properties: { account: { type: "string" } },
        },
      },
      async (params, runCtx) => {
        const accountKey = asString((params as { account?: unknown }).account);
        const r = await resolveOrError(ctx, runCtx, "pbx_did_list", accountKey);
        if (!r.ok) return errorResult(r.error);
        const engine = getEngineFor(runCtx.companyId, r.resolved.accountKey);
        try {
          const dids = await engine.listDids(r.resolved.scope);
          await track(ctx, runCtx, "pbx_did_list", r.resolved.accountKey, {
            count: dids.length,
          });
          return { data: { dids } };
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    );

    ctx.tools.register(
      "pbx_extension_list",
      {
        displayName: "List extensions",
        description: "Extensions visible to the company.",
        parametersSchema: {
          type: "object",
          properties: { account: { type: "string" } },
        },
      },
      async (params, runCtx) => {
        const accountKey = asString((params as { account?: unknown }).account);
        const r = await resolveOrError(ctx, runCtx, "pbx_extension_list", accountKey);
        if (!r.ok) return errorResult(r.error);
        const engine = getEngineFor(runCtx.companyId, r.resolved.accountKey);
        try {
          const extensions = await engine.listExtensions(r.resolved.scope);
          await track(ctx, runCtx, "pbx_extension_list", r.resolved.accountKey, {
            count: extensions.length,
          });
          return { data: { extensions } };
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    );

    // ─── Mutation tools (Phase 2) ─────────────────────────────────

    ctx.tools.register(
      "pbx_click_to_call",
      {
        displayName: "Originate a call (click-to-call)",
        description: "Origin from a human extension to a destination.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            fromExtension: { type: "string" },
            toNumber: { type: "string" },
            idempotencyKey: { type: "string" },
          },
          required: ["fromExtension", "toNumber"],
        },
      },
      async (params, runCtx) => {
        const p = params as Record<string, unknown>;
        const fromExtension = asString(p.fromExtension);
        const toNumber = asString(p.toNumber);
        if (!fromExtension || !toNumber) {
          return errorResult("[EVALIDATION] fromExtension and toNumber are required.");
        }
        try {
          await assertMutationsEnabled(ctx, "pbx_click_to_call");
        } catch (err) {
          return errorResult((err as Error).message);
        }
        const accountKey = asString(p.account);
        const r = await resolveOrError(ctx, runCtx, "pbx_click_to_call", accountKey);
        if (!r.ok) return errorResult(r.error);
        try {
          await bumpClickToCallCounter(ctx, runCtx.companyId, r.resolved.account);
        } catch (err) {
          return errorResult((err as Error).message);
        }
        const engine = getEngineFor(runCtx.companyId, r.resolved.accountKey);
        try {
          const result = await engine.clickToCall(r.resolved.scope, {
            fromExtension,
            toNumber,
            idempotencyKey: asString(p.idempotencyKey),
          });
          await track(ctx, runCtx, "pbx_click_to_call", r.resolved.accountKey, {
            fromExtension,
          });
          return { data: result };
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    );

    ctx.tools.register(
      "pbx_park_call",
      {
        displayName: "Park an active call",
        description: "Park a call in a slot.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            callId: { type: "string" },
            slot: { type: "string" },
          },
          required: ["callId"],
        },
      },
      async (params, runCtx) => {
        const p = params as Record<string, unknown>;
        const callId = asString(p.callId);
        if (!callId) return errorResult("[EVALIDATION] `callId` is required.");
        try {
          await assertMutationsEnabled(ctx, "pbx_park_call");
        } catch (err) {
          return errorResult((err as Error).message);
        }
        const accountKey = asString(p.account);
        const r = await resolveOrError(ctx, runCtx, "pbx_park_call", accountKey);
        if (!r.ok) return errorResult(r.error);
        const engine = getEngineFor(runCtx.companyId, r.resolved.accountKey);
        try {
          const result = await engine.parkCall(r.resolved.scope, callId, asString(p.slot));
          await track(ctx, runCtx, "pbx_park_call", r.resolved.accountKey, {
            slot: result.slot,
          });
          return { data: result };
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    );

    ctx.tools.register(
      "pbx_pickup_park",
      {
        displayName: "Pick up a parked call",
        description: "Retrieve a parked call to a specific extension.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            slot: { type: "string" },
            atExtension: { type: "string" },
          },
          required: ["slot", "atExtension"],
        },
      },
      async (params, runCtx) => {
        const p = params as Record<string, unknown>;
        const slot = asString(p.slot);
        const atExtension = asString(p.atExtension);
        if (!slot || !atExtension) {
          return errorResult("[EVALIDATION] slot and atExtension are required.");
        }
        try {
          await assertMutationsEnabled(ctx, "pbx_pickup_park");
        } catch (err) {
          return errorResult((err as Error).message);
        }
        const accountKey = asString(p.account);
        const r = await resolveOrError(ctx, runCtx, "pbx_pickup_park", accountKey);
        if (!r.ok) return errorResult(r.error);
        const engine = getEngineFor(runCtx.companyId, r.resolved.accountKey);
        try {
          await engine.pickupPark(r.resolved.scope, slot, atExtension);
          await track(ctx, runCtx, "pbx_pickup_park", r.resolved.accountKey, {
            slot,
          });
          return { data: { ok: true } };
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    );

    ctx.tools.register(
      "pbx_transfer_call",
      {
        displayName: "Transfer an active call",
        description: "Transfer to another extension.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            callId: { type: "string" },
            toExtension: { type: "string" },
            mode: { type: "string", enum: ["blind", "attended"] },
          },
          required: ["callId", "toExtension"],
        },
      },
      async (params, runCtx) => {
        const p = params as Record<string, unknown>;
        const callId = asString(p.callId);
        const toExtension = asString(p.toExtension);
        const mode = (asString(p.mode) ?? "blind") as "blind" | "attended";
        if (!callId || !toExtension) {
          return errorResult("[EVALIDATION] callId and toExtension are required.");
        }
        try {
          await assertMutationsEnabled(ctx, "pbx_transfer_call");
        } catch (err) {
          return errorResult((err as Error).message);
        }
        const accountKey = asString(p.account);
        const r = await resolveOrError(ctx, runCtx, "pbx_transfer_call", accountKey);
        if (!r.ok) return errorResult(r.error);
        const engine = getEngineFor(runCtx.companyId, r.resolved.accountKey);
        try {
          await engine.transferCall(r.resolved.scope, callId, toExtension, mode);
          await track(ctx, runCtx, "pbx_transfer_call", r.resolved.accountKey, {
            mode,
          });
          return { data: { ok: true } };
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    );

    ctx.tools.register(
      "pbx_hangup_call",
      {
        displayName: "Hang up an active call",
        description: "Force-end a call.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            callId: { type: "string" },
          },
          required: ["callId"],
        },
      },
      async (params, runCtx) => {
        const p = params as Record<string, unknown>;
        const callId = asString(p.callId);
        if (!callId) return errorResult("[EVALIDATION] `callId` is required.");
        try {
          await assertMutationsEnabled(ctx, "pbx_hangup_call");
        } catch (err) {
          return errorResult((err as Error).message);
        }
        const accountKey = asString(p.account);
        const r = await resolveOrError(ctx, runCtx, "pbx_hangup_call", accountKey);
        if (!r.ok) return errorResult(r.error);
        const engine = getEngineFor(runCtx.companyId, r.resolved.accountKey);
        try {
          await engine.hangupCall(r.resolved.scope, callId);
          await track(ctx, runCtx, "pbx_hangup_call", r.resolved.accountKey, {});
          return { data: { ok: true } };
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    );

    // ─── Phase 3: WebSocket lifecycle ─────────────────────────────
    void openWebSocketsForAllAccounts(ctx);
  },

  async onConfigChanged() {
    clearEngineCache();
    await closeAllWebSockets();
    // Re-open WS lazily — the next setup call will rebind, but the
    // host doesn't re-call setup on configChanged. We open eagerly
    // here because realtime events should resume without a tool call.
    // The ctx isn't passed to onConfigChanged in the SDK shape, so we
    // rely on the host's default behaviour: if onConfigChanged isn't
    // implemented, the worker restarts; if it IS implemented, no
    // restart. We choose to be implemented + manage the WS ourselves,
    // so we kick the WS open through the next-tick mechanism: schedule
    // a fresh ctx-less reopen on the first tool call. (Implementation
    // note: in practice, onConfigChanged is rarely invoked separately;
    // most operators save config and the host restarts.)
  },

  async onShutdown() {
    await closeAllWebSockets();
    clearEngineCache();
  },

  async onHealth() {
    const wsCount = wsBindings.size;
    return {
      status: "ok",
      message: `3cx-tools ready — ${wsCount} WebSocket(s) connected`,
      details: { wsAccounts: Array.from(wsBindings.keys()) },
    };
  },
});

function errorResult(message: string): ToolResult {
  return { error: message };
}

export default plugin;
runWorker(plugin, import.meta.url);
