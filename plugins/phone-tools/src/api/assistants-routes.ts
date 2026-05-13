import type {
  PluginApiRequestInput,
  PluginApiResponse,
  PluginContext,
  ToolRunContext,
} from "@paperclipai/plugin-sdk";
import {
  composeAssistant,
  type AssistantWizardAnswers,
} from "../assistants/compose.js";
import {
  assertWithinCap,
  readCostWindow,
  readPhoneConfig,
  writePhoneConfig,
  DEFAULT_DAILY_CAP_USD,
  type PhoneConfig,
} from "../assistants/cost-cap.js";
import { getResolvedAccount } from "../engines/registry.js";
import type { AssistantConfig, ResolvedAccount } from "../engines/types.js";

function ok(body: unknown): PluginApiResponse {
  return { status: 200, body };
}

function created(body: unknown): PluginApiResponse {
  return { status: 201, body };
}

function badRequest(message: string): PluginApiResponse {
  return { status: 400, body: { error: message } };
}

function notFound(message: string): PluginApiResponse {
  return { status: 404, body: { error: message } };
}

function serverError(message: string): PluginApiResponse {
  return { status: 500, body: { error: message } };
}

function syntheticToolRunCtx(input: PluginApiRequestInput): ToolRunContext {
  return {
    agentId: input.actor.agentId ?? "",
    runId: input.actor.runId ?? "api-route",
    companyId: input.companyId,
    projectId: "",
  };
}

async function resolveAccountFor(
  ctx: PluginContext,
  input: PluginApiRequestInput,
  accountKey?: string,
): Promise<ResolvedAccount> {
  return getResolvedAccount(
    ctx,
    syntheticToolRunCtx(input),
    "assistants-api",
    accountKey,
  );
}

function readBodyAsObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  return body as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Three-state read for optional config fields where the operator may
 * want to clear (empty string) vs. leave-untouched (field absent).
 *
 * - `undefined` — field not present in the request body; preserve any
 *   existing stored value (don't overwrite).
 * - `""`         — field present and empty; the operator is explicitly
 *   clearing the stored value.
 * - `"..."`      — field present with a non-empty value to store.
 *
 * `asString` collapses the first two into `undefined`, which is fine
 * for required fields but wrong for clearable optional ones.
 */
function asOptionalRawString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asWizardAnswers(value: unknown): AssistantWizardAnswers | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.name !== "string") return null;
  return {
    type: v.type === "ea" || v.type === "custom" ? v.type : "ea",
    name: typeof v.name === "string" ? v.name : "",
    principal: typeof v.principal === "string" ? v.principal : "",
    tasks: Array.isArray(v.tasks) ? v.tasks.filter((t): t is string => typeof t === "string") : [],
    customTasks: typeof v.customTasks === "string" ? v.customTasks : "",
    phoneEnabled: v.phoneEnabled !== false,
    voice: typeof v.voice === "string" ? v.voice : "alloy",
    callerIdNumberId: typeof v.callerIdNumberId === "string" ? v.callerIdNumberId : "",
  };
}

export async function handleAssistantsApi(
  ctx: PluginContext,
  input: PluginApiRequestInput,
): Promise<PluginApiResponse | null> {
  switch (input.routeKey) {
    case "assistants.compose-preview":
      return composePreview(input);
    case "assistants.phone-config.get":
      return getPhoneConfig(ctx, input);
    case "assistants.phone-config.set":
      return setPhoneConfig(ctx, input);
    case "assistants.phone-config.test":
      return placeTestCall(ctx, input);
    case "assistants.calls.list":
      return listCalls(ctx, input);
    case "assistants.calls.place":
      return placeCall(ctx, input);
    case "assistants.calls.status":
      return getCallStatus(ctx, input);
    case "assistants.calls.transcript":
      return getCallTranscript(ctx, input);
    case "assistants.calls.recording":
      return getCallRecordingUrl(ctx, input);
    case "accounts.numbers":
      return listNumbers(ctx, input);
    default:
      return null;
  }
}

async function getCallStatus(
  ctx: PluginContext,
  input: PluginApiRequestInput,
): Promise<PluginApiResponse> {
  const agentId = input.params.agentId;
  const callId = input.params.callId;
  if (!agentId || !callId) return badRequest("Missing agentId or callId.");
  const config = await readPhoneConfig(ctx, agentId);
  if (!config) return notFound("Assistant has no phone config.");
  let resolved: ResolvedAccount;
  try {
    resolved = await resolveAccountFor(ctx, input, config.account);
  } catch (err) {
    return badRequest((err as Error).message);
  }
  try {
    const status = await resolved.engine.getCallStatus(callId);
    return ok({ status });
  } catch (err) {
    return serverError((err as Error).message);
  }
}

