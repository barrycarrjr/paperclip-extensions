/**
 * Per-call conversation state for the DIY phone engine.
 *
 * In-memory only — a worker restart during an active call loses the
 * conversation context, which means the LLM would lose history. For
 * v0.6.0 this is acceptable: the worker is long-running, and a restart
 * mid-call would also kill the Jambonz session anyway. Persistence can
 * be added in v0.6.x via plugin state if needed.
 *
 * Keyed by Jambonz callSid. Includes:
 *   - conversation history (caller + assistant turns)
 *   - assistant config (system prompt, voice, model, etc.) — captured at
 *     start-of-call so the operator can edit the assistant mid-call
 *     without scrambling an in-progress conversation
 *   - call metadata (from/to/direction/startedAt/etc.)
 */

import type { AssistantConfig, CallDirection } from "../types.js";
import type { LlmTurn } from "./llmClient.js";

export interface DiyCallState {
  callSid: string;
  direction: CallDirection;
  from: string | null;
  to: string | null;
  numberId: string | null;
  /** ISO timestamp; set when we issued the start-call REST request. */
  startedAt: string;
  endedAt: string | null;
  /** Snapshot of the assistant config at call start. */
  assistant: AssistantConfig;
  /** Account key, kept so webhook handlers can resolve the engine cheaply. */
  accountKey: string;
  /** Conversation turns so far, in order. */
  history: LlmTurn[];
  /** Final transcript once the call ends. */
  transcript: string | null;
  /** "queued" → "ringing" → "in-progress" → "ended" / "failed" / etc. */
  status:
    | "queued"
    | "ringing"
    | "in-progress"
    | "ended"
    | "failed"
    | "no-answer"
    | "busy"
    | "canceled";
  /** Reason populated when status flips to a terminal value. */
  endReason: string | null;
  /** Duration in seconds, set on call end. */
  durationSec: number | null;
  /** Cost accounting: USD, accumulated from LLM + STT + TTS + carrier. */
  costUsd: number;
  /** Jambonz-side recording URL (set on call-status webhook if recording was enabled). */
  recordingUrl: string | null;
  /** Free-form metadata the caller passed (e.g. issueRef for trace correlation). */
  metadata: Record<string, unknown>;
}

export interface ConversationStore {
  upsert(state: DiyCallState): void;
  get(callSid: string): DiyCallState | undefined;
  patch(callSid: string, patch: Partial<DiyCallState>): DiyCallState | undefined;
  appendTurn(callSid: string, turn: LlmTurn): DiyCallState | undefined;
  list(): DiyCallState[];
  drop(callSid: string): void;
  /** Drop entries older than `olderThanMs` whose status is terminal. */
  gc(olderThanMs: number): number;
}

export function createConversationStore(): ConversationStore {
  const store = new Map<string, DiyCallState>();

  return {
    upsert(state) {
      store.set(state.callSid, state);
    },
    get(callSid) {
      return store.get(callSid);
    },
    patch(callSid, patch) {
      const cur = store.get(callSid);
      if (!cur) return undefined;
      const next = { ...cur, ...patch };
      store.set(callSid, next);
      return next;
    },
    appendTurn(callSid, turn) {
      const cur = store.get(callSid);
      if (!cur) return undefined;
      const next = { ...cur, history: [...cur.history, turn] };
      store.set(callSid, next);
      return next;
    },
    list() {
      return Array.from(store.values());
    },
    drop(callSid) {
      store.delete(callSid);
    },
    gc(olderThanMs) {
      const cutoff = Date.now() - olderThanMs;
      const terminal = new Set([
        "ended",
        "failed",
        "no-answer",
        "busy",
        "canceled",
      ]);
      let dropped = 0;
      for (const [sid, state] of store.entries()) {
        if (!terminal.has(state.status)) continue;
        if (!state.endedAt) continue;
        const endedMs = Date.parse(state.endedAt);
        if (Number.isFinite(endedMs) && endedMs < cutoff) {
          store.delete(sid);
          dropped += 1;
        }
      }
      return dropped;
    },
  };
}
