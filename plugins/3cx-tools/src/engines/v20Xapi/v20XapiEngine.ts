/**
 * v20 XAPI engine — talks to 3CX v20's REST + WebSocket surface.
 *
 * Endpoint paths are constants so the operator can override them in a
 * future iteration if 3CX renames anything; the shape mapping is the
 * heavyweight part. All shapes returned upstream are the normalized
 * shapes from `engines/types.ts` — no provider-specific leakage.
 *
 * Implementation notes
 * ────────────────────
 * - Pagination uses OData `$top`/`$skip`. The plugin returns a
 *   string-encoded `nextCursor` that decodes back to `$skip`.
 * - Date params on report endpoints are passed in ISO 8601.
 * - Manual-mode scoping is applied client-side after the API call;
 *   native-mode scoping happens server-side via the X-3CX-Tenant header
 *   set by the XapiClient.
 * - Mutation endpoints follow the OData "function" style (POST to a
 *   `Pbx.<Action>` path).
 */
import type {
  ClickToCallInput,
  ClickToCallResult,
  HistoryOpts,
  NormalizedActiveCall,
  NormalizedAgent,
  NormalizedCallRecord,
  NormalizedDayStats,
  NormalizedDid,
  NormalizedExtension,
  NormalizedParkedCall,
  NormalizedPbxEvent,
  NormalizedQueue,
  NormalizedQueueStatus,
  ScopeFilter,
  ThreeCxEngine,
} from "../types.js";
import {
  filterActiveCalls,
  filterAgents,
  filterCallHistory,
  filterDids,
  filterExtensions,
  filterParkedCalls,
  filterQueues,
} from "../filterApply.js";
import { XapiClient } from "./xapiClient.js";
import { openXapiWebSocket } from "./websocket.js";

// ─── Endpoint constants ──────────────────────────────────────────────
const EP = {
  queues: "/xapi/v1/Queues",
  queue: (id: string) => `/xapi/v1/Queues(${encodeURIComponent(id)})`,
  activeCalls: "/xapi/v1/ActiveCalls",
  parkedCalls: "/xapi/v1/ParkedCalls",
  users: "/xapi/v1/Users",
  trunks: "/xapi/v1/Trunks",
  callHistory: "/xapi/v1/CallHistoryView",
  // POST function endpoints
  makeCall: "/xapi/v1/Pbx.MakeCall",
  hangupCall: "/xapi/v1/Pbx.HangupCall",
  transferCall: "/xapi/v1/Pbx.TransferCall",
  parkCall: "/xapi/v1/Pbx.ParkCall",
  pickupPark: "/xapi/v1/Pbx.PickupPark",
  // Reports
  reportToday: "/xapi/v1/ReportCallSummaryByDayData",
};

interface ODataList<T> {
  "@odata.context"?: string;
  "@odata.count"?: number;
  value: T[];
  "@odata.nextLink"?: string;
}

export class V20XapiEngine implements ThreeCxEngine {
  readonly engineKind = "v20-xapi" as const;

  constructor(private readonly client: XapiClient) {}

  // ─── Reads ───────────────────────────────────────────────────────

  async listQueues(filter: ScopeFilter): Promise<NormalizedQueue[]> {
    const data = await this.client.getCached<ODataList<RawQueue>>(
      `${EP.queues}?$expand=Agents`,
    );
    const normalized: NormalizedQueue[] = (data.value ?? []).map(toQueue);
    return filterQueues(filter, normalized);
  }

  async getQueueStatus(filter: ScopeFilter, queueIdOrExt: string): Promise<NormalizedQueueStatus> {
    // Resolve identifier to internal id by listing queues if the caller passed an extension.
    const queues = await this.listQueues(filter);
    const queue = queues.find(
      (q) => q.id === queueIdOrExt || q.extension === queueIdOrExt,
    );
    if (!queue) {
      throw new Error(
        `[E3CX_NOT_FOUND] Queue "${queueIdOrExt}" not found in scope.`,
      );
    }
    const detail = await this.client.getCached<RawQueueDetail>(
      `${EP.queue(queue.id)}?$expand=Agents`,
    );
    const agentsTotal = (detail.Agents ?? []).length;
    const agentsAvailable = (detail.Agents ?? []).filter(
      (a) => mapPresence(a.Status) === "available" && !a.IsLoggedIn === false,
    ).length;
    const callsToday = await this.fetchTodayCounts(filter, queue.id);
    return {
      id: queue.id,
      name: queue.name,
      depth: queue.depth,
      longestWaitSec: queue.longestWaitSec,
      agentsOn: queue.agentsOn,
      agentsAvailable,
      callsToday,
      avgHandleSec: detail.AverageHandleTimeSec ?? 0,
    };
  }

