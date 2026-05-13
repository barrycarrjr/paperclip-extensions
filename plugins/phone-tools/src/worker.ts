import {
  definePlugin,
  runWorker,
  type PluginApiRequestInput,
  type PluginApiResponse,
  type PluginContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { isCompanyAllowed } from "./companyAccess.js";
import {
  clearEngineCache,
  getEnginesForEndpoint,
  getResolvedAccount,
} from "./engines/registry.js";
import { handleAssistantsApi } from "./api/assistants-routes.js";
import { handleOperatorPhoneApi } from "./api/operator-phone-routes.js";
import { recordSpend } from "./assistants/cost-cap.js";
import { computeSidebarVisibility } from "./assistants/sidebar-visibility.js";
import type {
  AssistantConfig,
  CallDirection,
  ConfigAccount,
  InstanceConfig,
  NormalizedCallStatus,
  NormalizedPhoneEvent,
  ResolvedAccount,
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
    const dims: Record<string, string | number | boolean> = {
      account: accountKey,
    };
    if (runCtx?.companyId) dims.companyId = runCtx.companyId;
    if (runCtx?.runId) dims.runId = runCtx.runId;
    for (const [k, v] of Object.entries(extra)) {
      if (v === null || v === undefined) continue;
      if (
        typeof v === "string" ||
        typeof v === "number" ||
        typeof v === "boolean"
      ) {
        dims[k] = v;
      } else {
        dims[k] = JSON.stringify(v);
      }
    }
    await ctx.telemetry.track(`phone-tools.${tool}`, dims);
  } catch {
    // never break tool calls on telemetry failure
  }
}

function assertNumberAllowed(
  resolved: ResolvedAccount,
  numberId: string,
): void {
  const allow = resolved.account.allowedNumbers;
  if (!allow || allow.length === 0) return;
  if (!allow.includes(numberId)) {
    throw new Error(
      `[ENUMBER_NOT_ALLOWED] phone-number "${numberId}" is not in account "${resolved.accountKey}" allowedNumbers list.`,
    );
  }
}

function assertAssistantAllowed(
  resolved: ResolvedAccount,
  assistantId: string,
): void {
  const allow = resolved.account.allowedAssistants;
  if (!allow || allow.length === 0) return;
  if (!allow.includes(assistantId)) {
    throw new Error(
      `[EASSISTANT_NOT_ALLOWED] assistant "${assistantId}" is not in account "${resolved.accountKey}" allowedAssistants list.`,
    );
  }
}

function resolveNumberId(
  resolved: ResolvedAccount,
  paramNumberId: string | undefined,
): string | undefined {
  const id = paramNumberId ?? resolved.account.defaultNumberId;
  if (!id) return undefined;
  assertNumberAllowed(resolved, id);
  return id;
}

// ─── Concurrency tracking (in-memory) ──────────────────────────────────

const activeOutboundByAccount = new Map<string, Set<string>>();
function activeKey(accountKey: string): string {
  return accountKey.toLowerCase();
}

function checkConcurrencyLimit(resolved: ResolvedAccount): void {
  const max = resolved.account.maxConcurrentCalls ?? 3;
  const set =
    activeOutboundByAccount.get(activeKey(resolved.accountKey)) ?? new Set();
  if (set.size >= max) {
    throw new Error(
      `[ECONCURRENCY_LIMIT] account "${resolved.accountKey}" already has ${set.size} active outbound call(s); max is ${max}.`,
    );
  }
}

function trackOutbound(accountKey: string, callId: string): void {
  const k = activeKey(accountKey);
  let set = activeOutboundByAccount.get(k);
  if (!set) {
    set = new Set();
    activeOutboundByAccount.set(k, set);
  }
  set.add(callId);
}

function untrackOutbound(callId: string): void {
  for (const set of activeOutboundByAccount.values()) {
    set.delete(callId);
  }
}

// ─── Module-level ctx capture for onWebhook ────────────────────────────
//
// The SDK exposes `onWebhook` as a top-level definition method, separate
// from `setup(ctx)`. We capture ctx during setup so the webhook
// dispatcher can route through `getEnginesForEndpoint`, emit events,
// persist state, and log under the plugin's logger.

let webhookCtx: PluginContext = null as unknown as PluginContext;
const webhookLogger = {
  info(msg: string, meta?: Record<string, unknown>) {
    webhookCtx?.logger?.info?.(msg, meta);
  },
  warn(msg: string, meta?: Record<string, unknown>) {
    webhookCtx?.logger?.warn?.(msg, meta);
  },
};

