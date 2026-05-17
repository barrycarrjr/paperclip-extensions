/**
 * Per-call conversation state for the DIY phone engine.
 *
 * Persists to `ctx.state` (instance scope) so the conversation survives
 * worker restarts during an active call — a long call with a 5-minute LLM
 * thread doesn't lose its history if the worker is bounced between turns.
 *
 * Storage layout:
 *   - Each call:    instance::diy:call:<accountKey>:<callSid>  → DiyCallState
 *   - Per-account index:
 *                   instance::diy:index:<accountKey>           → IndexEntry[]
 *
 * The index is a small summary array (callSid + timestamps + status), used
 * by `list()` for fast filtering without N round-trips. It's capped at
 * MAX_INDEX_ENTRIES per account — the oldest terminal entries are evicted
 * (and their full state dropped) on each upsert. This bounds storage
 * growth even if the operator never calls `gc()`.
 *
 * Keyed by Jambonz callSid + accountKey (accountKey scopes the keyspace so
 * two phone-tools accounts on the same instance can't collide).
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { AssistantConfig, CallDirection } from "../types.js";
import type { LlmTurn } from "./llmClient.js";

const MAX_INDEX_ENTRIES = 500;

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

interface IndexEntry {
  callSid: string;
  startedAt: string;
  endedAt: string | null;
  status: DiyCallState["status"];
  direction: CallDirection;
}

export interface ConversationStore {
  upsert(state: DiyCallState): Promise<void>;
  get(callSid: string): Promise<DiyCallState | undefined>;
  patch(callSid: string, patch: Partial<DiyCallState>): Promise<DiyCallState | undefined>;
  appendTurn(callSid: string, turn: LlmTurn): Promise<DiyCallState | undefined>;
  list(): Promise<DiyCallState[]>;
  drop(callSid: string): Promise<void>;
  /** Drop terminal entries older than `olderThanMs`. Returns count dropped. */
  gc(olderThanMs: number): Promise<number>;
}

/**
 * Create a state-backed conversation store for a given account.
 *
 * `ctx` carries the plugin-host bridge for reads/writes; `accountKey`
 * namespaces the keys so multiple phone-tools accounts coexist cleanly.
 */
export function createConversationStore(
  ctx: PluginContext,
  accountKey: string,
): ConversationStore {
  const callKey = (callSid: string) => ({
    scopeKind: "instance" as const,
    stateKey: `diy:call:${accountKey}:${callSid}`,
  });
  const indexKey = {
    scopeKind: "instance" as const,
    stateKey: `diy:index:${accountKey}`,
  };

  async function readIndex(): Promise<IndexEntry[]> {
    const v = await ctx.state.get(indexKey);
    if (!v || !Array.isArray(v)) return [];
    // Defensive: filter to entries with required fields so a corrupted
    // index can't crash the engine.
    return (v as unknown[]).filter(
      (e): e is IndexEntry =>
        !!e &&
        typeof e === "object" &&
        typeof (e as IndexEntry).callSid === "string" &&
        typeof (e as IndexEntry).startedAt === "string",
    );
  }

  async function writeIndex(entries: IndexEntry[]): Promise<void> {
    await ctx.state.set(indexKey, entries);
  }

  function toIndexEntry(state: DiyCallState): IndexEntry {
    return {
      callSid: state.callSid,
      startedAt: state.startedAt,
      endedAt: state.endedAt,
      status: state.status,
      direction: state.direction,
    };
  }

  /**
   * Capacity policy: when the index exceeds MAX_INDEX_ENTRIES, evict the
   * oldest TERMINAL entries first (active calls are never evicted, even
   * if they're old — that would lose live conversation history). If the
   * cap is still exceeded after evicting all terminal entries, evict the
   * oldest active ones too (degenerate case; means 500+ concurrent calls).
   */
  async function enforceCap(entries: IndexEntry[]): Promise<IndexEntry[]> {
    if (entries.length <= MAX_INDEX_ENTRIES) return entries;
    const terminal = new Set<DiyCallState["status"]>([
      "ended",
      "failed",
      "no-answer",
      "busy",
      "canceled",
    ]);
    // Sort: terminal entries first by oldest endedAt, then active by oldest startedAt.
    const sorted = [...entries].sort((a, b) => {
      const aTerm = terminal.has(a.status) ? 0 : 1;
      const bTerm = terminal.has(b.status) ? 0 : 1;
      if (aTerm !== bTerm) return aTerm - bTerm;
      const aT = Date.parse(a.endedAt ?? a.startedAt) || 0;
      const bT = Date.parse(b.endedAt ?? b.startedAt) || 0;
      return aT - bT;
    });
    const toEvict = sorted.slice(0, sorted.length - MAX_INDEX_ENTRIES);
    for (const e of toEvict) {
      await ctx.state.delete(callKey(e.callSid)).catch(() => {});
    }
    const toKeep = new Set(sorted.slice(toEvict.length).map((e) => e.callSid));
    return entries.filter((e) => toKeep.has(e.callSid));
  }

  return {
    async upsert(state) {
      await ctx.state.set(callKey(state.callSid), state);
      const index = await readIndex();
      const idx = index.findIndex((e) => e.callSid === state.callSid);
      if (idx >= 0) index[idx] = toIndexEntry(state);
      else index.push(toIndexEntry(state));
      const trimmed = await enforceCap(index);
      await writeIndex(trimmed);
    },

    async get(callSid) {
      const v = await ctx.state.get(callKey(callSid));
      if (!v || typeof v !== "object") return undefined;
      return v as DiyCallState;
    },

    async patch(callSid, patch) {
      const cur = await this.get(callSid);
      if (!cur) return undefined;
      const next = { ...cur, ...patch };
      await this.upsert(next);
      return next;
    },

    async appendTurn(callSid, turn) {
      const cur = await this.get(callSid);
      if (!cur) return undefined;
      const next = { ...cur, history: [...cur.history, turn] };
      await this.upsert(next);
      return next;
    },

    async list() {
      const index = await readIndex();
      // Sort newest first by startedAt — what `phone_call_list` expects.
      const sorted = [...index].sort(
        (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt),
      );
      const results: DiyCallState[] = [];
      for (const entry of sorted) {
        const state = await this.get(entry.callSid);
        if (state) results.push(state);
      }
      return results;
    },

    async drop(callSid) {
      await ctx.state.delete(callKey(callSid)).catch(() => {});
      const index = await readIndex();
      const next = index.filter((e) => e.callSid !== callSid);
      if (next.length !== index.length) await writeIndex(next);
    },

    async gc(olderThanMs) {
      const cutoff = Date.now() - olderThanMs;
      const terminal = new Set<DiyCallState["status"]>([
        "ended",
        "failed",
        "no-answer",
        "busy",
        "canceled",
      ]);
      const index = await readIndex();
      const keep: IndexEntry[] = [];
      let dropped = 0;
      for (const e of index) {
        if (!terminal.has(e.status) || !e.endedAt) {
          keep.push(e);
          continue;
        }
        const endedMs = Date.parse(e.endedAt);
        if (Number.isFinite(endedMs) && endedMs < cutoff) {
          await ctx.state.delete(callKey(e.callSid)).catch(() => {});
          dropped += 1;
        } else {
          keep.push(e);
        }
      }
      if (dropped > 0) await writeIndex(keep);
      return dropped;
    },
  };
}