  async listParkedCalls(filter: ScopeFilter): Promise<NormalizedParkedCall[]> {
    const data = await this.client.getCached<ODataList<RawParkedCall>>(EP.parkedCalls);
    const normalized = (data.value ?? []).map(toParkedCall);
    return filterParkedCalls(filter, normalized);
  }

  async listActiveCalls(filter: ScopeFilter): Promise<NormalizedActiveCall[]> {
    const data = await this.client.getCached<ODataList<RawActiveCall>>(EP.activeCalls);
    const normalized = (data.value ?? []).map(toActiveCall);
    return filterActiveCalls(filter, normalized);
  }

  async listAgents(filter: ScopeFilter, extension?: string): Promise<NormalizedAgent[]> {
    const path = extension
      ? `${EP.users}?$filter=Number eq '${encodeURIComponent(extension)}'`
      : `${EP.users}?$filter=Type eq 'User'&$top=500`;
    const data = await this.client.get<ODataList<RawUser>>(path);
    const normalized = (data.value ?? []).map(toAgent);
    return filterAgents(filter, normalized);
  }

  async getTodayStats(
    filter: ScopeFilter,
    opts: { queueId?: string; direction?: "inbound" | "outbound" | "internal" } = {},
  ): Promise<NormalizedDayStats> {
    const date = todayIso();
    const params = new URLSearchParams();
    params.set("startDt", date);
    params.set("endDt", date);
    if (opts.queueId) params.set("queueDns", opts.queueId);
    const path = `${EP.reportToday}?${params.toString()}`;
    let raw: RawDayStats;
    try {
      raw = await this.client.getCached<RawDayStats>(path, 30000);
    } catch {
      // Fallback: derive a coarse stats summary from call history when the
      // report endpoint is unavailable on this 3CX install.
      raw = await this.deriveDayStatsFromHistory(filter, opts);
    }
    const offered = raw.totalCalls ?? 0;
    const answered = raw.answeredCalls ?? 0;
    const abandoned = raw.abandonedCalls ?? 0;
    return {
      offered,
      answered,
      abandoned,
      internalCalls: raw.internalCalls ?? 0,
      avgWaitSec: raw.averageWaitSec ?? 0,
      avgHandleSec: raw.averageHandleTimeSec ?? 0,
      peakDepth: raw.peakQueueDepth ?? 0,
      abandonRate: offered > 0 ? abandoned / offered : 0,
      sla: {
        answeredWithinTargetPct:
          typeof raw.slaPercent === "number" ? raw.slaPercent : 0,
        targetSec: raw.slaTargetSec ?? 20,
      },
    };
  }

  async listCallHistory(
    filter: ScopeFilter,
    opts: HistoryOpts,
    exposeRecordings: boolean,
  ): Promise<{ calls: NormalizedCallRecord[]; nextCursor?: string }> {
    const params = new URLSearchParams();
    const filters: string[] = [];
    filters.push(`StartTime ge ${opts.since}`);
    if (opts.until) filters.push(`StartTime le ${opts.until}`);
    if (opts.direction) {
      const dir =
        opts.direction === "inbound"
          ? "Inbound"
          : opts.direction === "outbound"
            ? "Outbound"
            : "Internal";
      filters.push(`Direction eq '${dir}'`);
    }
    if (opts.extension) filters.push(`Extension eq '${opts.extension}'`);
    if (opts.queue) filters.push(`Queue eq '${opts.queue}'`);
    if (filters.length) params.set("$filter", filters.join(" and "));
    const top = Math.min(500, Math.max(1, opts.limit ?? 100));
    params.set("$top", String(top));
    const skip = opts.cursor ? Number(opts.cursor) : 0;
    if (skip > 0) params.set("$skip", String(skip));
    params.set("$orderby", "StartTime desc");

    const data = await this.client.get<ODataList<RawCallRecord>>(
      `${EP.callHistory}?${params.toString()}`,
    );
    const calls = (data.value ?? []).map((r) => toCallRecord(r, exposeRecordings));
    const filtered = filterCallHistory(filter, calls);
    const next =
      data["@odata.nextLink"] || filtered.length === top
        ? String(skip + top)
        : undefined;
    return { calls: filtered, nextCursor: next };
  }

