/**
 * DIY phone engine — implements `PhoneEngine` against a Jambonz install
 * plus a provider-neutral LLM client (Anthropic or OpenAI).
 *
 * v0.6.0 scope:
 *   - Outbound calls work end-to-end (start via Jambonz REST, drive turn-by-
 *     turn conversation via the application-hook protocol, force-end).
 *   - Inbound calls work — a Jambonz route directs the incoming call to the
 *     plugin's application URL; the plugin emits `call.received` so a
 *     Paperclip skill can pick a per-DID assistant before answering.
 *   - Turn-by-turn conversation: `say` the AI's reply, `gather` the caller's
 *     reply via Jambonz's built-in STT (Deepgram by default), LLM call
 *     between turns. No barge-in.
 *   - Recording is delegated to Jambonz (configured at the carrier or
 *     application level on the Jambonz side).
 *
 * Out of scope for v0.6.0 (lands in v0.6.x):
 *   - Streaming LLM tokens directly to TTS (would require a different
 *     Jambonz protocol — the WebSocket session API).
 *   - Barge-in (caller interrupting TTS) — same.
 *   - Mid-call tool calls.
 *   - Assistant CRUD via REST. DIY assistants are configured inline at
 *     call placement time; createAssistant / updateAssistant / etc.
 *     return [ENOT_SUPPORTED] for now.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import type {
  AssistantConfig,
  ListCallsFilter,
  NormalizedAssistant,
  NormalizedCallStatus,
  NormalizedCallSummary,
  NormalizedPhoneEvent,
  NormalizedPhoneNumber,
  NormalizedTranscript,
  PhoneEngine,
  StartCallInput,
  StartCallResult,
  TranscriptFormat,
  WebhookInput,
} from "../types.js";
import {
  type JambonzClient,
  jambonzEndCall,
  jambonzListPhoneNumbers,
  jambonzStartCall,
  verifyJambonzSignature,
} from "./jambonzClient.js";
import {
  type LlmProvider,
  type LlmTurn,
  defaultModelFor,
  llmComplete,
} from "./llmClient.js";
import {
  type ConversationStore,
  type DiyCallState,
  createConversationStore,
} from "./conversationStore.js";
import { buildHangupVerbs, buildTurnVerbs, type JambonzVerb } from "./verbBuilder.js";

export interface DiyEngineOptions {
  /** Plugin host context, used for persistent conversation state via ctx.state. */
  ctx: PluginContext;
  /** Jambonz instance base URL, e.g. https://jambonz.example.com */
  jambonzApiUrl: string;
  jambonzApiKey: string;
  jambonzAccountSid: string;
  jambonzApplicationSid: string;
  /** HMAC secret for verifying Jambonz → plugin webhooks. */
  webhookSecret: string | null;
  /** Paperclip host URL so we can build absolute callback URLs Jambonz can hit. */
  hostBaseUrl: string;
  /** Plugin id, used to compose API route URLs the host serves. */
  pluginId: string;
  /** Account key — embedded in callback URLs so the dispatcher can find this engine on a webhook. */
  accountKey: string;
  /** LLM provider config. */
  llmProvider: LlmProvider;
  llmApiKey: string;
  /** Optional override for LLM model — defaults applied per provider. */
  llmModelOverride?: string;
  /** TTS vendor name as Jambonz expects (e.g. "elevenlabs", "google"). */
  ttsVendor: string;
  /** Default voice id for the TTS vendor. */
  ttsVoice: string;
  /** Default BCP-47 language. */
  ttsLanguage: string;
  /** STT vendor (e.g. "deepgram", "google"). */
  sttVendor: string;
  sttLanguage: string;
  /** Recording opt-in. Jambonz handles the actual capture. */
  recordingEnabled: boolean;
}