async function getCallTranscript(
  ctx: PluginContext,
  input: PluginApiRequestInput,
): Promise<PluginApiResponse> {
  const agentId = input.params.agentId;
  const callId = input.params.callId;
  if (!agentId || !callId) return badRequest("Missing agentId or callId.");
  const config = await readPhoneConfig(ctx, agentId);
  if (!config) return notFound("Assistant has no phone config.");
  let resolved: ResolvedAccount;
  try {
    resolved = await resolveAccountFor(ctx, input, config.account);
  } catch (err) {
    return badRequest((err as Error).message);
  }
  try {
    const transcript = await resolved.engine.getCallTranscript(callId, "structured");
    return ok({ transcript });
  } catch (err) {
    return serverError((err as Error).message);
  }
}

async function getCallRecordingUrl(
  ctx: PluginContext,
  input: PluginApiRequestInput,
): Promise<PluginApiResponse> {
  const agentId = input.params.agentId;
  const callId = input.params.callId;
  if (!agentId || !callId) return badRequest("Missing agentId or callId.");
  const config = await readPhoneConfig(ctx, agentId);
  if (!config) return notFound("Assistant has no phone config.");
  let resolved: ResolvedAccount;
  try {
    resolved = await resolveAccountFor(ctx, input, config.account);
  } catch (err) {
    return badRequest((err as Error).message);
  }
  try {
    const result = await resolved.engine.getCallRecordingUrl(callId, 3600);
    return ok(result);
  } catch (err) {
    return serverError((err as Error).message);
  }
}

function composePreview(input: PluginApiRequestInput): PluginApiResponse {
  const body = readBodyAsObject(input.body);
  const answers = asWizardAnswers(body.answers);
  if (!answers) return badRequest("Missing or invalid 'answers' payload.");
  const composed = composeAssistant(answers);
  return ok(composed);
}

async function getPhoneConfig(
  ctx: PluginContext,
  input: PluginApiRequestInput,
): Promise<PluginApiResponse> {
  const agentId = input.params.agentId;
  if (!agentId) return badRequest("Missing agentId.");
  const config = await readPhoneConfig(ctx, agentId);
  const window = await readCostWindow(ctx, agentId);
  return ok({ config, today: window });
}

