/**
 * Engine abstraction. Every backend 3CX engine (v20 XAPI today, v18 Call
 * Control API in a future phase) implements `ThreeCxEngine`. The plugin's
 * tool layer NEVER imports an engine directly — it goes through
 * `getEngine()` so a second engine can drop in without touching the tools
 * or WebSocket dispatcher.
 *
 * Result shapes are engine-neutral *normalized* shapes; engines map their
 * provider-specific responses into these. Skills consuming the plugin's
 * tools or events see the same shape regardless of engine.
 */

export type EngineKind = "v20-xapi" | "v18-cc";

// ─── Config shapes (mirrored from manifest) ────────────────────────────

export type ThreeCxMode = "single" | "manual" | "native";

export interface CompanyRoutingEntry {
  companyId: string;
  extensionRanges?: string[];
  queueIds?: string[];
  dids?: string[];
  /** v0.3 only — synthetic queue.threshold per queue. */
  queueThresholds?: { queueId: string; depth: number; longestWaitSec?: number }[];
}

export interface CompanyTenantEntry {
  companyId: string;
  tenantId: string;
}

export interface ConfigAccount {
  key: string;
  displayName?: string;
  pbxBaseUrl: string;
  pbxVersion?: "20" | "18";
  clientIdRef: string;
  clientSecretRef: string;
  mode: ThreeCxMode;
  companyRouting?: CompanyRoutingEntry[];
  companyTenants?: CompanyTenantEntry[];
  allowedCompanies?: string[];
  exposeRecordings?: boolean;
  maxClickToCallPerDay?: number;
}

export interface InstanceConfig {
  allowMutations?: boolean;
  defaultAccount?: string;
  accounts?: ConfigAccount[];
}

// ─── Scope filter (constructed by the worker per company per mode) ────

export type ScopeFilter =
  | { mode: "single" }
  | {
      mode: "manual";
      extensions: string[];
      extensionRanges: string[];
      queueIds: string[];
      dids: string[];
    }
  | { mode: "native"; tenantId: string };

// ─── Resolved-account shape passed to the engine ──────────────────────

export interface ResolvedAccount {
  accountKey: string;
  account: ConfigAccount;
  scope: ScopeFilter;
}

// ─── Normalized read shapes ────────────────────────────────────────────

export type CallDirection = "inbound" | "outbound" | "internal";

export type AgentPresence =
  | "available"
  | "busy"
  | "away"
  | "dnd"
  | "offline";

export interface NormalizedQueue {
  id: string;
  /** Human-readable queue name, e.g. "Support". */
  name: string;
  /** Internal extension number callers dial. */
  extension: string;
  agentsOn: number;
  /** Calls waiting in the queue right now. */
  depth: number;
  /** Seconds the longest-waiting caller has been queued. */
  longestWaitSec: number;
}

export interface NormalizedQueueStatus {
  id: string;
  name: string;
  depth: number;
  longestWaitSec: number;
  agentsOn: number;
  agentsAvailable: number;
  callsToday: { offered: number; answered: number; abandoned: number };
  avgHandleSec: number;
}

export interface NormalizedParkedCall {
  slot: string;
  callerNumber: string;
  parkedSinceSec: number;
  originalExtension?: string;
}

export interface NormalizedActiveCall {
  callId: string;
  fromNumber: string;
  toNumber: string;
  extension?: string;
  queue?: string;
  startedAt: string;
  durationSec: number;
  direction: CallDirection;
}

export interface NormalizedAgent {
  extension: string;
  name: string;
  presence: AgentPresence;
  inCall: boolean;
  currentCallSec?: number;
  queueMemberships: string[];
}

export interface NormalizedDayStats {
  offered: number;
  answered: number;
  abandoned: number;
  internalCalls: number;
  avgWaitSec: number;
  avgHandleSec: number;
  peakDepth: number;
  abandonRate: number;
  sla: { answeredWithinTargetPct: number; targetSec: number };
}

