import {
  definePlugin,
  runWorker,
  type PluginApiRequestInput,
  type PluginApiResponse,
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
  NormalizedCallRecord,
  NormalizedPbxEvent,
  ResolvedAccount,
  ScopeFilter,
} from "./engines/types.js";
import {
  ingestAccount,
  listConfiguredAccounts,
  queryCache,
} from "./callHistoryCache.js";

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

/**
 * Run one ingest pass for an account: instantiate the engine, page
 * through Recordings, hand pages to the cache module.
 *
 * Returns the cache module's outcome — used by the scheduled job for
 * logging and by the setup backfill for fire-and-forget warnings.
 */
async function runIngestForAccount(
  ctx: PluginContext,
  account: ConfigAccount,
): Promise<{ accountKey: string; newlyIngested: number; totalCached: number }> {
  // Resolve credentials directly (no per-call runCtx — this is a
  // background job, not a tool invocation). Skip the per-(company,
  // account) cache and build the client fresh.
  if (!account.clientIdRef || !account.clientSecretRef || !account.pbxBaseUrl) {
    throw new Error(
      `[ECONFIG] account "${account.key}" is missing credentials; skipping.`,
    );
  }
  const [clientId, clientSecret] = await Promise.all([
    ctx.secrets.resolve(account.clientIdRef),
    ctx.secrets.resolve(account.clientSecretRef),
  ]);
  if (!clientId || !clientSecret) {
    throw new Error(
      `[ECONFIG] account "${account.key}" credentials did not resolve.`,
    );
  }
  const client = new XapiClient({
    ctx,
    accountKey: account.key,
    pbxBaseUrl: account.pbxBaseUrl,
    clientId,
    clientSecret,
  });
  const engine = new V20XapiEngine(client);

  // The Recordings tool uses an audio-url builder so the browser can
  // play the audio via the plugin's proxy route. The ingest job doesn't
  // need that — we only care about call metadata. Pass a no-op stub.
  const audioUrlBuilder = (_recordingId: string) => "";
  const singleScope: ScopeFilter = { mode: "single" };

  return ingestAccount(
    ctx,
    account,
    async (cursor) => {
      const page = await engine.listRecordings(
        singleScope,
        { limit: 200, cursor },
        audioUrlBuilder,
      );
      return {
        recordings: page.recordings.map((r) => ({
          id: r.id,
          extension: r.extension,
          from: r.from,
          receivedAt: r.receivedAt,
          durationSec: r.durationSec,
          fromDidNumber: r.fromDidNumber,
          toDidNumber: r.toDidNumber,
        })),
        nextCursor: page.nextCursor,
      };
    },
    (r) => recordingToCallRecord(r),
  );
}

/**
 * Map a Recording's metadata into NormalizedCallRecord shape so the
 * Call history page can render it like any other call.
 *
 * Direction heuristic (3CX v20's Recordings rows don't always populate
 * fromDidNumber / toDidNumber, so we use field-pattern matching):
 *   - `from` looks PSTN (10+ digits) and ≠ `extension` → inbound
 *   - `from` equals `extension`, AND `toDidNumber` is set OR there's no
 *     other internal party → outbound (caller IS the extension dialing out)
 *   - both are short / both look like extensions → internal
 * Explicit DID hints (fromDidNumber / toDidNumber) still override when
 * 3CX provided them.
 *
 * All recorded calls were, by definition, answered — disposition is
 * hardcoded "answered". Missed / abandoned calls won't have recordings
 * and so aren't in the cache. Documented limitation of this data source.
 */