  async listDids(filter: ScopeFilter): Promise<NormalizedDid[]> {
    const data = await this.client.getCached<ODataList<RawTrunk>>(
      `${EP.trunks}?$expand=DidNumbers`,
    );
    const normalized: NormalizedDid[] = [];
    for (const trunk of data.value ?? []) {
      for (const did of trunk.DidNumbers ?? []) {
        normalized.push({
          e164: did.Number ?? "",
          label: did.Description,
          routedTo: did.DestinationNumber,
        });
      }
    }
    return filterDids(filter, normalized);
  }

  async listExtensions(filter: ScopeFilter): Promise<NormalizedExtension[]> {
    const data = await this.client.get<ODataList<RawUser>>(`${EP.users}?$top=500`);
    const normalized: NormalizedExtension[] = (data.value ?? []).map((u) => ({
      number: String(u.Number ?? ""),
      displayName: [u.FirstName, u.LastName].filter(Boolean).join(" ") || u.Number || "",
      type: mapExtensionType(u.Type),
      email: u.EmailAddress ?? undefined,
    }));
    return filterExtensions(filter, normalized);
  }

  // ─── Mutations ───────────────────────────────────────────────────

  async clickToCall(filter: ScopeFilter, input: ClickToCallInput): Promise<ClickToCallResult> {
    // When extensionRanges is left empty (shared-extensions setup — one
    // physical extension serves multiple LLCs and the outbound trunk is
    // selected via dial prefix at runtime), we cannot validate
    // fromExtension against a per-company list. Fall back to the daily
    // click-to-call cap + allowMutations as the gates. When the operator
    // DOES populate extensionRanges, enforce strictly.
    if (
      filter.mode === "manual" &&
      filter.extensions.length > 0 &&
      !filter.extensions.includes(input.fromExtension)
    ) {
      throw new Error(
        `[ESCOPE_VIOLATION] fromExtension "${input.fromExtension}" is not in the company's extension scope.`,
      );
    }
    const body = {
      source: input.fromExtension,
      destination: input.toNumber,
      idempotencyKey: input.idempotencyKey,
    };
    const res = await this.client.post<{ callId?: string; status?: string }>(
      EP.makeCall,
      body,
    );
    const callId = res.callId ?? `unknown-${Date.now()}`;
    return { callId, status: res.status ?? "initiated" };
  }

  async parkCall(filter: ScopeFilter, callId: string, slot?: string): Promise<{ slot: string }> {
    const body: { callId: string; slot?: string } = { callId };
    if (slot !== undefined) body.slot = slot;
    const res = await this.client.post<{ slot?: string }>(EP.parkCall, body);
    if (!res.slot) throw new Error(`[E3CX_UPSTREAM] Pbx.ParkCall returned no slot.`);
    return { slot: res.slot };
  }

  async pickupPark(filter: ScopeFilter, slot: string, atExtension: string): Promise<void> {
    if (
      filter.mode === "manual" &&
      filter.extensions.length > 0 &&
      !filter.extensions.includes(atExtension)
    ) {
      throw new Error(
        `[ESCOPE_VIOLATION] atExtension "${atExtension}" is not in the company's extension scope.`,
      );
    }
    await this.client.post(EP.pickupPark, { slot, atExtension });
  }

  async transferCall(
    filter: ScopeFilter,
    callId: string,
    toExtension: string,
    mode: "blind" | "attended",
  ): Promise<void> {
    if (
      filter.mode === "manual" &&
      filter.extensions.length > 0 &&
      !filter.extensions.includes(toExtension)
    ) {
      throw new Error(
        `[ESCOPE_VIOLATION] transfer target "${toExtension}" is not in the company's extension scope.`,
      );
    }
    await this.client.post(EP.transferCall, { callId, toExtension, mode });
  }

  async hangupCall(_filter: ScopeFilter, callId: string): Promise<void> {
    await this.client.post(EP.hangupCall, { callId });
  }

  // ─── Realtime (Phase 3) ──────────────────────────────────────────

  async subscribeEvents(
    onEvent: (e: NormalizedPbxEvent) => void,
  ): Promise<{ close: () => Promise<void> }> {
    return openXapiWebSocket(this.client, onEvent);
  }