export function createDiyEngine(opts: DiyEngineOptions): DiyEngine {
  const client: JambonzClient = {
    apiUrl: opts.jambonzApiUrl,
    apiKey: opts.jambonzApiKey,
    accountSid: opts.jambonzAccountSid,
    applicationSid: opts.jambonzApplicationSid,
    webhookSecret: opts.webhookSecret,
  };
  const store = createConversationStore(opts.ctx, opts.accountKey);
  const llmModel = opts.llmModelOverride ?? defaultModelFor(opts.llmProvider);

  function callHookUrl(callSid: string): string {
    const host = trimSlash(opts.hostBaseUrl);
    return `${host}/api/plugins/${opts.pluginId}/api/diy/jambonz/call?accountKey=${enc(opts.accountKey)}&callSid=${enc(callSid)}`;
  }
  function nextHookUrl(callSid: string): string {
    const host = trimSlash(opts.hostBaseUrl);
    return `${host}/api/plugins/${opts.pluginId}/api/diy/jambonz/next?accountKey=${enc(opts.accountKey)}&callSid=${enc(callSid)}`;
  }
  function statusHookUrl(callSid: string): string {
    const host = trimSlash(opts.hostBaseUrl);
    return `${host}/api/plugins/${opts.pluginId}/api/diy/jambonz/status?accountKey=${enc(opts.accountKey)}&callSid=${enc(callSid)}`;
  }

  /** Resolve the assistant config from either an inline literal or a saved name. */
  function resolveAssistant(input: StartCallInput["assistant"]): AssistantConfig {
    if (typeof input === "string") {
      throw new Error(
        `[ENOT_SUPPORTED] DIY engine v0.6.0 doesn't support named assistants — pass the AssistantConfig inline. Saved assistants are scheduled for v0.6.x.`,
      );
    }
    return input;
  }

  const engine: PhoneEngine & DiyHookHandlers = {
    engineKind: "diy",

    async startOutboundCall(input: StartCallInput): Promise<StartCallResult> {
      const resolved = resolveAssistant(input.assistant);
      // Per-call firstMessage override (e.g. wizard placeholder substituted
      // with the caller's `reason`). See StartCallInput.firstMessageOverride.
      const assistant = input.firstMessageOverride
        ? { ...resolved, firstMessage: input.firstMessageOverride }
        : resolved;
      const fromNumber = input.numberId; // For DIY, numberId is the E.164 directly.
      if (!fromNumber) {
        throw new Error(
          `[EINVALID_INPUT] DIY engine requires 'numberId' to be set to the E.164 outbound number (the Jambonz-configured DID).`,
        );
      }

      // Pre-allocate a callSid so the hook URLs can carry it before Jambonz
      // returns its real sid. We replace this in `upsert` once Jambonz responds.
      const provisionalSid = `pending-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const result = await jambonzStartCall(client, {
        from: fromNumber,
        to: input.to,
        callHookUrl: callHookUrl(provisionalSid),
        statusHookUrl: statusHookUrl(provisionalSid),
        tag: { provisionalSid, ...input.metadata },
      });

      const startedAt = new Date().toISOString();
      const state: DiyCallState = {
        callSid: result.sid,
        direction: "outbound",
        from: fromNumber,
        to: input.to,
        numberId: fromNumber,
        startedAt,
        endedAt: null,
        assistant,
        accountKey: opts.accountKey,
        history: [],
        transcript: null,
        status: "queued",
        endReason: null,
        durationSec: null,
        costUsd: 0,
        recordingUrl: null,
        metadata: input.metadata ?? {},
      };
      await store.upsert(state);
      // Also stash under the provisional sid so Jambonz hooks that fire
      // with the provisional reference can find it. Jambonz typically
      // replaces with the real sid on the first hook.
      await store.upsert({ ...state, callSid: provisionalSid });

      return { callId: result.sid, status: "queued" };
    },

    async endCall(callId: string, reason?: string): Promise<void> {
      try {
        await jambonzEndCall(client, callId);
      } catch (err) {
        const msg = (err as Error).message;
        if (!msg.includes("[EJAMBONZ_HTTP_404]")) throw err;
        // 404 = already ended on Jambonz side. Treat as success.
      }
      const cur = await store.get(callId);
      if (cur && cur.status !== "ended") {
        await store.patch(callId, {
          status: "ended",
          endedAt: new Date().toISOString(),
          endReason: reason ?? "force-ended",
        });
      }
    },

    async getCallStatus(callId: string): Promise<NormalizedCallStatus> {
      const state = await store.get(callId);
      if (!state) {
        throw new Error(`[ECALL_NOT_FOUND] DIY engine has no record of call "${callId}".`);
      }
      return {
        callId,
        status: state.status,
        direction: state.direction,
        from: state.from,
        to: state.to,
        assistantId: null,
        numberId: state.numberId,
        startedAt: state.startedAt,
        endedAt: state.endedAt,
        durationSec: state.durationSec,
        costUsd: state.costUsd > 0 ? state.costUsd : null,
        endReason: state.endReason,
      };
    },

    async getCallTranscript(
      callId: string,
      format: TranscriptFormat,
    ): Promise<NormalizedTranscript> {
      const state = await store.get(callId);
      if (!state) {
        throw new Error(`[ECALL_NOT_FOUND] DIY engine has no record of call "${callId}".`);
      }
      const lines: string[] = [];
      const structured: NormalizedTranscript["structured"] = [];
      let ts = state.startedAt;
      for (const turn of state.history) {
        if (turn.role === "system") continue;
        const role: "agent" | "caller" = turn.role === "assistant" ? "agent" : "caller";
        lines.push(`${role === "agent" ? "Agent" : "Caller"}: ${turn.content}`);
        structured.push({ role, text: turn.content, ts });
      }
      const transcript = state.transcript ?? lines.join("\n");
      return format === "structured"
        ? { callId, transcript, structured }
        : { callId, transcript };
    },

    async getCallRecordingUrl(
      callId: string,
      _expiresInSec: number,
    ): Promise<{ url: string; expiresAt: string }> {
      const state = await store.get(callId);
      if (!state?.recordingUrl) {
        throw new Error(
          `[ENOT_AVAILABLE] No recording URL for call "${callId}". Either recording is off or Jambonz hasn't posted the recording event yet.`,
        );
      }
      // Jambonz recording URLs are stable for the lifetime of the recording —
      // expiry is operator-set on the Jambonz side, not per-call.
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      return { url: state.recordingUrl, expiresAt };
    },

    async listCalls(
      filter: ListCallsFilter,
    ): Promise<{ calls: NormalizedCallSummary[]; nextCursor?: string }> {
      const sinceMs = filter.since ? Date.parse(filter.since) : 0;
      const untilMs = filter.until ? Date.parse(filter.until) : Infinity;
      const all = await store.list();
      const matches = all
        .filter((s) => {
          const startMs = Date.parse(s.startedAt);
          if (!Number.isFinite(startMs)) return true;
          if (startMs < sinceMs) return false;
          if (startMs > untilMs) return false;
          if (filter.direction && filter.direction !== "any" && s.direction !== filter.direction)
            return false;
          if (filter.status && s.status !== filter.status) return false;
          return true;
        })
        .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));

      const limit = filter.limit ?? 50;
      const offset = filter.cursor ? Number.parseInt(filter.cursor, 10) || 0 : 0;
      const slice = matches.slice(offset, offset + limit);
      const summaries: NormalizedCallSummary[] = slice.map((s) => ({
        callId: s.callSid,
        direction: s.direction,
        from: s.from,
        to: s.to,
        status: s.status,
        assistantId: null,
        numberId: s.numberId,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        durationSec: s.durationSec,
        costUsd: s.costUsd > 0 ? s.costUsd : null,
      }));
      const next = offset + slice.length < matches.length ? String(offset + slice.length) : undefined;
      return { calls: summaries, nextCursor: next };
    },

    async listAssistants(): Promise<NormalizedAssistant[]> {
      // DIY assistants are call-local in v0.6.0 — return empty so consumers
      // know there's nothing saved to enumerate.
      return [];
    },

    async createAssistant(_input: AssistantConfig): Promise<NormalizedAssistant> {
      throw new Error(
        `[ENOT_SUPPORTED] DIY engine v0.6.0 doesn't support saved assistants. Pass AssistantConfig inline to phone_call_make. Saved-assistant CRUD lands in v0.6.x.`,
      );
    },

    async updateAssistant(): Promise<NormalizedAssistant> {
      throw new Error(`[ENOT_SUPPORTED] DIY engine: assistant CRUD not supported yet.`);
    },

    async deleteAssistant(): Promise<void> {
      throw new Error(`[ENOT_SUPPORTED] DIY engine: assistant CRUD not supported yet.`);
    },

    async listNumbers(): Promise<NormalizedPhoneNumber[]> {
      const numbers = await jambonzListPhoneNumbers(client);
      return numbers.map((n) => ({
        id: n.phone_number_sid ?? n.number ?? "",
        e164: n.number ?? "",
        label: null,
        sipTrunk: n.voip_carrier_sid ?? null,
      }));
    },

    async parseWebhook(input: WebhookInput): Promise<NormalizedPhoneEvent | null> {
      // The DIY engine uses apiRoutes for Jambonz hooks (verb-array
      // responses required), not the void-returning onWebhook surface.
      // The /webhooks/diy endpoint is left for future status-only events
      // — currently a no-op so parseWebhook returns null. The real
      // dispatch happens in handleCallHook / handleNextHook / handleStatusHook
      // below, invoked from worker.ts onApiRequest.
      void input;
      return null;
    },

    // ─── Jambonz hook handlers (called from onApiRequest, not parseWebhook) ─

    async handleCallHook(
      callSid: string,
      rawBody: string,
      signature: string | undefined,
    ): Promise<{ ok: true; verbs: JambonzVerb[] } | { ok: false; status: number; reason: string }> {
      if (!(await verifyJambonzSignature(opts.webhookSecret, rawBody, signature))) {
        return { ok: false, status: 401, reason: "signature mismatch" };
      }
      // Pull or hydrate state. Outbound calls have state already (created
      // in startOutboundCall); inbound calls land here cold and we need to
      // create a state shell. For v0.6.0 we don't yet support inbound on
      // DIY at the full-conversation level — we just emit call.received
      // and Jambonz-side rule handles answering.
      const state = await store.get(callSid);
      if (!state) {
        // Inbound cold start — Jambonz hit us without prior context.
        // Return a polite hangup; inbound is a v0.6.x slice.
        return {
          ok: true,
          verbs: buildHangupVerbs(
            "I'm sorry, this line isn't taking calls right now.",
            { vendor: opts.ttsVendor, voice: opts.ttsVoice, language: opts.ttsLanguage },
          ),
        };
      }

      // First turn — speak the firstMessage and gather the caller's reply.
      const firstMessage = state.assistant.firstMessage ?? "Hi, how can I help?";
      await store.patch(callSid, { status: "in-progress" });

      // Record the assistant's opening line in conversation history so the
      // subsequent LLM call has it for context.
      await store.appendTurn(callSid, { role: "assistant", content: firstMessage });

      const verbs = buildTurnVerbs({
        spokenLine: firstMessage,
        nextHookUrl: nextHookUrl(callSid),
        ttsVendor: opts.ttsVendor,
        ttsVoice: state.assistant.voice ?? opts.ttsVoice,
        ttsLanguage: opts.ttsLanguage,
        sttVendor: opts.sttVendor,
        sttLanguage: opts.sttLanguage,
      });
      return { ok: true, verbs };
    },

    async handleNextHook(
      callSid: string,
      rawBody: string,
      signature: string | undefined,
      gatherPayload: { speech?: { transcript?: string } } | null,
    ): Promise<{ ok: true; verbs: JambonzVerb[] } | { ok: false; status: number; reason: string }> {
      if (!(await verifyJambonzSignature(opts.webhookSecret, rawBody, signature))) {
        return { ok: false, status: 401, reason: "signature mismatch" };
      }
      const state = await store.get(callSid);
      if (!state) {
        return {
          ok: true,
          verbs: buildHangupVerbs(),
        };
      }

      const callerText = gatherPayload?.speech?.transcript?.trim() ?? "";
      if (!callerText) {
        // Empty input — caller didn't say anything during the gather window.
        // Politely prompt once more before giving up.
        const reprompt = "Sorry, I didn't catch that. Could you say it again?";
        await store.appendTurn(callSid, { role: "assistant", content: reprompt });
        return {
          ok: true,
          verbs: buildTurnVerbs({
            spokenLine: reprompt,
            nextHookUrl: nextHookUrl(callSid),
            ttsVendor: opts.ttsVendor,
            ttsVoice: state.assistant.voice ?? opts.ttsVoice,
            ttsLanguage: opts.ttsLanguage,
            sttVendor: opts.sttVendor,
            sttLanguage: opts.sttLanguage,
          }),
        };
      }

      await store.appendTurn(callSid, { role: "user", content: callerText });
      const updated = (await store.get(callSid))!;

      let llmReply: string;
      try {
        llmReply = await llmComplete(
          {
            provider: opts.llmProvider,
            apiKey: opts.llmApiKey,
            model: state.assistant.model ?? llmModel,
          },
          state.assistant.systemPrompt,
          updated.history,
        );
      } catch (err) {
        const msg = (err as Error).message;
        return {
          ok: true,
          verbs: buildHangupVerbs(
            "I'm sorry, I'm having trouble responding right now. Goodbye.",
            { vendor: opts.ttsVendor, voice: opts.ttsVoice, language: opts.ttsLanguage },
          ),
        };
      }

      const trimmed = llmReply.trim();
      if (!trimmed) {
        return {
          ok: true,
          verbs: buildHangupVerbs(
            "Thanks for your time. Goodbye.",
            { vendor: opts.ttsVendor, voice: opts.ttsVoice, language: opts.ttsLanguage },
          ),
        };
      }

      await store.appendTurn(callSid, { role: "assistant", content: trimmed });

      // End-of-conversation heuristic: if the LLM's reply contains a
      // terminal goodbye phrase, hang up after speaking. Crude but
      // sufficient for v0.6.0; a tool-call protocol for explicit end-call
      // signaling lands later.
      const looksTerminal = /\b(goodbye|bye now|have a (good|great) day)\b/i.test(trimmed);
      if (looksTerminal) {
        return {
          ok: true,
          verbs: buildHangupVerbs(trimmed, {
            vendor: opts.ttsVendor,
            voice: state.assistant.voice ?? opts.ttsVoice,
            language: opts.ttsLanguage,
          }),
        };
      }

      return {
        ok: true,
        verbs: buildTurnVerbs({
          spokenLine: trimmed,
          nextHookUrl: nextHookUrl(callSid),
          ttsVendor: opts.ttsVendor,
          ttsVoice: state.assistant.voice ?? opts.ttsVoice,
          ttsLanguage: opts.ttsLanguage,
          sttVendor: opts.sttVendor,
          sttLanguage: opts.sttLanguage,
        }),
      };
    },

    async handleStatusHook(
      callSid: string,
      rawBody: string,
      signature: string | undefined,
      payload: {
        call_status?: string;
        duration?: number;
        end_time?: string;
        termination_reason?: string;
        recording_url?: string;
      } | null,
    ): Promise<{ ok: true; event: NormalizedPhoneEvent | null } | { ok: false; status: number; reason: string }> {
      if (!(await verifyJambonzSignature(opts.webhookSecret, rawBody, signature))) {
        return { ok: false, status: 401, reason: "signature mismatch" };
      }
      const state = await store.get(callSid);
      if (!state) return { ok: true, event: null };

      const status = mapJambonzStatus(payload?.call_status);
      const patch: Partial<DiyCallState> = { status };
      if (payload?.end_time) patch.endedAt = payload.end_time;
      if (typeof payload?.duration === "number") patch.durationSec = payload.duration;
      if (payload?.termination_reason) patch.endReason = payload.termination_reason;
      if (payload?.recording_url) patch.recordingUrl = payload.recording_url;
      await store.patch(callSid, patch);

      // Build the matching NormalizedPhoneEvent for the dispatcher to fan out.
      const updated = (await store.get(callSid))!;
      if (
        status === "ended" ||
        status === "failed" ||
        status === "no-answer" ||
        status === "busy" ||
        status === "canceled"
      ) {
        const event: NormalizedPhoneEvent = {
          kind: "call.ended",
          callId: callSid,
          endedAt: updated.endedAt ?? new Date().toISOString(),
          durationSec: updated.durationSec ?? 0,
          endReason: updated.endReason ?? status,
          costUsd: updated.costUsd > 0 ? updated.costUsd : undefined,
        };
        return { ok: true, event };
      }
      if (status === "in-progress" && state.status !== "in-progress") {
        const event: NormalizedPhoneEvent = {
          kind: "call.started",
          callId: callSid,
          direction: state.direction,
          from: state.from ?? "",
          to: state.to ?? "",
          startedAt: state.startedAt,
        };
        return { ok: true, event };
      }
      return { ok: true, event: null };
    },
  };

  return engine as DiyEngine;
}