function recordingToCallRecord(r: {
  id: string;
  extension: string;
  from: string;
  receivedAt: string;
  durationSec: number;
  fromDidNumber?: string;
  toDidNumber?: string;
}): NormalizedCallRecord {
  const endedAt = new Date(
    Date.parse(r.receivedAt) + r.durationSec * 1000,
  ).toISOString();

  const fromDigits = (r.from ?? "").replace(/\D/g, "");
  const extDigits = (r.extension ?? "").replace(/\D/g, "");
  const fromIsPstn = fromDigits.length >= 10;
  const fromIsExtension = fromDigits.length > 0 && fromDigits === extDigits;

  let direction: "inbound" | "outbound" | "internal";
  if (r.fromDidNumber) {
    direction = "inbound";
  } else if (r.toDidNumber) {
    direction = "outbound";
  } else if (fromIsPstn && !fromIsExtension) {
    direction = "inbound";
  } else if (fromIsExtension) {
    // Caller IS the internal extension — placing an outbound call.
    direction = "outbound";
  } else {
    direction = "internal";
  }

  // For outbound calls the "to" side is the external destination
  // (toDidNumber when present); for inbound it's the called extension.
  let toNumber: string;
  if (direction === "outbound") {
    toNumber = r.toDidNumber ?? "";
  } else {
    toNumber = r.extension ?? "";
  }

  return {
    callId: r.id,
    fromNumber: r.from ?? r.fromDidNumber ?? "",
    toNumber,
    extension: r.extension,
    queue: undefined,
    startedAt: r.receivedAt,
    endedAt,
    durationSec: r.durationSec,
    direction,
    disposition: "answered",
  };
}

/**
 * Build the plugin-scoped audio URL the browser will GET to play a
 * recording. The path here MUST match the manifest's apiRoutes entry; the
 * host prefixes it with `/api/plugins/3cx-tools/api`.
 */