export interface NormalizedCallRecord {
  callId: string;
  fromNumber: string;
  toNumber: string;
  extension?: string;
  queue?: string;
  startedAt: string;
  endedAt: string;
  durationSec: number;
  direction: CallDirection;
  /** "answered" | "abandoned" | "missed" | "voicemail" | "transferred" | "rejected" */
  disposition: string;
  /** Only present when account.exposeRecordings === true. */
  recordingUrl?: string;
}

export interface NormalizedDid {
  e164: string;
  label?: string;
  routedTo?: string;
  queue?: string;
}

export interface NormalizedExtension {
  number: string;
  displayName: string;
  type: "user" | "queue" | "ringgroup" | "system";
  email?: string;
}

export interface HistoryOpts {
  since: string;
  until?: string;
  direction?: CallDirection;
  extension?: string;
  queue?: string;
  limit?: number;
  cursor?: string;
}

// ─── Mutation inputs (Phase 2) ────────────────────────────────────────

export interface ClickToCallInput {
  fromExtension: string;
  toNumber: string;
  idempotencyKey?: string;
}

export interface ClickToCallResult {
  callId: string;
  status: string;
}

// ─── Realtime events (Phase 3) ────────────────────────────────────────

export type NormalizedPbxEvent =
  | {
      kind: "call.started";
      callId: string;
      from: string;
      to: string;
      extension?: string;
      queue?: string;
      direction: CallDirection;
      startedAt: string;
    }
  | {
      kind: "call.ended";
      callId: string;
      durationSec: number;
      disposition: string;
      endedAt: string;
    }
  | {
      kind: "queue.depth";
      queueId: string;
      depth: number;
      longestWaitSec: number;
    }
  | {
      kind: "agent.presence_changed";
      extension: string;
      presence: AgentPresence;
    };

// ─── Engine interface ──────────────────────────────────────────────────

export interface ThreeCxEngine {
  readonly engineKind: EngineKind;

  // ─── Reads (Phase 1) ──────────────────────────────────────────────
  listQueues(filter: ScopeFilter): Promise<NormalizedQueue[]>;
  getQueueStatus(filter: ScopeFilter, queueIdOrExt: string): Promise<NormalizedQueueStatus>;
  listParkedCalls(filter: ScopeFilter): Promise<NormalizedParkedCall[]>;
  listActiveCalls(filter: ScopeFilter): Promise<NormalizedActiveCall[]>;
  listAgents(filter: ScopeFilter, extension?: string): Promise<NormalizedAgent[]>;
  getTodayStats(filter: ScopeFilter, opts?: { queueId?: string; direction?: CallDirection }): Promise<NormalizedDayStats>;
  listCallHistory(filter: ScopeFilter, opts: HistoryOpts, exposeRecordings: boolean): Promise<{ calls: NormalizedCallRecord[]; nextCursor?: string }>;
  listDids(filter: ScopeFilter): Promise<NormalizedDid[]>;
  listExtensions(filter: ScopeFilter): Promise<NormalizedExtension[]>;

  // ─── Mutations (Phase 2) ──────────────────────────────────────────
  clickToCall(filter: ScopeFilter, input: ClickToCallInput): Promise<ClickToCallResult>;
  parkCall(filter: ScopeFilter, callId: string, slot?: string): Promise<{ slot: string }>;
  pickupPark(filter: ScopeFilter, slot: string, atExtension: string): Promise<void>;
  transferCall(filter: ScopeFilter, callId: string, toExtension: string, mode: "blind" | "attended"): Promise<void>;
  hangupCall(filter: ScopeFilter, callId: string): Promise<void>;

  // ─── Realtime (Phase 3) ───────────────────────────────────────────
  /**
   * Open a long-lived event stream. Handler is called once per inbound
   * event. The returned `close()` shuts down the stream (used by
   * `onShutdown` and `onConfigChanged`).
   *
   * Engines are responsible for reconnect-with-backoff. Token refresh on
   * disconnect happens transparently.
   */
  subscribeEvents(onEvent: (e: NormalizedPbxEvent) => void): Promise<{ close: () => Promise<void> }>;
}