  // ─── Internal helpers ────────────────────────────────────────────

  private async fetchTodayCounts(
    filter: ScopeFilter,
    queueId: string,
  ): Promise<{ offered: number; answered: number; abandoned: number }> {
    try {
      const stats = await this.getTodayStats(filter, { queueId });
      return {
        offered: stats.offered,
        answered: stats.answered,
        abandoned: stats.abandoned,
      };
    } catch {
      return { offered: 0, answered: 0, abandoned: 0 };
    }
  }

  private async deriveDayStatsFromHistory(
    filter: ScopeFilter,
    opts: { queueId?: string; direction?: "inbound" | "outbound" | "internal" },
  ): Promise<RawDayStats> {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const since = startOfDay.toISOString();
    let cursor: string | undefined;
    let total = 0;
    let answered = 0;
    let abandoned = 0;
    let internal = 0;
    let waitSum = 0;
    let handleSum = 0;
    let counted = 0;
    do {
      const page: { calls: NormalizedCallRecord[]; nextCursor?: string } =
        await this.listCallHistory(
          filter,
          {
            since,
            direction: opts.direction,
            queue: opts.queueId,
            limit: 500,
            cursor,
          },
          false,
        );
      for (const c of page.calls) {
        total += 1;
        if (c.disposition === "answered") answered += 1;
        else if (c.disposition === "abandoned" || c.disposition === "missed")
          abandoned += 1;
        if (c.direction === "internal") internal += 1;
        handleSum += c.durationSec;
        counted += 1;
      }
      cursor = page.nextCursor;
      // Defensive cap to avoid runaway pagination.
      if (counted > 5000) break;
    } while (cursor);
    return {
      totalCalls: total,
      answeredCalls: answered,
      abandonedCalls: abandoned,
      internalCalls: internal,
      averageWaitSec: counted > 0 ? Math.round(waitSum / counted) : 0,
      averageHandleTimeSec: counted > 0 ? Math.round(handleSum / counted) : 0,
      peakQueueDepth: 0,
      slaPercent: 0,
      slaTargetSec: 20,
    };
  }
}

// ─── Raw 3CX shapes (best-effort; may need adjusting against live PBX) ─
// These reflect the documented 3CX v20 XAPI OData metadata. Each is kept
// permissive (`?:` optional) so a missing field downgrades gracefully.

interface RawQueue {
  Id: string;
  Number?: string;
  Name?: string;
  CurrentCalls?: number;
  WaitingCalls?: number;
  LongestWaitTimeSec?: number;
  Agents?: RawQueueAgent[];
}

interface RawQueueDetail extends RawQueue {
  AverageHandleTimeSec?: number;
}

interface RawQueueAgent {
  Number?: string;
  Status?: string;
  IsLoggedIn?: boolean;
}

interface RawParkedCall {
  Slot?: string;
  CallerId?: string;
  CallerNumber?: string;
  ParkedAt?: string;
  ParkedSinceSec?: number;
  OriginalExtension?: string;
}

interface RawActiveCall {
  Id?: string;
  CallId?: string;
  Caller?: string;
  Callee?: string;
  CallerNumber?: string;
  CalleeNumber?: string;
  Extension?: string;
  Queue?: string;
  StartedAt?: string;
  DurationSec?: number;
  Direction?: string;
}

interface RawUser {
  Number?: string;
  FirstName?: string;
  LastName?: string;
  EmailAddress?: string;
  Type?: string;
  Status?: string;
  CurrentCallSec?: number;
  Queues?: { Number?: string; Name?: string }[];
  IsLoggedIn?: boolean;
  IsInCall?: boolean;
}

interface RawCallRecord {
  CallId?: string;
  CallerNumber?: string;
  CalleeNumber?: string;
  Extension?: string;
  Queue?: string;
  StartTime?: string;
  EndTime?: string;
  DurationSec?: number;
  Direction?: string;
  Status?: string;
  RecordingUrl?: string;
}

interface RawDayStats {
  totalCalls?: number;
  answeredCalls?: number;
  abandonedCalls?: number;
  internalCalls?: number;
  averageWaitSec?: number;
  averageHandleTimeSec?: number;
  peakQueueDepth?: number;
  slaPercent?: number;
  slaTargetSec?: number;
}

interface RawTrunk {
  Number?: string;
  Name?: string;
  DidNumbers?: { Number?: string; Description?: string; DestinationNumber?: string }[];
}