function mapJambonzStatus(s: string | undefined): DiyCallState["status"] {
  switch ((s ?? "").toLowerCase()) {
    case "queued":
    case "trying":
      return "queued";
    case "ringing":
    case "early-media":
      return "ringing";
    case "in-progress":
    case "answered":
      return "in-progress";
    case "completed":
    case "ended":
      return "ended";
    case "no-answer":
      return "no-answer";
    case "busy":
      return "busy";
    case "failed":
      return "failed";
    case "canceled":
    case "cancelled":
      return "canceled";
    default:
      return "in-progress";
  }
}

function trimSlash(u: string): string {
  return u.endsWith("/") ? u.slice(0, -1) : u;
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

/**
 * Surface for the Jambonz hooks, used by worker.ts onApiRequest to dispatch
 * /api/plugins/phone-tools/api/diy/jambonz/{call,next,status} requests into
 * the engine.
 */
export interface DiyHookHandlers {
  handleCallHook(
    callSid: string,
    rawBody: string,
    signature: string | undefined,
  ): Promise<
    | { ok: true; verbs: JambonzVerb[] }
    | { ok: false; status: number; reason: string }
  >;
  handleNextHook(
    callSid: string,
    rawBody: string,
    signature: string | undefined,
    gatherPayload: { speech?: { transcript?: string } } | null,
  ): Promise<
    | { ok: true; verbs: JambonzVerb[] }
    | { ok: false; status: number; reason: string }
  >;
  handleStatusHook(
    callSid: string,
    rawBody: string,
    signature: string | undefined,
    payload: {
      call_status?: string;
      duration?: number;
      end_time?: string;
      termination_reason?: string;
      recording_url?: string;
    } | null,
  ): Promise<
    | { ok: true; event: NormalizedPhoneEvent | null }
    | { ok: false; status: number; reason: string }
  >;
}

export type DiyEngine = PhoneEngine & DiyHookHandlers;