async function setPhoneConfig(
  ctx: PluginContext,
  input: PluginApiRequestInput,
): Promise<PluginApiResponse> {
  const agentId = input.params.agentId;
  if (!agentId) return badRequest("Missing agentId.");
  const body = readBodyAsObject(input.body);
  const voice = asString(body.voice);
  const callerIdNumberId = asString(body.callerIdNumberId);
  const accountKey = asString(body.account);
  const enabled = body.enabled !== false;
  const costCapDailyUsd = typeof body.costCapDailyUsd === "number" && Number.isFinite(body.costCapDailyUsd)
    ? Math.max(0, body.costCapDailyUsd)
    : DEFAULT_DAILY_CAP_USD;
  const wizardAnswers = asWizardAnswers(body.wizardAnswers);
  const firstMessage = asString(body.firstMessage);
  const systemPromptOverride = asString(body.systemPrompt);
  // Warm-transfer destination (E.164) — when set, the engine injects a
  // transferCall tool and the AI can hand the leg off to a human.
  // Stored as part of the assistant's phone config so it's editable
  // per-assistant without touching plugin-level settings.
  //
  // Read each transfer field as a *raw* optional string: distinguishing
  // "field absent" (preserve existing) from "field present but empty"
  // (clear existing) lets the UI clear a destination without resetting
  // every other field on the config.
  const transferTargetRaw = asOptionalRawString(body.transferTarget);
  const transferMessageRaw = asOptionalRawString(body.transferMessage);
  const transferIssueProjectIdRaw = asOptionalRawString(body.transferIssueProjectId);
  const transferIssueAssigneeAgentIdRaw = asOptionalRawString(body.transferIssueAssigneeAgentId);

  if (!voice || !callerIdNumberId) {
    return badRequest("voice and callerIdNumberId are required.");
  }

  // The wizard sends bare OpenAI voice IDs (alloy/echo/shimmer/onyx/etc.)
  // The engine expects `provider:voiceId`. Prepend `openai:` when the
  // operator's voice id matches a known OpenAI voice and isn't already
  // qualified with a provider prefix.
  const OPENAI_VOICE_IDS = new Set([
    "alloy", "ash", "ballad", "coral", "echo", "fable",
    "nova", "onyx", "sage", "shimmer", "verse",
  ]);
  const qualifiedVoice = voice.includes(":")
    ? voice
    : OPENAI_VOICE_IDS.has(voice.toLowerCase())
      ? `openai:${voice}`
      : voice;

  // Look up the agent's name to use as the engine-side assistant name.
  const agent = await ctx.agents.get(agentId, input.companyId).catch(() => null);
  if (!agent) return notFound("Agent not found in this company.");

  // Compose a system prompt from wizard answers if one wasn't passed in.
  const composed = wizardAnswers ? composeAssistant(wizardAnswers) : null;
  const systemPrompt = systemPromptOverride
    ?? composed?.systemPrompt
    ?? `You are ${agent.name}, an AI assistant. Keep calls short and polite.`;
  const finalFirstMessage = firstMessage
    ?? composed?.firstMessage
    ?? `Hi, this is ${agent.name}.`;

  let resolved: ResolvedAccount;
  try {
    resolved = await resolveAccountFor(ctx, input, accountKey);
  } catch (err) {
    return badRequest((err as Error).message);
  }

  const existing = await readPhoneConfig(ctx, agentId);
  const assistantName = `${agent.name} (${agentId.slice(0, 8)})`;
  let vapiAssistantId = existing?.vapiAssistantId ?? null;

  // Resolve the effective transferTarget that will be sent to the
  // engine on this save. If the request body explicitly sent the field,
  // use what it sent (empty string clears). If it omitted the field,
  // preserve whatever was previously stored. We do this BEFORE building
  // the AssistantConfig so the engine projection picks up the right
  // transferCall tool injection on the very first save.
  const existingForTransfer = await readPhoneConfig(ctx, agentId);
  const effectiveTransferTarget =
    transferTargetRaw !== undefined
      ? transferTargetRaw.trim() || undefined
      : existingForTransfer?.transferTarget;
  const effectiveTransferMessage =
    transferMessageRaw !== undefined
      ? transferMessageRaw.trim() || undefined
      : existingForTransfer?.transferMessage;

  const assistantConfig: AssistantConfig = {
    name: assistantName,
    systemPrompt,
    firstMessage: finalFirstMessage,
    voice: qualifiedVoice,
    transferTarget: effectiveTransferTarget,
    transferMessage: effectiveTransferMessage,
  };

  try {
    if (vapiAssistantId) {
      const updated = await resolved.engine.updateAssistant(vapiAssistantId, assistantConfig);
      vapiAssistantId = updated.id;
    } else {
      const createdAssistant = await resolved.engine.createAssistant(assistantConfig);
      vapiAssistantId = createdAssistant.id;
    }
  } catch (err) {
    return serverError(`Failed to mirror assistant onto engine: ${(err as Error).message}`);
  }

  const next: PhoneConfig = {
    ...(existing ?? {}),
    voice,
    callerIdNumberId,
    costCapDailyUsd,
    enabled,
    vapiAssistantId: vapiAssistantId ?? undefined,
    firstMessage: finalFirstMessage,
    systemPrompt,
    account: resolved.accountKey,
    wizardAnswers: wizardAnswers ? (wizardAnswers as unknown as Record<string, unknown>) : existing?.wizardAnswers,
    // Warm-transfer fields. Three-state semantics: field absent in
    // request → preserve; empty string → clear; non-empty → store.
    transferTarget: effectiveTransferTarget,
    transferMessage: effectiveTransferMessage,
    transferIssueProjectId:
      transferIssueProjectIdRaw !== undefined
        ? transferIssueProjectIdRaw.trim() || undefined
        : existing?.transferIssueProjectId,
    transferIssueAssigneeAgentId:
      transferIssueAssigneeAgentIdRaw !== undefined
        ? transferIssueAssigneeAgentIdRaw.trim() || undefined
        : existing?.transferIssueAssigneeAgentId,
  };
  await writePhoneConfig(ctx, agentId, next);
  return ok({ config: next });
}