// ─── Mappers (raw → normalized) ───────────────────────────────────────

function toQueue(r: RawQueue): NormalizedQueue {
  const agentsOn = (r.Agents ?? []).filter((a) => a.IsLoggedIn).length;
  return {
    id: r.Id,
    name: r.Name ?? r.Number ?? r.Id,
    extension: r.Number ?? r.Id,
    agentsOn,
    depth: r.WaitingCalls ?? r.CurrentCalls ?? 0,
    longestWaitSec: r.LongestWaitTimeSec ?? 0,
  };
}

function toParkedCall(r: RawParkedCall): NormalizedParkedCall {
  const since =
    r.ParkedSinceSec ??
    (r.ParkedAt ? Math.max(0, Math.floor((Date.now() - new Date(r.ParkedAt).getTime()) / 1000)) : 0);
  return {
    slot: String(r.Slot ?? ""),
    callerNumber: r.CallerNumber ?? r.CallerId ?? "unknown",
    parkedSinceSec: since,
    originalExtension: r.OriginalExtension,
  };
}

function toActiveCall(r: RawActiveCall): NormalizedActiveCall {
  const startedAt = r.StartedAt ?? new Date().toISOString();
  const dur =
    r.DurationSec ??
    Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
  return {
    callId: String(r.CallId ?? r.Id ?? ""),
    fromNumber: r.CallerNumber ?? r.Caller ?? "",
    toNumber: r.CalleeNumber ?? r.Callee ?? "",
    extension: r.Extension,
    queue: r.Queue,
    startedAt,
    durationSec: dur,
    direction: mapDirection(r.Direction),
  };
}

function toAgent(r: RawUser): NormalizedAgent {
  return {
    extension: r.Number ?? "",
    name: [r.FirstName, r.LastName].filter(Boolean).join(" ") || r.Number || "",
    presence: mapPresence(r.Status),
    inCall: !!r.IsInCall,
    currentCallSec: r.CurrentCallSec,
    queueMemberships: (r.Queues ?? [])
      .map((q) => q.Number ?? q.Name ?? "")
      .filter(Boolean),
  };
}

function toCallRecord(r: RawCallRecord, exposeRecordings: boolean): NormalizedCallRecord {
  const startedAt = r.StartTime ?? new Date().toISOString();
  const endedAt = r.EndTime ?? startedAt;
  return {
    callId: String(r.CallId ?? ""),
    fromNumber: r.CallerNumber ?? "",
    toNumber: r.CalleeNumber ?? "",
    extension: r.Extension,
    queue: r.Queue,
    startedAt,
    endedAt,
    durationSec: r.DurationSec ?? 0,
    direction: mapDirection(r.Direction),
    disposition: mapStatus(r.Status),
    recordingUrl: exposeRecordings && r.RecordingUrl ? r.RecordingUrl : undefined,
  };
}

function mapDirection(d?: string): "inbound" | "outbound" | "internal" {
  const s = (d ?? "").toLowerCase();
  if (s.startsWith("in")) return "inbound";
  if (s.startsWith("out")) return "outbound";
  return "internal";
}

function mapPresence(s?: string): NormalizedAgent["presence"] {
  const v = (s ?? "").toLowerCase();
  if (v.includes("dnd") || v.includes("do not")) return "dnd";
  if (v.includes("busy") || v.includes("incall")) return "busy";
  if (v.includes("away") || v.includes("brb") || v.includes("lunch")) return "away";
  if (v.includes("offline") || v.includes("logged off")) return "offline";
  return "available";
}

function mapStatus(s?: string): string {
  const v = (s ?? "").toLowerCase();
  if (v.includes("answer")) return "answered";
  if (v.includes("aband")) return "abandoned";
  if (v.includes("miss")) return "missed";
  if (v.includes("voice")) return "voicemail";
  if (v.includes("trans")) return "transferred";
  if (v.includes("reject") || v.includes("decline")) return "rejected";
  return v || "unknown";
}

function mapExtensionType(t?: string): "user" | "queue" | "ringgroup" | "system" {
  const v = (t ?? "").toLowerCase();
  if (v.includes("queue")) return "queue";
  if (v.includes("ring") || v.includes("group")) return "ringgroup";
  if (v.includes("system") || v.includes("ivr") || v.includes("conference")) return "system";
  return "user";
}

function todayIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