function buildRecordingAudioUrl(
  companyId: string,
  accountKey: string,
  recordingId: string,
): string {
  const params = new URLSearchParams({
    companyId,
    account: accountKey,
    id: recordingId,
  });
  return `/api/plugins/3cx-tools/api/recordings/audio?${params.toString()}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
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

/**
 * Captured during setup() so the API-request handler (which doesn't
 * receive a ctx) can talk to the engine registry, secrets, and logger.
 */
let pluginCtx: PluginContext | null = null;

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    pluginCtx = ctx;
    ctx.logger.info("3cx-tools plugin starting", { version: "0.4.1" });

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

    // ─── Recordings (Phase 4) ─────────────────────────────────────

    ctx.tools.register(
      "pbx_recording_list",
      {
        displayName: "List call recordings",
        description:
          "List call recordings on the PBX scoped to the calling company. Each item includes a playable audioUrl.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            extension: { type: "string" },
            from: { type: "string", description: "ISO 8601 lower bound on Recording.StartTime" },
            to: { type: "string", description: "ISO 8601 upper bound on Recording.StartTime" },
            limit: { type: "integer", minimum: 1, maximum: 200 },
            cursor: { type: "string" },
          },
        },
      },
      async (params, runCtx) => {
        const p = params as Record<string, unknown>;
        const accountKey = asString(p.account);
        const r = await resolveOrError(ctx, runCtx, "pbx_recording_list", accountKey);
        if (!r.ok) return errorResult(r.error);
        const engine = getEngineFor(runCtx.companyId, r.resolved.accountKey);
        try {
          const result = await engine.listRecordings(
            r.resolved.scope,
            {
              extension: asString(p.extension),
              from: asString(p.from),
              to: asString(p.to),
              limit: asNumber(p.limit),
              cursor: asString(p.cursor),
            },
            (recId) => buildRecordingAudioUrl(runCtx.companyId, r.resolved.accountKey, recId),
          );
          await track(ctx, runCtx, "pbx_recording_list", r.resolved.accountKey, {
            count: result.recordings.length,
          });
          return { data: result };
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    );

    ctx.tools.register(
      "pbx_recording_get",
      {
        displayName: "Get one call recording",
        description:
          "Fetch a single call recording. With inlineAudio=true, also returns a data: URL playable in <audio>.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            id: { type: "string" },
            inlineAudio: { type: "boolean" },
          },
          required: ["id"],
        },
      },
      async (params, runCtx) => {
        const p = params as Record<string, unknown>;
        const id = asString(p.id);
        if (!id) return errorResult("[EVALIDATION] `id` is required.");
        const accountKey = asString(p.account);
        const r = await resolveOrError(ctx, runCtx, "pbx_recording_get", accountKey);
        if (!r.ok) return errorResult(r.error);
        const engine = getEngineFor(runCtx.companyId, r.resolved.accountKey);
        try {
          const audioUrlBuilder = (recId: string) =>
            buildRecordingAudioUrl(runCtx.companyId, r.resolved.accountKey, recId);
          // Reuse list with a tight filter so we share normalization.
          // The Recordings entity doesn't support OData filter-by-Id cleanly
          // across versions, so list-then-find. Cap limit at the page size.
          const page = await engine.listRecordings(
            r.resolved.scope,
            { limit: 200 },
            audioUrlBuilder,
          );
          const match = page.recordings.find((v) => v.id === id);
          if (!match) {
            return errorResult(
              `[E3CX_NOT_FOUND] Recording "${id}" not found in the first 200 entries for your scope.`,
            );
          }
          let inline: { audioBase64?: string; audioDataUrl?: string } = {};
          if (asBool(p.inlineAudio) === true) {
            const audio = await engine.fetchRecordingAudio(r.resolved.scope, id);
            const base64 = bytesToBase64(audio.bytes);
            inline = {
              audioBase64: base64,
              audioDataUrl: `data:${audio.contentType};base64,${base64}`,
            };
          }
          await track(ctx, runCtx, "pbx_recording_get", r.resolved.accountKey, {
            inlineAudio: asBool(p.inlineAudio) ?? false,
          });
          return { data: { ...match, ...inline } };
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    );

    // ─── UI getData handlers (for the Phone pages + sidebar) ──────

    // Phone-section sidebar visibility — same allow-list gate as the
    // legacy recordings.sidebar-visible (kept below for compatibility).
    // The PhoneSidebarItem renders only when the company has access to
    // at least one 3cx-tools account.
    ctx.data.register("phone.sidebar-visible", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      if (!companyId) return { visible: false };
      const config = (await ctx.config.get()) as InstanceConfig;
      const accounts = config.accounts ?? [];
      const visible = accounts.some((a) => {
        const allowed = a.allowedCompanies ?? [];
        return allowed.includes("*") || allowed.includes(companyId);
      });
      return { visible };
    });

    // Pick the first-allowed account for a company. Helper used by every
    // page that doesn't need a per-account picker (parked / active /
    // queues / etc.) — they all just want "the account the company has
    // access to" and fall over to multi-account UX only when needed.
    async function pickAccountKey(companyId: string): Promise<string | null> {
      const config = (await ctx.config.get()) as InstanceConfig;
      const accounts = config.accounts ?? [];
      const match = accounts.find((a) => {
        const allowed = a.allowedCompanies ?? [];
        return allowed.includes("*") || allowed.includes(companyId);
      });
      return match?.key ?? null;
    }

    function runCtxFor(companyId: string, channel: string): ToolRunContext {
      return { companyId, runId: `ui-${channel}`, agentId: "", projectId: "" };
    }

    /**
     * First space-separated token of a Caller/Callee display string.
     * 3CX returns these as "<token> <display>" — for internal legs the
     * token IS the extension; for external legs it's a 3CX-internal
     * segment id. Used to cross-reference ActiveCalls against the
     * Agents list.
     */
    function firstToken(s: string | undefined): string | undefined {
      if (!s) return undefined;
      const t = s.split(/\s+/, 1)[0];
      return t || undefined;
    }

    // ── phone.parked-calls ─────────────────────────────────────────
    ctx.data.register("phone.parked-calls", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      if (!companyId) return { parked: [] };
      const accountKey = await pickAccountKey(companyId);
      const r = await resolveOrError(ctx, runCtxFor(companyId, "phone.parked-calls"), "phone.parked-calls", accountKey ?? undefined);
      if (!r.ok) return { parked: [], error: r.error };
      const engine = getEngineFor(companyId, r.resolved.accountKey);
      try {
        const parked = await engine.listParkedCalls(r.resolved.scope);
        return { parked };
      } catch (err) {
        return { parked: [], error: (err as Error).message };
      }
    });

    // ── phone.active-calls ─────────────────────────────────────────
    ctx.data.register("phone.active-calls", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      if (!companyId) return { calls: [] };
      const accountKey = await pickAccountKey(companyId);
      const r = await resolveOrError(ctx, runCtxFor(companyId, "phone.active-calls"), "phone.active-calls", accountKey ?? undefined);
      if (!r.ok) return { calls: [], error: r.error };
      const engine = getEngineFor(companyId, r.resolved.accountKey);
      try {
        const calls = await engine.listActiveCalls(r.resolved.scope);
        return { calls };
      } catch (err) {
        return { calls: [], error: (err as Error).message };
      }
    });

    // ── phone.queues ───────────────────────────────────────────────
    ctx.data.register("phone.queues", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      if (!companyId) return { queues: [] };
      const accountKey = await pickAccountKey(companyId);
      const r = await resolveOrError(ctx, runCtxFor(companyId, "phone.queues"), "phone.queues", accountKey ?? undefined);
      if (!r.ok) return { queues: [], error: r.error };
      const engine = getEngineFor(companyId, r.resolved.accountKey);
      try {
        const queues = await engine.listQueues(r.resolved.scope);
        return { queues };
      } catch (err) {
        return { queues: [], error: (err as Error).message };
      }
    });

    // ── phone.agents ───────────────────────────────────────────────
    ctx.data.register("phone.agents", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      if (!companyId) return { agents: [] };
      const accountKey = await pickAccountKey(companyId);
      const r = await resolveOrError(ctx, runCtxFor(companyId, "phone.agents"), "phone.agents", accountKey ?? undefined);
      if (!r.ok) return { agents: [], error: r.error };
      const engine = getEngineFor(companyId, r.resolved.accountKey);
      try {
        // Single-mode scope so the page sees every PBX agent (same as
        // phone.extensions). 3CX v20's Users payload doesn't populate
        // IsInCall / CurrentCallSec / Status-while-on-call reliably, so
        // we cross-reference ActiveCalls and enrich each agent whose
        // extension shows up on a live call. Lets the page show
        // "busy" / "on call" / "in call for" without 3CX's data.
        const [agents, active] = await Promise.all([
          engine.listAgents({ mode: "single" }),
          engine.listActiveCalls({ mode: "single" }),
        ]);
        // Map extension → first matching active call (longest duration
        // wins if an ext is on multiple legs).
        const byExt = new Map<string, { durationSec: number }>();
        for (const c of active) {
          const candidates = [
            firstToken(c.fromNumber),
            firstToken(c.toNumber),
            c.extension,
          ].filter((v): v is string => !!v);
          for (const ext of candidates) {
            const prior = byExt.get(ext);
            if (!prior || c.durationSec > prior.durationSec) {
              byExt.set(ext, { durationSec: c.durationSec });
            }
          }
        }
        const enriched = agents.map((a) => {
          const onCall = byExt.get(a.extension);
          if (!onCall) return a;
          return {
            ...a,
            inCall: true,
            currentCallSec: onCall.durationSec,
            // Bump presence to "busy" so the pill reads correctly when
            // 3CX hasn't already labeled the agent in-call.
            presence: a.presence === "available" ? ("busy" as const) : a.presence,
          };
        });
        return { agents: enriched };
      } catch (err) {
        return { agents: [], error: (err as Error).message };
      }
    });

    // ── phone.call-history ─────────────────────────────────────────
    // Reads from the local cache populated by the `ingest-call-history`
    // scheduled job. The XAPI's CallHistoryView is broken on v20 (see
    // callHistoryCache.ts header comment), so we cache from Recordings
    // instead and serve filtered slices instantly.
    ctx.data.register("phone.call-history", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      if (!companyId) return { calls: [] };
      const accountKey = await pickAccountKey(companyId);
      if (!accountKey) return { calls: [], error: "No 3cx-tools account configured for this company." };
      const since = typeof params.since === "string" ? params.since : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const until = typeof params.until === "string" ? params.until : undefined;
      const directionParam = typeof params.direction === "string" ? params.direction : "any";
      const direction = directionParam === "any" ? undefined : (directionParam as "inbound" | "outbound" | "internal");
      const queue = typeof params.queue === "string" ? params.queue : undefined;
      const limit = typeof params.limit === "number" ? params.limit : 200;
      try {
        const result = await queryCache(ctx, accountKey, { since, until, direction, queue, limit });
        return {
          calls: result.calls,
          totalCached: result.totalCached,
          lastIngestAt: result.lastIngestAt,
        };
      } catch (err) {
        return { calls: [], error: (err as Error).message };
      }
    });

    // ── phone.daily-report ─────────────────────────────────────────
    ctx.data.register("phone.daily-report", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      if (!companyId) return { stats: null };
      const accountKey = await pickAccountKey(companyId);
      const r = await resolveOrError(ctx, runCtxFor(companyId, "phone.daily-report"), "phone.daily-report", accountKey ?? undefined);
      if (!r.ok) return { stats: null, error: r.error };
      const engine = getEngineFor(companyId, r.resolved.accountKey);
      try {
        const stats = await engine.getTodayStats(r.resolved.scope);
        return { stats };
      } catch (err) {
        return { stats: null, error: (err as Error).message };
      }
    });

    // ── phone.dids ─────────────────────────────────────────────────
    ctx.data.register("phone.dids", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      if (!companyId) return { dids: [] };
      const accountKey = await pickAccountKey(companyId);
      const r = await resolveOrError(ctx, runCtxFor(companyId, "phone.dids"), "phone.dids", accountKey ?? undefined);
      if (!r.ok) return { dids: [], error: r.error };
      const engine = getEngineFor(companyId, r.resolved.accountKey);
      try {
        const dids = await engine.listDids(r.resolved.scope);
        return { dids };
      } catch (err) {
        return { dids: [], error: (err as Error).message };
      }
    });

    // ── phone.extensions ───────────────────────────────────────────
    ctx.data.register("phone.extensions", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      if (!companyId) return { extensions: [] };
      const accountKey = await pickAccountKey(companyId);
      const r = await resolveOrError(ctx, runCtxFor(companyId, "phone.extensions"), "phone.extensions", accountKey ?? undefined);
      if (!r.ok) return { extensions: [], error: r.error };
      const engine = getEngineFor(companyId, r.resolved.accountKey);
      try {
        // Use single-mode scope so the page sees every PBX extension,
        // not just the calling company's range — matches what the
        // existing recordings.pbx-extensions channel does.
        const extensions = await engine.listExtensions({ mode: "single" });
        return { extensions };
      } catch (err) {
        return { extensions: [], error: (err as Error).message };
      }
    });

    // ── phone.trunks ───────────────────────────────────────────────
    ctx.data.register("phone.trunks", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      if (!companyId) return { trunks: [] };
      const accountKey = await pickAccountKey(companyId);
      const r = await resolveOrError(ctx, runCtxFor(companyId, "phone.trunks"), "phone.trunks", accountKey ?? undefined);
      if (!r.ok) return { trunks: [], error: r.error };
      const engine = getEngineFor(companyId, r.resolved.accountKey);
      try {
        const trunks = await engine.listTrunks(r.resolved.scope);
        return { trunks };
      } catch (err) {
        return { trunks: [], error: (err as Error).message };
      }
    });

    // ── Legacy recordings sidebar visibility (kept for upgrade paths
    //    where an old cached UI bundle still references the old name).
    ctx.data.register("recordings.sidebar-visible", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      if (!companyId) return { visible: false };
      const config = (await ctx.config.get()) as InstanceConfig;
      const accounts = config.accounts ?? [];
      const visible = accounts.some((a) => {
        const allowed = a.allowedCompanies ?? [];
        return allowed.includes("*") || allowed.includes(companyId);
      });
      return { visible };
    });

    // Account picker for the recordings page — surfaces the accounts the
    // calling company has access to, so the page can offer a dropdown when
    // multiple accounts are configured.
    ctx.data.register("recordings.accounts", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      if (!companyId) return { accounts: [], defaultAccount: null };
      const config = (await ctx.config.get()) as InstanceConfig;
      const accounts = (config.accounts ?? [])
        .filter((a) => {
          const allowed = a.allowedCompanies ?? [];
          return allowed.includes("*") || allowed.includes(companyId);
        })
        .map((a) => ({ key: a.key, displayName: a.displayName ?? a.key }));
      return {
        accounts,
        defaultAccount: config.defaultAccount ?? accounts[0]?.key ?? null,
      };
    });

    // Recordings listing for the page — same shape as the agent-facing
    // tool, but invoked via the UI bridge so the page doesn't need a
    // companyId-bearing tool credential.
    ctx.data.register("recordings.list", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      if (!companyId) return { recordings: [], nextCursor: undefined };
      const accountKey = typeof params.account === "string" ? params.account : undefined;
      const extension = typeof params.extension === "string" ? params.extension : undefined;
      const from = typeof params.from === "string" ? params.from : undefined;
      const to = typeof params.to === "string" ? params.to : undefined;
      const limit = typeof params.limit === "number" ? params.limit : undefined;
      const cursor = typeof params.cursor === "string" ? params.cursor : undefined;

      const runCtxLike: ToolRunContext = {
        companyId,
        runId: "ui-recordings.list",
        agentId: "",
        projectId: "",
      };
      const r = await resolveOrError(ctx, runCtxLike, "recordings.list", accountKey);
      if (!r.ok) return { error: r.error, recordings: [], nextCursor: undefined };
      const engine = getEngineFor(companyId, r.resolved.accountKey);
      try {
        const result = await engine.listRecordings(
          r.resolved.scope,
          { extension, from, to, limit, cursor },
          (recId) => buildRecordingAudioUrl(companyId, r.resolved.accountKey, recId),
        );
        return result;
      } catch (err) {
        return { error: (err as Error).message, recordings: [], nextCursor: undefined };
      }
    });

    // PBX-wide extension list for the dropdown on the Recordings page.
    // Intentionally NOT scoped to the calling company: on shared-extension
    // setups the company has no `extensionRanges` claim and we want the
    // operator to be able to filter recordings by any agent on the PBX.
    // The recording list itself still applies company scope on top of
    // whatever extension is picked, so cross-company data can't leak.
    // Companies without ANY 3cx-tools access still get [] (no allowed
    // account at all → no PBX visibility).
    ctx.data.register("recordings.pbx-extensions", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      if (!companyId) return { extensions: [] };
      const config = (await ctx.config.get()) as InstanceConfig;
      const accounts = config.accounts ?? [];
      const accessible = accounts.find((a) => {
        const allowed = a.allowedCompanies ?? [];
        return allowed.includes("*") || allowed.includes(companyId);
      });
      if (!accessible) return { extensions: [] };
      const engine = getEngineFor(companyId, accessible.key);
      try {
        // Bypass scope filter intentionally — see comment above.
        const exts = await engine.listExtensions({ mode: "single" });
        const userExts = exts
          .filter((e) => e.type === "user" && /^\d{2,5}$/.test(e.number))
          .map((e) => ({ extension: e.number, displayName: e.displayName }))
          .sort((a, b) => a.extension.localeCompare(b.extension, undefined, { numeric: true }));
        return { extensions: userExts };
      } catch (err) {
        return { extensions: [], error: (err as Error).message };
      }
    });

    // ─── Mutation tools (Phase 2) ─────────────────────────────────

    ctx.tools.register(
      "pbx_click_to_call",
      {
        displayName: "Originate a call (click-to-call)",
        description:
          "Originate a call. Pass fromExtension OR fromUserId/fromUserEmail; toNumber accepts any common format.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            fromExtension: { type: "string" },
            fromUserId: { type: "string" },
            fromUserEmail: { type: "string" },
            toNumber: { type: "string" },
            idempotencyKey: { type: "string" },
          },
          required: ["toNumber"],
        },
      },
      async (params, runCtx) => {
        const p = params as Record<string, unknown>;
        const toNumber = asString(p.toNumber);
        if (!toNumber) {
          return errorResult("[EVALIDATION] toNumber is required.");
        }

        // Resolve fromExtension. Priority: explicit > userId > userEmail.
        let fromExtension = asString(p.fromExtension);
        const fromUserId = asString(p.fromUserId);
        const fromUserEmail = asString(p.fromUserEmail);

        if (!fromExtension && (fromUserId || fromUserEmail)) {
          const config = (await ctx.config.get()) as InstanceConfig;
          const map = config.userExtensionMap ?? [];
          const emailLower = fromUserEmail?.toLowerCase();
          const match = map.find(
            (m) =>
              (fromUserId && m.userId === fromUserId) ||
              (emailLower &&
                m.userEmail &&
                m.userEmail.toLowerCase() === emailLower),
          );
          if (!match) {
            return errorResult(
              `[EUSER_NOT_MAPPED] No userExtensionMap entry for ${fromUserId ?? fromUserEmail}. ` +
                `Add the user to the plugin's "User → extension map" on the settings page.`,
            );
          }
          fromExtension = match.extension;
        }

        if (!fromExtension) {
          return errorResult(
            "[EVALIDATION] One of fromExtension, fromUserId, or fromUserEmail is required.",
          );
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
            resolvedVia: fromUserId ? "userId" : fromUserEmail ? "userEmail" : "explicit",
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

    // ─── Call history cache ingest (per-account) ──────────────────
    ctx.jobs.register("ingest-call-history", async () => {
      const accounts = await listConfiguredAccounts(ctx);
      for (const account of accounts) {
        if (!account.key) continue;
        try {
          const result = await runIngestForAccount(ctx, account);
          ctx.logger.info?.("ingest-call-history: ok", result);
        } catch (err) {
          ctx.logger.warn?.("ingest-call-history: account failed", {
            account: account.key,
            error: (err as Error).message,
          });
        }
      }
    });

    // Kick a backfill on setup so a freshly-installed plugin doesn't
    // wait 5 minutes for the first cron tick. Fire-and-forget; errors
    // bubble through the same warn path.
    void (async () => {
      try {
        const accounts = await listConfiguredAccounts(ctx);
        for (const account of accounts) {
          if (!account.key) continue;
          await runIngestForAccount(ctx, account).catch((err) =>
            ctx.logger.warn?.("ingest-call-history: backfill failed", {
              account: account.key,
              error: (err as Error).message,
            }),
          );
        }
      } catch (err) {
        ctx.logger.warn?.("ingest-call-history: setup-backfill failed", {
          error: (err as Error).message,
        });
      }
    })();
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

  async onApiRequest(input: PluginApiRequestInput): Promise<PluginApiResponse> {
    if (input.routeKey === "recordings.audio") {
      return handleRecordingAudio(pluginCtx, input);
    }
    return { status: 404, body: { error: `Unknown route: ${input.routeKey}` } };
  },
});