function normalizeHeaders(
  headers: Record<string, string | string[]> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    out[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

function safeJsonParse(s: string): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ─── Persisted call summaries ──────────────────────────────────────────

interface PersistedCallSummary {
  callId: string;
  accountKey: string;
  companyIds: string[];
  status: NormalizedCallStatus["status"];
  direction: CallDirection | null;
  from: string | null;
  to: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationSec: number | null;
  costUsd: number | null;
  endReason: string | null;
  recordingUrl?: string;
  finalTranscript?: string;
}

async function persistCallSummary(
  ctx: PluginContext,
  summary: PersistedCallSummary,
): Promise<void> {
  try {
    await ctx.state.set(
      { scopeKind: "instance", stateKey: `call:${summary.callId}` },
      summary,
    );
  } catch (err) {
    ctx.logger.warn("phone-tools: failed to persist call summary", {
      callId: summary.callId,
      err: (err as Error).message,
    });
  }
}

/**
 * Record a call's terminal state — persist its summary AND emit cost
 * telemetry — exactly once. Idempotent: subsequent calls with the same
 * callId become no-ops because they detect the existing state record.
 *
 * Both code paths that observe a terminal state (polling via
 * phone_call_status when no webhook is wired, OR the inbound webhook
 * handler when one is) call this helper. First-to-arrive wins; the
 * other becomes a no-op. This is what makes cost telemetry work for
 * outbound-only setups where the operator hasn't configured webhooks.
 */
async function recordTerminalCallIfNew(
  ctx: PluginContext,
  args: {
    callId: string;
    accountKey: string;
    engineKind: string;
    companyIds: string[];
    status: NormalizedCallStatus["status"];
    direction: CallDirection | null;
    from: string | null;
    to: string | null;
    startedAt: string | null;
    endedAt: string | null;
    durationSec: number | null;
    costUsd: number | null;
    endReason: string | null;
    runCtxForTelemetry: ToolRunContext | null;
  },
): Promise<{ recorded: boolean }> {
  const stateKey = { scopeKind: "instance" as const, stateKey: `call:${args.callId}` };

  // Read first — if there's already a summary persisted, this terminal
  // state has been recorded. Skip both the persist and the telemetry.
  try {
    const existing = await ctx.state.get(stateKey);
    if (existing) return { recorded: false };
  } catch {
    // If state.get throws, fall through and try to record anyway —
    // worst case we double-emit once. Better than missing the cost.
  }

  await persistCallSummary(ctx, {
    callId: args.callId,
    accountKey: args.accountKey,
    companyIds: args.companyIds,
    status: args.status,
    direction: args.direction,
    from: args.from,
    to: args.to,
    startedAt: args.startedAt,
    endedAt: args.endedAt,
    durationSec: args.durationSec,
    costUsd: args.costUsd,
    endReason: args.endReason,
  });

  // Accumulate the call's cost into the assistant's daily-cap window if we
  // can map this call back to a Paperclip assistant agentId. The mapping is
  // written when assistants-routes places the call.
  if (args.costUsd && args.costUsd > 0) {
    try {
      const mapping = await ctx.state.get({
        scopeKind: "instance",
        stateKey: `call-agent:${args.callId}`,
      });
      if (typeof mapping === "string" && mapping.length > 0) {
        await recordSpend(ctx, mapping, args.costUsd);
      }
    } catch (err) {
      ctx.logger.warn("phone-tools: failed to record assistant spend", {
        callId: args.callId,
        err: (err as Error).message,
      });
    }
  }

  // Cost telemetry — one shot per call. Emitted once per company
  // attached to the call (single company in the polling case;
  // potentially many in the webhook fan-out case).
  for (const companyId of args.companyIds) {
    await track(
      ctx,
      args.runCtxForTelemetry ?? ({ companyId, runId: "auto" } as ToolRunContext),
      `call.${args.engineKind}`,
      args.accountKey,
      {
        callId: args.callId,
        durationSec: args.durationSec ?? 0,
        costUsd: args.costUsd ?? 0,
        endReason: args.endReason ?? "unknown",
      },
    );
  }

  return { recorded: true };
}

/**
 * Best-effort board issue creation when an AI call is warm-transferred
 * to a human. The human picking up the SIP leg sees the transcript-so-
 * far + the AI's stated reason as a regular Paperclip issue in their
 * workflow.
 *
 * "Best-effort" — every step is wrapped: if the call→agent mapping
 * isn't there, or the assistant's phone config doesn't specify a
 * project, or the transcript fetch fails, we log and move on. The
 * transfer itself already happened on the SIP side; this is enrichment.
 *
 * Skills that want different routing (e.g. "transfers from the sales
 * AI go to the sales project; transfers from the support AI go to the
 * support project") can subscribe to plugin.phone-tools.call.transferred
 * directly and ignore this auto-issue path entirely.
 */
async function postTransferBoardComment(
  ctx: PluginContext,
  args: {
    accountKey: string;
    callId: string;
    destination: string;
    reason: string | null;
    endedAt: string;
    durationSec: number;
    companyIds: string[];
    engine: import("./engines/types.js").PhoneEngine;
  },
): Promise<void> {
  try {
    // 1. Map the call back to the originating assistant agent. The
    //    mapping is written by assistants-routes when the call is
    //    placed via the AgentPhoneTab — calls placed by skills via
    //    phone_call_make don't currently write this, so we skip
    //    gracefully when the mapping is missing.
    const mappingValue = await ctx.state.get({
      scopeKind: "instance",
      stateKey: `call-agent:${args.callId}`,
    });
    const agentId =
      typeof mappingValue === "string" && mappingValue.length > 0
        ? mappingValue
        : null;
    if (!agentId) {
      ctx.logger.info(
        "phone-tools: call.transferred — no call-agent mapping; skipping auto-issue (event still emitted for skills to handle)",
        { callId: args.callId },
      );
      return;
    }

    // 2. Read the assistant's phone config — needs transferIssueProjectId.
    const { readPhoneConfig } = await import("./assistants/cost-cap.js");
    const config = await readPhoneConfig(ctx, agentId);
    const projectId = config?.transferIssueProjectId;
    if (!projectId) {
      ctx.logger.info(
        "phone-tools: call.transferred — assistant has no transferIssueProjectId; skipping auto-issue",
        { callId: args.callId, agentId },
      );
      return;
    }

    // 3. Fetch the transcript so the human picking up has context.
    //    Vapi exposes structured turns under artifact.messages.
    let transcript = "";
    try {
      const t = await args.engine.getCallTranscript(args.callId, "plain");
      transcript = t.transcript ?? "";
    } catch (err) {
      ctx.logger.warn(
        "phone-tools: call.transferred — transcript fetch failed; posting issue without it",
        { callId: args.callId, err: (err as Error).message },
      );
    }

    // 4. Resolve the assistant's display name so the issue title reads
    //    like a sentence. Falls back to the agentId if the lookup fails.
    let assistantName = agentId;
    try {
      for (const companyId of args.companyIds) {
        const agent = await ctx.agents.get(agentId, companyId).catch(() => null);
        if (agent?.name) {
          assistantName = agent.name;
          break;
        }
      }
    } catch {
      // ignore
    }

    const title = `📞 ${assistantName} transferred a call to a human`;
    const description = buildTransferIssueDescription({
      destination: args.destination,
      reason: args.reason,
      durationSec: args.durationSec,
      endedAt: args.endedAt,
      transcript,
      callId: args.callId,
    });

    // 5. File the issue on the first company we have access to. For
    //    multi-company fan-out the event itself already fires per
    //    company; we only create one issue (whichever company owns the
    //    assistant's project). companyIds is the account's
    //    allowedCompanies — typically a single LLC per phone account
    //    anyway, so this is almost always single-element.
    for (const companyId of args.companyIds) {
      try {
        await ctx.issues.create({
          companyId,
          projectId,
          title,
          description,
          assigneeAgentId: config.transferIssueAssigneeAgentId,
          priority: "high",
          originKind: "plugin:phone-tools",
          originId: `transfer:${args.callId}`,
        });
        ctx.logger.info("phone-tools: warm-transfer issue created", {
          callId: args.callId,
          projectId,
          companyId,
        });
        return; // one issue per call regardless of how many companies the account allows
      } catch (err) {
        ctx.logger.warn(
          "phone-tools: warm-transfer issue creation failed for company; trying next",
          { callId: args.callId, companyId, err: (err as Error).message },
        );
      }
    }
  } catch (err) {
    ctx.logger.warn("phone-tools: postTransferBoardComment unexpected error", {
      callId: args.callId,
      err: (err as Error).message,
    });
  }
}

function buildTransferIssueDescription(args: {
  destination: string;
  reason: string | null;
  durationSec: number;
  endedAt: string;
  transcript: string;
  callId: string;
}): string {
  const TRANSCRIPT_MAX = 12_000;
  const transcript = args.transcript
    ? args.transcript.length > TRANSCRIPT_MAX
      ? args.transcript.slice(0, TRANSCRIPT_MAX) + "\n\n_…transcript truncated…_"
      : args.transcript
    : "_(transcript unavailable)_";

  const header = [
    `**Bridged to:** \`${args.destination}\``,
    args.reason ? `**AI's parting line:** ${args.reason}` : null,
    `**AI talked for:** ${args.durationSec}s before handoff`,
    `**Handoff at:** ${args.endedAt}`,
    `**Call ID:** \`${args.callId}\``,
  ]
    .filter(Boolean)
    .join("  \n");

  return `${header}\n\n---\n\n## Transcript so far\n\n${transcript}`;
}

// ─── Idempotency for outbound calls ────────────────────────────────────

async function findIdempotentCall(
  resolved: ResolvedAccount,
  idempotencyKey: string,
): Promise<{ callId: string } | null> {
  const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  try {
    const list = await resolved.engine.listCalls({
      since: sinceIso,
      direction: "outbound",
      limit: 100,
    });
    // Re-fetch each candidate and check metadata; engines may not surface
    // metadata in the list response so we check the detail.
    for (const summary of list.calls) {
      const status = await resolved.engine.getCallStatus(summary.callId);
      const meta =
        (status as unknown as { metadata?: Record<string, unknown> }).metadata ?? {};
      if (meta.paperclip_idem_key === idempotencyKey) {
        return { callId: status.callId };
      }
    }
  } catch {
    // Idempotency is best-effort; if listing fails, place the call.
  }
  return null;
}

// ─── Plugin definition ────────────────────────────────────────────────

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    webhookCtx = ctx;
    ctx.logger.info("phone-tools plugin setup");

    const rawConfig = (await ctx.config.get()) as InstanceConfig;
    const allowMutations = !!rawConfig.allowMutations;
    const accounts: ConfigAccount[] = rawConfig.accounts ?? [];

    if (accounts.length === 0) {
      ctx.logger.warn(
        "phone-tools: no accounts configured. Add them on /instance/settings/plugins/phone-tools.",
      );
    } else {
      const summary = accounts
        .map((a) => {
          const k = a.key ?? "(no-key)";
          const e = a.engine ?? "vapi";
          const allowed = a.allowedCompanies;
          const access =
            !allowed || allowed.length === 0
              ? "no companies — UNUSABLE"
              : allowed.includes("*")
                ? "portfolio-wide"
                : `${allowed.length} company(s)`;
          const verify = a.webhookSecretRef ? "signed" : "UNSIGNED webhooks";
          return `${k}[${e}, ${access}, ${verify}]`;
        })
        .join(", ");
      ctx.logger.info(
        `phone-tools: ready (mutations ${allowMutations ? "ENABLED" : "disabled"}). Accounts — ${summary}`,
      );

      const orphans = accounts.filter(
        (a) => !a.allowedCompanies || a.allowedCompanies.length === 0,
      );
      if (orphans.length > 0) {
        ctx.logger.warn(
          `phone-tools: ${orphans.length} account(s) have no allowedCompanies and will reject every call.`,
        );
      }

      const unsigned = accounts.filter((a) => !a.webhookSecretRef);
      if (unsigned.length > 0) {
        ctx.logger.warn(
          `phone-tools: ${unsigned.length} account(s) have no webhookSecretRef — webhooks for them will NOT be signature-verified. OK for local dev only.`,
        );
      }

      const wildcardWithWebhook = accounts.filter(
        (a) =>
          a.allowedCompanies?.includes("*") && (a.webhookSecretRef || true),
      );
      if (wildcardWithWebhook.length > 0) {
        ctx.logger.error(
          `phone-tools: ${wildcardWithWebhook.length} account(s) use allowedCompanies=['*'] (portfolio-wide). INBOUND WEBHOOKS WILL BE DROPPED for these accounts — narrow allowedCompanies to specific company UUIDs to enable inbound. (Outbound calls still work.) Affected accounts: ${wildcardWithWebhook.map((a) => a.key).join(", ")}.`,
        );
      }
    }

    // ─── UI getData handlers ──────────────────────────────────────────

    // Sidebar visibility: returns whether the calling company is in any
    // account's allowedCompanies list. The host UI component reads this
    // via usePluginData("assistants.sidebar-visible").
    ctx.data.register("assistants.sidebar-visible", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      const config = (await ctx.config.get()) as InstanceConfig;
      return computeSidebarVisibility(companyId, config.accounts ?? []);
    });

    // Phone tab visibility + summary on AgentDetail. Returns whether this
    // agent has role="assistant" and (if so) the saved phone config plus
    // today's spend window. The component renders nothing when isAssistant
    // is false — that's how we keep CEO/CFO tabs uncluttered.
    ctx.data.register("assistants.recent-calls", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      const agentId = typeof params.agentId === "string" ? params.agentId : null;
      if (!companyId || !agentId) return { calls: [] };
      const { readPhoneConfig } = await import("./assistants/cost-cap.js");
      const config = await readPhoneConfig(ctx, agentId);
      if (!config) return { calls: [] };
      try {
        const resolved = await getResolvedAccount(
          ctx,
          { agentId: "", runId: "data", companyId, projectId: "" } as ToolRunContext,
          "assistants-data",
          config.account,
        );
        const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const result = await resolved.engine.listCalls({
          since,
          direction: "outbound",
          limit: 25,
          assistantId: config.vapiAssistantId ?? undefined,
        });
        return { calls: result.calls };
      } catch (err) {
        ctx.logger.warn("phone-tools: recent-calls fetch failed", { err: (err as Error).message });
        return { calls: [], error: (err as Error).message };
      }
    });

    ctx.data.register("assistants.agent-phone-status", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      const agentId = typeof params.agentId === "string" ? params.agentId : null;
      if (!companyId || !agentId) {
        return { isAssistant: false, agent: null, config: null, today: null };
      }
      const agent = await ctx.agents.get(agentId, companyId).catch(() => null);
      if (!agent) {
        return { isAssistant: false, agent: null, config: null, today: null };
      }
      // String-cast: the "assistant" role lives in the host's @paperclipai/shared
      // but the plugin SDK's Agent type may pre-date it. Compare as a string so
      // we work across SDK versions.
      if (String(agent.role) !== "assistant") {
        return { isAssistant: false, agent: { id: agent.id, name: agent.name, role: String(agent.role) }, config: null, today: null };
      }
      const { readPhoneConfig, readCostWindow } = await import("./assistants/cost-cap.js");
      const config = await readPhoneConfig(ctx, agentId);
      const today = await readCostWindow(ctx, agentId);
      return {
        isAssistant: true,
        agent: { id: agent.id, name: agent.name, role: agent.role },
        config,
        today,
      };
    });

    // ─── Reads ─────────────────────────────────────────────────────────

    ctx.tools.register(
      "phone_call_status",
      {
        displayName: "Get phone call status",
        description: "Status (queued/ringing/in-progress/ended/etc.) plus duration, cost, end reason.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            callId: { type: "string" },
          },
          required: ["callId"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as { account?: string; callId?: string };
        if (!p.callId) return { error: "[EINVALID_INPUT] `callId` is required" };
        const r = await resolveOrError(ctx, runCtx, "phone_call_status", p.account);
        if (!r.ok) return { error: r.error };
        try {
          const status = await r.resolved.engine.getCallStatus(p.callId);
          // Release the concurrency slot if the engine reports a terminal
          // state — webhook may not be wired (operator opt-out for outbound-
          // only setups), so polling status is the alternate signal.
          if (
            status.status === "ended" ||
            status.status === "failed" ||
            status.status === "no-answer" ||
            status.status === "busy" ||
            status.status === "canceled"
          ) {
            untrackOutbound(p.callId);
            // Persist the call summary + emit cost telemetry — once per
            // call. Idempotent across both polling and webhook paths.
            const allowed = (r.resolved.account.allowedCompanies ?? []).filter(
              (c) => c && c !== "*",
            );
            const companyIds = allowed.length > 0 ? allowed : [runCtx.companyId];
            await recordTerminalCallIfNew(ctx, {
              callId: p.callId,
              accountKey: r.resolved.accountKey,
              engineKind: r.resolved.engine.engineKind,
              companyIds,
              status: status.status,
              direction: status.direction,
              from: status.from,
              to: status.to,
              startedAt: status.startedAt,
              endedAt: status.endedAt,
              durationSec: status.durationSec,
              costUsd: status.costUsd,
              endReason: status.endReason,
              runCtxForTelemetry: runCtx,
            });
          }
          await track(ctx, runCtx, "phone_call_status", r.resolved.accountKey, {
            callId: p.callId,
            status: status.status,
          });
          return {
            content: `Call ${p.callId}: ${status.status}.`,
            data: status,
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    ctx.tools.register(
      "phone_call_transcript",
      {
        displayName: "Get phone call transcript",
        description: "Dialog transcript. format='plain' or 'structured'.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            callId: { type: "string" },
            format: { type: "string", enum: ["plain", "structured"] },
          },
          required: ["callId"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as {
          account?: string;
          callId?: string;
          format?: "plain" | "structured";
        };
        if (!p.callId) return { error: "[EINVALID_INPUT] `callId` is required" };
        const r = await resolveOrError(ctx, runCtx, "phone_call_transcript", p.account);
        if (!r.ok) return { error: r.error };
        try {
          const transcript = await r.resolved.engine.getCallTranscript(
            p.callId,
            p.format ?? "plain",
          );
          await track(ctx, runCtx, "phone_call_transcript", r.resolved.accountKey, {
            callId: p.callId,
            length: transcript.transcript.length,
          });
          return {
            content: `Transcript for call ${p.callId} (${transcript.transcript.length} chars).`,
            data: transcript,
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    ctx.tools.register(
      "phone_call_recording_url",
      {
        displayName: "Get phone call recording URL",
        description: "Short-lived signed URL to the call audio.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            callId: { type: "string" },
            expiresInSec: { type: "number" },
          },
          required: ["callId"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as { account?: string; callId?: string; expiresInSec?: number };
        if (!p.callId) return { error: "[EINVALID_INPUT] `callId` is required" };
        const r = await resolveOrError(ctx, runCtx, "phone_call_recording_url", p.account);
        if (!r.ok) return { error: r.error };
        if (!r.resolved.account.recordingEnabled) {
          return {
            error: `[ERECORDING_DISABLED] account "${r.resolved.accountKey}" has recordingEnabled=false. Enable on /instance/settings/plugins/phone-tools.`,
          };
        }
        try {
          const out = await r.resolved.engine.getCallRecordingUrl(
            p.callId,
            p.expiresInSec ?? 3600,
          );
          await track(ctx, runCtx, "phone_call_recording_url", r.resolved.accountKey, {
            callId: p.callId,
          });
          return {
            content: `Recording URL for call ${p.callId} (expires ${out.expiresAt}).`,
            data: out,
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    ctx.tools.register(
      "phone_call_list",
      {
        displayName: "List phone calls",
        description: "List calls with optional filters.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            since: { type: "string" },
            until: { type: "string" },
            direction: { type: "string", enum: ["inbound", "outbound", "any"] },
            assistant: { type: "string" },
            status: { type: "string" },
            limit: { type: "number" },
            cursor: { type: "string" },
          },
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as {
          account?: string;
          since?: string;
          until?: string;
          direction?: "inbound" | "outbound" | "any";
          assistant?: string;
          status?: NormalizedCallStatus["status"];
          limit?: number;
          cursor?: string;
        };
        const r = await resolveOrError(ctx, runCtx, "phone_call_list", p.account);
        if (!r.ok) return { error: r.error };
        try {
          const out = await r.resolved.engine.listCalls({
            since: p.since,
            until: p.until,
            direction: p.direction,
            assistantId: p.assistant,
            status: p.status,
            limit: p.limit,
            cursor: p.cursor,
          });
          // Per-resource filter: drop calls whose number/assistant isn't
          // in this account's allow-lists, matching the per-company
          // isolation guarantee (an agent in company A shouldn't even
          // see calls placed under a number scoped to company B).
          const allowedNumbers = r.resolved.account.allowedNumbers ?? [];
          const allowedAssistants = r.resolved.account.allowedAssistants ?? [];
          const filtered = out.calls.filter((c) => {
            if (
              allowedNumbers.length > 0 &&
              c.numberId &&
              !allowedNumbers.includes(c.numberId)
            )
              return false;
            if (
              allowedAssistants.length > 0 &&
              c.assistantId &&
              !allowedAssistants.includes(c.assistantId)
            )
              return false;
            return true;
          });
          await track(ctx, runCtx, "phone_call_list", r.resolved.accountKey, {
            count: filtered.length,
          });
          return {
            content: `Found ${filtered.length} call(s).`,
            data: { calls: filtered, nextCursor: out.nextCursor },
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    ctx.tools.register(
      "phone_assistant_list",
      {
        displayName: "List phone assistants",
        description: "List configured assistants.",
        parametersSchema: {
          type: "object",
          properties: { account: { type: "string" } },
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as { account?: string };
        const r = await resolveOrError(ctx, runCtx, "phone_assistant_list", p.account);
        if (!r.ok) return { error: r.error };
        try {
          const list = await r.resolved.engine.listAssistants();
          const allow = r.resolved.account.allowedAssistants;
          const filtered =
            allow && allow.length > 0
              ? list.filter((a) => allow.includes(a.id))
              : list;
          await track(ctx, runCtx, "phone_assistant_list", r.resolved.accountKey, {
            count: filtered.length,
          });
          return {
            content: `Found ${filtered.length} assistant(s) on ${r.resolved.accountKey}.`,
            data: { assistants: filtered },
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    ctx.tools.register(
      "phone_number_list",
      {
        displayName: "List phone numbers",
        description: "List engine-side phone numbers.",
        parametersSchema: {
          type: "object",
          properties: { account: { type: "string" } },
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as { account?: string };
        const r = await resolveOrError(ctx, runCtx, "phone_number_list", p.account);
        if (!r.ok) return { error: r.error };
        try {
          const list = await r.resolved.engine.listNumbers();
          const allow = r.resolved.account.allowedNumbers;
          const filtered =
            allow && allow.length > 0
              ? list.filter((n) => allow.includes(n.id))
              : list;
          await track(ctx, runCtx, "phone_number_list", r.resolved.accountKey, {
            count: filtered.length,
          });
          return {
            content: `Found ${filtered.length} number(s) on ${r.resolved.accountKey}.`,
            data: { numbers: filtered },
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    // ─── Mutations (gated) ─────────────────────────────────────────────

    // Read fresh on every call so toggling allowMutations on the settings
    // page takes effect without a worker restart. Cost: one config read
    // per mutation tool call. ctx.config.get() is in-memory after the
    // first hit so this is essentially free.
    async function gateMutation(tool: string): Promise<{ error: string } | null> {
      const cfg = (await ctx.config.get()) as InstanceConfig;
      if (cfg.allowMutations) return null;
      return {
        error: `[EDISABLED] ${tool} is disabled. Enable 'Allow place-call / hangup / assistant mutations' on /instance/settings/plugins/phone-tools.`,
      };
    }

    ctx.tools.register(
      "phone_call_make",
      {
        displayName: "Place outbound phone call",
        description: "Place an AI-driven outbound call.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            to: { type: "string" },
            from: { type: "string" },
            assistant: {},
            metadata: { type: "object" },
            idempotencyKey: { type: "string" },
          },
          required: ["to"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const gate = await gateMutation("phone_call_make");
        if (gate) return gate;

        const p = params as {
          account?: string;
          to?: string;
          from?: string;
          assistant?: string | AssistantConfig;
          metadata?: Record<string, unknown>;
          idempotencyKey?: string;
        };
        if (!p.to) return { error: "[EINVALID_INPUT] `to` is required" };

        const r = await resolveOrError(ctx, runCtx, "phone_call_make", p.account);
        if (!r.ok) return { error: r.error };

        // Resolve assistant: explicit param takes precedence, otherwise fall
        // back to defaultAssistantId on the account. If neither is set, fail
        // clearly — we have no way to drive the call.
        const assistantSpec: string | AssistantConfig | undefined =
          p.assistant ?? r.resolved.account.defaultAssistantId ?? undefined;
        if (!assistantSpec) {
          return {
            error:
              "[EINVALID_INPUT] `assistant` is required (no `defaultAssistantId` configured on the account).",
          };
        }

        try {
          // Per-resource enforcement on top of account allowedCompanies.
          const numberId = resolveNumberId(r.resolved, p.from);
          if (typeof assistantSpec === "string") {
            assertAssistantAllowed(r.resolved, assistantSpec);
          } else {
            // Inline assistant — refused if account locks down assistants.
            const allow = r.resolved.account.allowedAssistants;
            if (allow && allow.length > 0) {
              return {
                error: `[EASSISTANT_NOT_ALLOWED] account "${r.resolved.accountKey}" has allowedAssistants set; inline assistants are not permitted. Pass an assistant ID instead.`,
              };
            }
          }

          // Idempotency check before the concurrency check — if we'd
          // dedupe the call, it doesn't count against the cap.
          if (p.idempotencyKey) {
            const existing = await findIdempotentCall(
              r.resolved,
              p.idempotencyKey,
            );
            if (existing) {
              await track(ctx, runCtx, "phone_call_make", r.resolved.accountKey, {
                deduped: true,
                callId: existing.callId,
              });
              return {
                content: `Idempotent: returning existing call ${existing.callId}.`,
                data: { callId: existing.callId, deduped: true },
              };
            }
          }

          checkConcurrencyLimit(r.resolved);

          const start = await r.resolved.engine.startOutboundCall({
            to: p.to,
            numberId,
            assistant: assistantSpec,
            metadata: p.metadata,
            idempotencyKey: p.idempotencyKey,
          });
          trackOutbound(r.resolved.accountKey, start.callId);
          await track(ctx, runCtx, "phone_call_make", r.resolved.accountKey, {
            callId: start.callId,
            to: p.to,
          });
          return {
            content: `Placed outbound call ${start.callId} → ${p.to} (${start.status}).`,
            data: start,
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    ctx.tools.register(
      "phone_call_end",
      {
        displayName: "End phone call",
        description: "Force-end an active call.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            callId: { type: "string" },
            reason: { type: "string" },
          },
          required: ["callId"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const gate = await gateMutation("phone_call_end");
        if (gate) return gate;

        const p = params as { account?: string; callId?: string; reason?: string };
        if (!p.callId) return { error: "[EINVALID_INPUT] `callId` is required" };

        const r = await resolveOrError(ctx, runCtx, "phone_call_end", p.account);
        if (!r.ok) return { error: r.error };

        try {
          await r.resolved.engine.endCall(p.callId, p.reason);
          untrackOutbound(p.callId);
          await track(ctx, runCtx, "phone_call_end", r.resolved.accountKey, {
            callId: p.callId,
            reason: p.reason ?? null,
          });
          return {
            content: `Ended call ${p.callId}.`,
            data: { callId: p.callId, ok: true },
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    ctx.tools.register(
      "phone_assistant_create",
      {
        displayName: "Create phone assistant",
        description: "Create a new named assistant.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            name: { type: "string" },
            systemPrompt: { type: "string" },
            firstMessage: { type: "string" },
            voice: { type: "string" },
            model: { type: "string" },
            tools: { type: "array", items: { type: "string" } },
            voicemailMessage: { type: "string" },
            transferTarget: { type: "string" },
            transferMessage: { type: "string" },
            idempotencyKey: { type: "string" },
          },
          required: ["name", "systemPrompt"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const gate = await gateMutation("phone_assistant_create");
        if (gate) return gate;

        const p = params as {
          account?: string;
          name?: string;
          systemPrompt?: string;
          firstMessage?: string;
          voice?: string;
          model?: string;
          tools?: string[];
          voicemailMessage?: string;
          transferTarget?: string;
          transferMessage?: string;
          idempotencyKey?: string;
        };
        if (!p.name) return { error: "[EINVALID_INPUT] `name` is required" };
        if (!p.systemPrompt)
          return { error: "[EINVALID_INPUT] `systemPrompt` is required" };

        const r = await resolveOrError(
          ctx,
          runCtx,
          "phone_assistant_create",
          p.account,
        );
        if (!r.ok) return { error: r.error };

        try {
          // Idempotency by name within account.
          const existing = await r.resolved.engine.listAssistants();
          const dup = existing.find(
            (a) => a.name.toLowerCase() === p.name!.toLowerCase(),
          );
          if (dup) {
            await track(ctx, runCtx, "phone_assistant_create", r.resolved.accountKey, {
              deduped: true,
              assistantId: dup.id,
            });
            return {
              content: `Assistant named "${p.name}" already exists (id ${dup.id}).`,
              data: { assistantId: dup.id, deduped: true, assistant: dup },
            };
          }

          const created = await r.resolved.engine.createAssistant({
            name: p.name,
            systemPrompt: p.systemPrompt,
            firstMessage: p.firstMessage,
            voice: p.voice,
            model: p.model,
            tools: p.tools,
            voicemailMessage: p.voicemailMessage,
            transferTarget: p.transferTarget,
            transferMessage: p.transferMessage,
          });
          await track(ctx, runCtx, "phone_assistant_create", r.resolved.accountKey, {
            assistantId: created.id,
          });
          return {
            content: `Created assistant ${created.id} ("${created.name}").`,
            data: { assistantId: created.id, assistant: created },
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    ctx.tools.register(
      "phone_assistant_update",
      {
        displayName: "Update phone assistant",
        description: "Patch an existing assistant.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            assistantId: { type: "string" },
            name: { type: "string" },
            systemPrompt: { type: "string" },
            firstMessage: { type: "string" },
            voice: { type: "string" },
            model: { type: "string" },
            tools: { type: "array", items: { type: "string" } },
            voicemailMessage: { type: "string" },
            transferTarget: { type: "string" },
            transferMessage: { type: "string" },
          },
          required: ["assistantId"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const gate = await gateMutation("phone_assistant_update");
        if (gate) return gate;

        const p = params as {
          account?: string;
          assistantId?: string;
          name?: string;
          systemPrompt?: string;
          firstMessage?: string;
          voice?: string;
          model?: string;
          tools?: string[];
          voicemailMessage?: string;
          transferTarget?: string;
          transferMessage?: string;
        };
        if (!p.assistantId)
          return { error: "[EINVALID_INPUT] `assistantId` is required" };

        const r = await resolveOrError(
          ctx,
          runCtx,
          "phone_assistant_update",
          p.account,
        );
        if (!r.ok) return { error: r.error };

        try {
          assertAssistantAllowed(r.resolved, p.assistantId);
          // Build a true partial: only include fields the operator explicitly
          // sent. The engine's `mapAssistantConfigToVapi(cfg, partial=true)`
          // path then leaves untouched fields alone on the Vapi side.
          const patch: Partial<AssistantConfig> = {};
          if (p.name !== undefined) patch.name = p.name;
          if (p.systemPrompt !== undefined) patch.systemPrompt = p.systemPrompt;
          if (p.firstMessage !== undefined) patch.firstMessage = p.firstMessage;
          if (p.voice !== undefined) patch.voice = p.voice;
          if (p.model !== undefined) patch.model = p.model;
          if (p.tools !== undefined) patch.tools = p.tools;
          if (p.voicemailMessage !== undefined) patch.voicemailMessage = p.voicemailMessage;
          if (p.transferTarget !== undefined) patch.transferTarget = p.transferTarget;
          if (p.transferMessage !== undefined) patch.transferMessage = p.transferMessage;
          const updated = await r.resolved.engine.updateAssistant(p.assistantId, patch);
          await track(ctx, runCtx, "phone_assistant_update", r.resolved.accountKey, {
            assistantId: p.assistantId,
          });
          return {
            content: `Updated assistant ${p.assistantId}.`,
            data: { assistant: updated },
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    ctx.tools.register(
      "phone_assistant_delete",
      {
        displayName: "Delete phone assistant",
        description: "Remove an assistant.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            assistantId: { type: "string" },
          },
          required: ["assistantId"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const gate = await gateMutation("phone_assistant_delete");
        if (gate) return gate;

        const p = params as { account?: string; assistantId?: string };
        if (!p.assistantId)
          return { error: "[EINVALID_INPUT] `assistantId` is required" };

        const r = await resolveOrError(
          ctx,
          runCtx,
          "phone_assistant_delete",
          p.account,
        );
        if (!r.ok) return { error: r.error };

        try {
          assertAssistantAllowed(r.resolved, p.assistantId);
          await r.resolved.engine.deleteAssistant(p.assistantId);
          await track(ctx, runCtx, "phone_assistant_delete", r.resolved.accountKey, {
            assistantId: p.assistantId,
          });
          return {
            content: `Deleted assistant ${p.assistantId}.`,
            data: { assistantId: p.assistantId, ok: true },
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    ctx.logger.info("phone-tools: tool registration complete");
  },

  /**
   * Webhook dispatcher. Routes by endpointKey (vapi / diy), asks each
   * matching engine to parse + verify, then emits the normalized event.
   *
   * Companies: an inbound event is fanned out to every company in the
   * account's allowedCompanies list. ['*'] portfolio-wide accounts are
   * NOT fanned out (we'd have no obvious target); we log a warning so
   * the operator narrows the allow-list before relying on inbound.
   */
  async onWebhook(input): Promise<void> {
    // The host treats `onWebhook` as fire-and-forget (returns void). We
    // log diagnostics for failures rather than HTTP-shaping responses.
    const endpointKey = input.endpointKey;

    if (endpointKey === "diy") {
      // Reserved for v0.2.0 — accept silently so Jambonz doesn't retry.
      return;
    }

    if (endpointKey !== "vapi") {
      webhookLogger.warn("phone-tools webhook: unknown endpoint", { endpointKey });
      return;
    }

    const candidates = await getEnginesForEndpoint(webhookCtx, endpointKey);
    if (candidates.length === 0) {
      webhookLogger.warn("phone-tools webhook: no accounts for endpoint", {
        endpointKey,
      });
      return;
    }

    const headers = normalizeHeaders(input.headers);
    const rawBody = input.rawBody ?? "";
    const parsedBody =
      input.parsedBody !== undefined
        ? input.parsedBody
        : safeJsonParse(rawBody);

    let claimed: typeof candidates[number] | null = null;
    let event: NormalizedPhoneEvent | null = null;

    for (const candidate of candidates) {
      try {
        const parsed = await candidate.engine.parseWebhook({
          endpointKey,
          body: parsedBody,
          headers,
          rawBody,
        });
        if (parsed) {
          claimed = candidate;
          event = parsed;
          break;
        }
      } catch (err) {
        webhookLogger.warn("phone-tools webhook: parser threw", {
          accountKey: candidate.accountKey,
          err: (err as Error).message,
        });
      }
    }

    if (!claimed || !event) {
      // No engine could verify the signature. We swallow rather than
      // surface a 401 (which would leak which secret to attack against).
      webhookLogger.warn(
        "phone-tools webhook: no engine claimed (signature mismatch?)",
      );
      return;
    }

    const allowedCompanies = claimed.account.allowedCompanies ?? [];
    if (allowedCompanies.length === 0) {
      webhookLogger.warn("phone-tools webhook: account has no allowedCompanies", {
        accountKey: claimed.accountKey,
        eventKind: event.kind,
      });
      return;
    }
    if (allowedCompanies.includes("*")) {
      // ERROR-level — this almost always signals operator misconfiguration:
      // the account is set up for inbound webhooks but the allow-list is
      // portfolio-wide, so we have no specific company to dispatch the event
      // to. The setup() startup log already flags this; logging again here
      // makes the runtime impact visible in the health dashboard.
      webhookCtx?.logger?.error?.(
        "phone-tools webhook: account uses allowedCompanies=['*'] portfolio-wide — DROPPING inbound event. Narrow allowedCompanies to specific company UUIDs to enable inbound.",
        { accountKey: claimed.accountKey, eventKind: event.kind },
      );
      return;
    }

    const companyTargets = allowedCompanies.filter((c) => c && c !== "*");

    for (const companyId of companyTargets) {
      try {
        await webhookCtx.events.emit(
          `call.${event.kind.replace(/^call\./, "")}`,
          companyId,
          {
            ...event,
            accountKey: claimed.accountKey,
            engine: claimed.engine.engineKind,
          },
        );
      } catch (err) {
        webhookLogger.warn("phone-tools webhook: emit failed", {
          companyId,
          eventKind: event.kind,
          err: (err as Error).message,
        });
      }
    }

    // Side effects on call lifecycle events
    if (event.kind === "call.ended") {
      untrackOutbound(event.callId);
      // Persist + emit cost telemetry through the shared helper so we
      // dedup against any polling-based observation that may have
      // already recorded this call. First-to-arrive wins.
      await recordTerminalCallIfNew(webhookCtx, {
        callId: event.callId,
        accountKey: claimed.accountKey,
        engineKind: claimed.engine.engineKind,
        companyIds: companyTargets,
        status: "ended",
        direction: null,
        from: null,
        to: null,
        startedAt: null,
        endedAt: event.endedAt,
        durationSec: event.durationSec,
        costUsd: event.costUsd ?? null,
        endReason: event.endReason,
        runCtxForTelemetry: null,
      });
    }

    // A transfer is also a terminal state for the AI leg — the SIP
    // bridge happens engine-side and the AI is no longer driving the
    // conversation. Run the same bookkeeping AND post a board comment
    // so the human picking up has the transcript-so-far + the AI's
    // stated handoff line.
    if (event.kind === "call.transferred") {
      untrackOutbound(event.callId);
      await recordTerminalCallIfNew(webhookCtx, {
        callId: event.callId,
        accountKey: claimed.accountKey,
        engineKind: claimed.engine.engineKind,
        companyIds: companyTargets,
        status: "ended",
        direction: null,
        from: null,
        to: null,
        startedAt: null,
        endedAt: event.endedAt,
        durationSec: event.durationSec,
        costUsd: event.costUsd ?? null,
        endReason: `transferred:${event.destination}`,
        runCtxForTelemetry: null,
      });
      // Fire-and-forget — failing to post the board comment shouldn't
      // block telemetry or the rest of the dispatch.
      void postTransferBoardComment(webhookCtx, {
        accountKey: claimed.accountKey,
        callId: event.callId,
        destination: event.destination,
        reason: event.reason,
        endedAt: event.endedAt,
        durationSec: event.durationSec,
        companyIds: companyTargets,
        engine: claimed.engine,
      });
    }
  },

  /**
   * Operator changed plugin config on the settings page (added/removed
   * accounts, edited allowedCompanies, swapped a secret-ref, etc.).
   * Drop the engine cache so the next tool call rebuilds against the
   * fresh config — no worker restart needed.
   *
   * `allowMutations` is read fresh inside `gateMutation` on every call,
   * so it doesn't depend on this hook.
   */
  async onConfigChanged(_newConfig: Record<string, unknown>): Promise<void> {
    clearEngineCache();
    webhookCtx?.logger?.info?.(
      "phone-tools: config changed — engine cache cleared",
    );
  },

  async onApiRequest(input: PluginApiRequestInput): Promise<PluginApiResponse> {
    if (!webhookCtx) {
      return { status: 503, body: { error: "phone-tools worker not initialised yet" } };
    }
    const ctx = webhookCtx;
    const handlers = [handleAssistantsApi, handleOperatorPhoneApi];
    for (const handle of handlers) {
      const result = await handle(ctx, input);
      if (result) return result;
    }
    return { status: 404, body: { error: `Unknown plugin route: ${input.routeKey}` } };
  },

  async onHealth() {
    return { status: "ok", message: "phone-tools ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);

// Keep helpers referenced for downstream consumers / tests.
void isCompanyAllowed;
