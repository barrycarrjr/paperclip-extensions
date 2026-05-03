/**
 * Engine abstraction. Every backend voice engine (Vapi, future DIY)
 * implements `PhoneEngine`. The plugin's tool layer NEVER imports an
 * engine directly — it goes through `getEngine()` so a second engine
 * can drop in without touching the tools or webhook dispatcher.
 *
 * All result shapes are the engine-neutral *normalized* shapes; engines
 * are responsible for mapping their provider-specific responses into
 * these. Skills consuming the plugin's tools or events see the same
 * shape regardless of which engine handled the call.
 */

export type EngineKind = "vapi" | "diy";

// ─── Common config shapes ──────────────────────────────────────────────

export interface AssistantConfig {
  name: string;
  systemPrompt: string;
  firstMessage?: string;
  /** Engine-specific. e.g. for Vapi: "11labs:rachel"; for DIY: "alloy". */
  voice?: string;
  /** Engine-specific. e.g. for Vapi: "gpt-4o"; for DIY: "gpt-4o-realtime-preview". */
  model?: string;
  /**
   * Names of plugin-internal tools the in-call assistant may invoke
   * mid-call. Set is fixed in v0.1.0 — see plan §"Open questions" #5.
   */
  tools?: string[];
}

export interface StartCallInput {
  to: string;
  /** Engine-side phone-number ID. Falls back to defaultNumberId. */
  numberId?: string;
  /** Either an existing assistant ID/name, OR an inline AssistantConfig. */
  assistant: string | AssistantConfig;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface StartCallResult {
  callId: string;
  status: NormalizedCallStatus["status"];
}

// ─── Normalized read shapes ────────────────────────────────────────────

export type CallDirection = "inbound" | "outbound";

export interface NormalizedCallStatus {
  callId: string;
  status:
    | "queued"
    | "ringing"
    | "in-progress"
    | "ended"
    | "failed"
    | "no-answer"
    | "busy"
    | "canceled";
  direction: CallDirection | null;
  from: string | null;
  to: string | null;
  assistantId: string | null;
  numberId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationSec: number | null;
  costUsd: number | null;
  endReason: string | null;
}

export type TranscriptFormat = "plain" | "structured";

export interface NormalizedTranscript {
  callId: string;
  transcript: string;
  structured?: Array<{
    role: "agent" | "caller";
    text: string;
    ts: string;
  }>;
}

export interface NormalizedCallSummary {
  callId: string;
  direction: CallDirection | null;
  from: string | null;
  to: string | null;
  status: NormalizedCallStatus["status"];
  assistantId: string | null;
  numberId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationSec: number | null;
  costUsd: number | null;
}

export interface ListCallsFilter {
  since?: string;
  until?: string;
  direction?: CallDirection | "any";
  assistantId?: string;
  status?: NormalizedCallStatus["status"];
  limit?: number;
  cursor?: string;
}

export interface NormalizedAssistant {
  id: string;
  name: string;
  voice: string | null;
  model: string | null;
  systemPrompt?: string;
  firstMessage?: string;
}

export interface NormalizedPhoneNumber {
  id: string;
  e164: string;
  label: string | null;
  /**
   * Identifier of the SIP trunk this number routes through on the engine
   * side, where applicable. Operators use this to confirm a number is
   * bound to the 3CX trunk they expect.
   */
  sipTrunk: string | null;
  allowedAssistants?: string[];
}

// ─── Webhook ────────────────────────────────────────────────────────────

export interface WebhookInput {
  endpointKey: string;
  body: unknown;
  headers: Record<string, string>;
  rawBody?: string;
}

export type NormalizedPhoneEvent =
  | {
      kind: "call.received";
      callId: string;
      from: string;
      to: string;
      numberId: string;
      assistantId?: string;
      startedAt: string;
    }
  | {
      kind: "call.started";
      callId: string;
      direction: CallDirection;
      from: string;
      to: string;
      assistantId?: string;
      startedAt: string;
    }
  | {
      kind: "call.ended";
      callId: string;
      endedAt: string;
      durationSec: number;
      endReason: string;
      costUsd?: number;
    }
  | {
      kind: "call.transcript.partial";
      callId: string;
      role: "agent" | "caller";
      text: string;
      ts: string;
    }
  | {
      kind: "call.transcript.final";
      callId: string;
      transcript: string;
    }
  | {
      kind: "call.function_call";
      callId: string;
      tool: string;
      params: unknown;
    };

// ─── The interface every engine implements ─────────────────────────────

export interface PhoneEngine {
  readonly engineKind: EngineKind;

  // Outbound + control
  startOutboundCall(input: StartCallInput): Promise<StartCallResult>;
  endCall(callId: string, reason?: string): Promise<void>;

  // Reads
  getCallStatus(callId: string): Promise<NormalizedCallStatus>;
  getCallTranscript(
    callId: string,
    format: TranscriptFormat,
  ): Promise<NormalizedTranscript>;
  getCallRecordingUrl(
    callId: string,
    expiresInSec: number,
  ): Promise<{ url: string; expiresAt: string }>;
  listCalls(
    filter: ListCallsFilter,
  ): Promise<{ calls: NormalizedCallSummary[]; nextCursor?: string }>;

  // Assistants
  listAssistants(): Promise<NormalizedAssistant[]>;
  createAssistant(input: AssistantConfig): Promise<NormalizedAssistant>;
  updateAssistant(
    id: string,
    patch: Partial<AssistantConfig>,
  ): Promise<NormalizedAssistant>;
  deleteAssistant(id: string): Promise<void>;

  // Numbers
  listNumbers(): Promise<NormalizedPhoneNumber[]>;

  // Inbound webhooks
  parseWebhook(input: WebhookInput): Promise<NormalizedPhoneEvent | null>;
}

// ─── Plugin-side config types ─────────────────────────────────────────

export interface ConfigAccount {
  key?: string;
  displayName?: string;
  engine?: EngineKind;
  apiKeyRef?: string;
  webhookSecretRef?: string;
  engineConfig?: Record<string, unknown>;
  allowedNumbers?: string[];
  allowedAssistants?: string[];
  defaultNumberId?: string;
  defaultAssistantId?: string;
  allowedCompanies?: string[];
  /** Per-account opt-in for call recording. Defaults to false. */
  recordingEnabled?: boolean;
  /** Per-account concurrency cap for outbound calls. Default 3. */
  maxConcurrentCalls?: number;
}

export interface InstanceConfig {
  allowMutations?: boolean;
  defaultAccount?: string;
  accounts?: ConfigAccount[];
}

export interface ResolvedAccount {
  account: ConfigAccount;
  accountKey: string;
  apiKey: string;
  webhookSecret: string | null;
  engine: PhoneEngine;
}