async function handleRecordingAudio(
  ctx: PluginContext | null,
  input: PluginApiRequestInput,
): Promise<PluginApiResponse> {
  if (!ctx) {
    return { status: 503, body: { error: "Plugin not initialized yet." } };
  }
  const accountKey =
    typeof input.query.account === "string" ? input.query.account : undefined;
  const recordingId =
    typeof input.query.id === "string" ? input.query.id : undefined;
  if (!recordingId) {
    return { status: 400, body: { error: "Missing `id` query parameter." } };
  }

  // Synthesize a ToolRunContext-shaped object for getResolvedAccount —
  // resolveOrError only consults companyId for the scope check; the
  // other fields are populated for telemetry consistency.
  const runCtxLike: ToolRunContext = {
    companyId: input.companyId,
    runId: input.actor.runId ?? `api-${input.routeKey}`,
    agentId: input.actor.agentId ?? "",
    projectId: "",
  };
  const r = await resolveOrError(ctx, runCtxLike, "recordings.audio", accountKey);
  if (!r.ok) {
    const status = r.error.includes("[ECOMPANY_NOT_ALLOWED]") ? 403 : 400;
    return { status, body: { error: r.error } };
  }
  const engine = getEngineFor(input.companyId, r.resolved.accountKey);
  try {
    const audio = await engine.fetchRecordingAudio(r.resolved.scope, recordingId);
    const base64 = Buffer.from(audio.bytes).toString("base64");
    return {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: { contentType: audio.contentType, base64 },
    };
  } catch (err) {
    const msg = (err as Error).message;
    let status = 500;
    if (msg.includes("[ESCOPE_VIOLATION]")) status = 403;
    else if (msg.includes("[E3CX_NOT_FOUND]")) status = 404;
    return { status, body: { error: msg } };
  }
}

function errorResult(message: string): ToolResult {
  return { error: message };
}

export default plugin;
runWorker(plugin, import.meta.url);