async function placeTestCall(
  ctx: PluginContext,
  input: PluginApiRequestInput,
): Promise<PluginApiResponse> {
  const agentId = input.params.agentId;
  if (!agentId) return badRequest("Missing agentId.");
  const body = readBodyAsObject(input.body);
  const to = asString(body.to);
  if (!to) return badRequest("Missing 'to' phone number.");

  const config = await readPhoneConfig(ctx, agentId);
  if (!config?.vapiAssistantId) {
    return badRequest("Assistant has no engine-side projection. Save phone config first.");
  }

  try {
    await assertWithinCap(ctx, agentId);
  } catch (err) {
    return { status: 429, body: { error: (err as Error).message } };
  }

  let resolved: ResolvedAccount;
  try {
    resolved = await resolveAccountFor(ctx, input, config.account);
  } catch (err) {
    return badRequest((err as Error).message);
  }

  try {
    const result = await resolved.engine.startOutboundCall({
      to,
      numberId: config.callerIdNumberId,
      assistant: config.vapiAssistantId,
      metadata: { paperclip_assistant_id: agentId, paperclip_test_call: "true" },
    });
    await ctx.state.set(
      { scopeKind: "instance", stateKey: `call-agent:${result.callId}` },
      agentId,
    );
    return created({ callId: result.callId, status: result.status });
  } catch (err) {
    return serverError(`Failed to start test call: ${(err as Error).message}`);
  }
}

async function listCalls(
  ctx: PluginContext,
  input: PluginApiRequestInput,
): Promise<PluginApiResponse> {
  const agentId = input.params.agentId;
  if (!agentId) return badRequest("Missing agentId.");
  const config = await readPhoneConfig(ctx, agentId);
  if (!config) return ok({ calls: [] });

  let resolved: ResolvedAccount;
  try {
    resolved = await resolveAccountFor(ctx, input, config.account);
  } catch (err) {
    return badRequest((err as Error).message);
  }

  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const list = await resolved.engine.listCalls({
      since,
      direction: "outbound",
      limit: 25,
      assistantId: config.vapiAssistantId ?? undefined,
    });
    return ok({ calls: list.calls, nextCursor: list.nextCursor ?? null });
  } catch (err) {
    return serverError(`Failed to list calls: ${(err as Error).message}`);
  }
}

async function placeCall(
  ctx: PluginContext,
  input: PluginApiRequestInput,
): Promise<PluginApiResponse> {
  const agentId = input.params.agentId;
  if (!agentId) return badRequest("Missing agentId.");
  const body = readBodyAsObject(input.body);
  const to = asString(body.to);
  if (!to) return badRequest("Missing 'to' phone number.");
  const objective = asString(body.objective);

  const config = await readPhoneConfig(ctx, agentId);
  if (!config?.vapiAssistantId) {
    return badRequest("Assistant has no engine-side projection. Save phone config first.");
  }

  try {
    await assertWithinCap(ctx, agentId);
  } catch (err) {
    return { status: 429, body: { error: (err as Error).message } };
  }

  let resolved: ResolvedAccount;
  try {
    resolved = await resolveAccountFor(ctx, input, config.account);
  } catch (err) {
    return badRequest((err as Error).message);
  }

  try {
    const result = await resolved.engine.startOutboundCall({
      to,
      numberId: config.callerIdNumberId,
      assistant: config.vapiAssistantId,
      metadata: {
        paperclip_assistant_id: agentId,
        paperclip_objective: objective ?? "",
        paperclip_callee_name: asString(body.calleeName) ?? "",
      },
    });
    await ctx.state.set(
      { scopeKind: "instance", stateKey: `call-agent:${result.callId}` },
      agentId,
    );
    return created({ callId: result.callId, status: result.status });
  } catch (err) {
    return serverError(`Failed to start call: ${(err as Error).message}`);
  }
}

async function listNumbers(
  ctx: PluginContext,
  input: PluginApiRequestInput,
): Promise<PluginApiResponse> {
  let resolved: ResolvedAccount;
  try {
    resolved = await resolveAccountFor(ctx, input, undefined);
  } catch (err) {
    return badRequest((err as Error).message);
  }
  try {
    const numbers = await resolved.engine.listNumbers();
    const allow = resolved.account.allowedNumbers;
    const filtered = !allow || allow.length === 0
      ? numbers
      : numbers.filter((n) => allow.includes(n.id));
    return ok({ numbers: filtered });
  } catch (err) {
    return serverError(`Failed to list numbers: ${(err as Error).message}`);
  }
}
