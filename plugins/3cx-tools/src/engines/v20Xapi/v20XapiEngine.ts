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
//
// Two API families on 3CX v20:
// 1. Configuration API (XAPI) at /xapi/v1/* — read-mostly, OData-shaped.
//    Authenticated by the OAuth client + the "Enable Configuration API"
//    checkbox on the Service Principal.
// 2. Call Control API at /callcontrol/* — REST-shaped, gated by the
//    separate "Enable Call Control API" checkbox AND requires per-extension
//    selection in the Service Principal config.
//
// Reads use XAPI exclusively. Mutations split: DropCall (hangup) is a
// Pbx.* function on XAPI, but MakeCall / Park / Transfer / Pickup are
// only on the Call Control API path family.
const EP = {
  // XAPI reads
  queues: "/xapi/v1/Queues",
  queue: (id: string) => `/xapi/v1/Queues(${encodeURIComponent(id)})`,
  activeCalls: "/xapi/v1/ActiveCalls",
  users: "/xapi/v1/Users",
  trunks: "/xapi/v1/Trunks",
  callHistory: "/xapi/v1/CallHistoryView",
  // XAPI mutation function endpoint (the only one in XAPI)
  dropCall: (callId: string) =>
    `/xapi/v1/ActiveCalls(${encodeURIComponent(callId)})/Pbx.DropCall`,
  // Call Control API (require separate enable on the Service Principal)
  ccMakeCall: (ext: string, deviceId: string) =>
    `/callcontrol/${encodeURIComponent(ext)}/devices/${encodeURIComponent(deviceId)}/makecall`,
  ccDevices: (ext: string) => `/callcontrol/${encodeURIComponent(ext)}/devices`,
  ccParticipants: (ext: string) =>
    `/callcontrol/${encodeURIComponent(ext)}/participants`,
  ccParticipantAction: (ext: string, participantId: string, action: string) =>
    `/callcontrol/${encodeURIComponent(ext)}/participants/${encodeURIComponent(participantId)}/${encodeURIComponent(action)}`,
  // Reports — endpoint name varies; we fall back to deriving from history.
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

  async listParkedCalls(_filter: ScopeFilter): Promise<NormalizedParkedCall[]> {
    // Parked calls are NOT exposed via XAPI on 3CX v20 — the OData metadata
    // only has CallParkingSettings (config), not a runtime parked-calls
    // collection. Live parked-call enumeration requires the Call Control
    // API, which the v0.1.0 engine doesn't yet integrate. Returning an
    // empty list (rather than throwing) keeps this tool usable as a
    // signal-of-absence; v0.2 will add Call Control API support.
    return [];
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
    // Field names confirmed against 3CX v20 swagger + forum examples: the
    // CallHistoryView entity uses SegmentStartTime / SegmentEndTime, with
    // OData v4 date() filter syntax (`date(SegmentStartTime) ge 2026-05-03`).
    // Source/destination DNs are SrcDn / DstDn, NOT CallerNumber/CalleeNumber.
    const params = new URLSearchParams();
    const filters: string[] = [];
    const sinceDate = opts.since.length >= 10 ? opts.since.slice(0, 10) : opts.since;
    filters.push(`date(SegmentStartTime) ge ${sinceDate}`);
    if (opts.until) {
      const untilDate = opts.until.slice(0, 10);
      filters.push(`date(SegmentStartTime) le ${untilDate}`);
    }
    if (opts.extension) {
      filters.push(`(SrcDn eq '${opts.extension}' or DstDn eq '${opts.extension}')`);
    }
    if (filters.length) params.set("$filter", filters.join(" and "));
    const top = Math.min(500, Math.max(1, opts.limit ?? 100));
    params.set("$top", String(top));
    const skip = opts.cursor ? Number(opts.cursor) : 0;
    if (skip > 0) params.set("$skip", String(skip));
    params.set("$orderby", "SegmentStartTime desc");

    const data = await this.client.get<ODataList<RawCallRecord>>(
      `${EP.callHistory}?${params.toString()}`,
    );
    const calls = (data.value ?? []).map((r) => toCallRecord(r, exposeRecordings));
    // Direction filter applied client-side because OData filtering on Direction
    // requires knowing 3CX's exact enum casing on this install.
    const directionFiltered = opts.direction
      ? calls.filter((c) => c.direction === opts.direction)
      : calls;
    const queueFiltered = opts.queue
      ? directionFiltered.filter((c) => c.queue === opts.queue)
      : directionFiltered;
    const scopeFiltered = filterCallHistory(filter, queueFiltered);
    const next =
      data["@odata.nextLink"] || scopeFiltered.length === top
        ? String(skip + top)
        : undefined;
    return { calls: scopeFiltered, nextCursor: next };
  }

  async listDids(filter: ScopeFilter): Promise<NormalizedDid[]> {
    // 3CX v20 returns DidNumbers inline as a primitive string[] on the
    // bare /Trunks response. `$expand=DidNumbers` is rejected with 400
    // because DidNumbers is a primitive collection, not a navigation
    // property — OData $expand is only valid for nav properties.
    const data = await this.client.getCached<ODataList<RawTrunk>>(EP.trunks);
    const normalized: NormalizedDid[] = [];
    for (const trunk of data.value ?? []) {
      const trunkLabel = trunk.Gateway?.Name ?? trunk.Number;
      // 3CX v20: DidNumbers is a string[] of bare/E.164 numbers, not an
      // array of objects. Confirmed against a live 3CX v20 install 2026-05-03.
      for (const raw of trunk.DidNumbers ?? []) {
        const did = typeof raw === "string" ? raw : ((raw as RawDid).Number ?? "");
        if (!did) continue;
        normalized.push({
          e164: normalizeE164(did),
          label: trunkLabel,
          routedTo: undefined,
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
    if (
      filter.mode === "manual" &&
      filter.extensions.length > 0 &&
      !filter.extensions.includes(input.fromExtension)
    ) {
      throw new Error(
        `[ESCOPE_VIOLATION] fromExtension "${input.fromExtension}" is not in the company's extension scope.`,
      );
    }
    // Pick a device for the originating extension. The first registered
    // hard-phone wins (soft-clients are deprioritised in resolveDeviceId).
    const deviceId = await this.resolveDeviceId(input.fromExtension);
    // Normalize first ("555.123.4567" → "+15551234567"), then apply the
    // company's outbound prefix. The prefix step strips the leading "+"
    // so the final dial string matches 3CX's outbound-rule expectations.
    const normalized = normalizeUSDestination(input.toNumber);
    const destination = applyOutboundPrefix(normalized, filter);
    const body = {
      destination,
      idempotencyKey: input.idempotencyKey,
    };
    try {
      const res = await this.client.post<{ result?: { callid?: string; callId?: string }; callid?: string; callId?: string; status?: string }>(
        EP.ccMakeCall(input.fromExtension, deviceId),
        body,
      );
      const callId = res.result?.callid ?? res.result?.callId ?? res.callid ?? res.callId ?? `pending-${Date.now()}`;
      return { callId, status: res.status ?? "initiated" };
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("[E3CX_AUTH]") || msg.includes("[E3CX_HTTP_403]")) {
        throw new Error(
          `[E3CX_CC_NOT_ENABLED] MakeCall via Call Control API failed (${msg}). ` +
            `Verify "Enable access to the 3CX Call Control API" is checked on the Service Principal in 3CX admin, ` +
            `and that the Extension(s) selector includes ${input.fromExtension}.`,
        );
      }
      throw err;
    }
  }

  /**
   * Park an active call. 3CX v20 Call Control API doesn't expose a
   * dedicated `park` action; the conventional implementation is to
   * `routeto` the call to a park-slot extension (typically 8000-8009 in
   * default 3CX configs). The slot becomes the addressable handle for
   * picking the call back up later.
   *
   * Slot resolution strategy:
   *   - If `slot` is provided, route there.
   *   - Otherwise default to "8000" (the conventional first park slot).
   *
   * Operators with non-default park slot ranges should pass `slot`
   * explicitly. The plugin doesn't probe 3CX's CallParkingSettings to
   * discover the range — that's a v0.3 refinement.
   */
  async parkCall(filter: ScopeFilter, callId: string, slot?: string): Promise<{ slot: string }> {
    const targetSlot = slot ?? "8000";
    const ownerExt = await this.lookupCallOwner(callId);
    if (filter.mode === "manual" && filter.extensions.length > 0 && !filter.extensions.includes(ownerExt)) {
      throw new Error(
        `[ESCOPE_VIOLATION] callId "${callId}" lives on extension "${ownerExt}" which is outside the company's scope.`,
      );
    }
    try {
      await this.client.post(
        EP.ccParticipantAction(ownerExt, callId, "routeto"),
        { destination: targetSlot },
      );
      return { slot: targetSlot };
    } catch (err) {
      throw mapCcError(err, "park", { ext: ownerExt, callId, slot: targetSlot });
    }
  }

  /**
   * Pick up a parked call from a specific extension. Conventionally
   * implemented as "MakeCall from atExtension to the park slot" — the
   * PBX bridges the parked party in when atExtension goes off-hook.
   */
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
    const deviceId = await this.resolveDeviceId(atExtension);
    try {
      await this.client.post(
        EP.ccMakeCall(atExtension, deviceId),
        { destination: slot },
      );
    } catch (err) {
      throw mapCcError(err, "pickup_park", { atExtension, slot });
    }
  }

  /**
   * Transfer an active call to another extension via Call Control API's
   * `transferto` action. 3CX v20 doesn't distinguish blind vs attended
   * at the API level — `transferto` is effectively blind (one-shot
   * hand-off). The `mode` parameter is accepted for API stability with
   * the engine interface but has no on-PBX effect today.
   */
  async transferCall(
    filter: ScopeFilter,
    callId: string,
    toExtension: string,
    _mode: "blind" | "attended",
  ): Promise<void> {
    const ownerExt = await this.lookupCallOwner(callId);
    if (filter.mode === "manual" && filter.extensions.length > 0) {
      if (!filter.extensions.includes(ownerExt)) {
        throw new Error(
          `[ESCOPE_VIOLATION] callId "${callId}" lives on extension "${ownerExt}" which is outside the company's scope.`,
        );
      }
      if (!filter.extensions.includes(toExtension)) {
        throw new Error(
          `[ESCOPE_VIOLATION] transfer target "${toExtension}" is not in the company's extension scope.`,
        );
      }
    }
    try {
      await this.client.post(
        EP.ccParticipantAction(ownerExt, callId, "transferto"),
        { destination: toExtension },
      );
    } catch (err) {
      throw mapCcError(err, "transfer", { ext: ownerExt, callId, toExtension });
    }
  }

  /**
   * Resolve which extension currently owns a participant id by scanning
   * /xapi/v1/ActiveCalls. Required because Call Control API actions are
   * keyed by both DN (extension) and participant id, but the plugin's
   * tool surface only takes a callId — we look up the DN here so callers
   * don't have to thread it through.
   */
  private async lookupCallOwner(callId: string): Promise<string> {
    const data = await this.client.get<ODataList<RawActiveCall>>(EP.activeCalls);
    const match = (data.value ?? []).find(
      (c) => String(c.CallId ?? c.Id ?? "") === callId,
    );
    if (!match || !match.Extension) {
      throw new Error(
        `[E3CX_NOT_FOUND] No active call with id "${callId}" — cannot resolve owning extension. Try pbx_active_calls to see live calls.`,
      );
    }
    return match.Extension;
  }

  async hangupCall(_filter: ScopeFilter, callId: string): Promise<void> {
    // DropCall IS in XAPI as an OData function on the ActiveCall entity:
    //   POST /xapi/v1/ActiveCalls({id})/Pbx.DropCall
    // (Confirmed via the published 3CX v20 swagger.)
    await this.client.post(EP.dropCall(callId), {});
  }

  /**
   * Look up a device on an extension to use as the originating endpoint
   * for MakeCall. 3CX's Call Control API returns a top-level array of
   * device records with these fields (confirmed against a live v20
   * install 2026-05-03):
   *
   *     { dn: "200", device_id: "sip:200@192.168.27.40:5065", user_agent: "Yealink SIP-T48U ..." }
   *
   * `device_id` is a full SIP URI, not a plain UUID — must be
   * URL-encoded when slotted into the makecall path.
   *
   * Selection heuristic: prefer a registered hard-phone over a
   * soft-client. We rank by:
   *   1. Skip mobile-client / web-client (loopback IP, "Mobile Client",
   *      "WebClient" user-agent strings).
   *   2. Pick the first remaining device.
   *   3. If everything was filtered, fall back to the first raw device.
   *
   * This matches the operator intuition that "click-to-call from ext
   * 200" means "ring the deskphone, then dial out" — not "open the 3CX
   * mobile app on the phone in my pocket."
   */
  private async resolveDeviceId(extension: string): Promise<string> {
    try {
      const devices = await this.client.get<RawCcDevice[]>(EP.ccDevices(extension));
      if (!devices || devices.length === 0) {
        throw new Error(
          `[E3CX_NO_DEVICE] Extension "${extension}" has no registered devices listed.`,
        );
      }
      const preferred = devices.filter((d) => !isSoftClient(d)) ?? devices;
      const chosen = (preferred.length > 0 ? preferred : devices)[0];
      const id = chosen?.device_id;
      if (!id) {
        throw new Error(
          `[E3CX_NO_DEVICE] Extension "${extension}" has devices but no device_id field. ` +
            `Raw shape: ${JSON.stringify(chosen).slice(0, 200)}`,
        );
      }
      return id;
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("[E3CX_HTTP_403]") || msg.includes("[E3CX_AUTH]")) {
        throw new Error(
          `[E3CX_CC_NOT_ENABLED] /callcontrol device listing returned ${msg}. ` +
            `The Service Principal needs Call Control API access enabled AND Extension "${extension}" added to its Extension(s) selector.`,
        );
      }
      throw err;
    }
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
  /** Per the 3CX v20 swagger/forum examples, the canonical fields are these.
   *  Older docs / swagger excerpts still reference CallId, etc. — accept both. */
  SegmentId?: string;
  SegmentStartTime?: string;
  SegmentEndTime?: string;
  SrcDn?: string;
  DstDn?: string;
  SrcExtendedDisplayName?: string;
  DstExtendedDisplayName?: string;
  CallTime?: number;
  CallAnswered?: boolean;
  // Legacy / alternate field names (swagger ambiguity):
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
  /** Top-level `Name` may be absent on v20 trunks; the human-friendly
   *  display name lives at `Gateway.Name`. We accept both for resilience. */
  Name?: string;
  Gateway?: { Name?: string; Type?: string };
  /** v20 returns a plain `string[]` of E.164 (or bare) DIDs. Older
   *  swaggers reference an object array; we accept both for robustness. */
  DidNumbers?: Array<string | RawDid>;
}

interface RawDid {
  Number?: string;
  Description?: string;
  DestinationNumber?: string;
}

/** Normalize a DID to E.164 with `+` prefix. `15555550100` → `+15555550100`. */
function normalizeE164(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("+")) return trimmed;
  if (/^\d{10,15}$/.test(trimmed)) return `+${trimmed}`;
  return trimmed;
}

interface RawCcDevice {
  dn?: string;
  device_id?: string;
  user_agent?: string;
}

/**
 * Apply a per-company outbound dial prefix to the destination, stripping
 * any leading "+" so the result matches what 3CX's outbound rules expect
 * (a digit prefix followed by a full number). E.g. prefix "9" with
 * toNumber "+18005551212" → "918005551212".
 *
 * No-op when filter is not manual mode or has no prefix configured.
 */
export function applyOutboundPrefix(toNumber: string, filter: ScopeFilter): string {
  if (filter.mode !== "manual") return toNumber;
  const prefix = filter.outboundDialPrefix;
  if (!prefix) return toNumber;
  const stripped = toNumber.startsWith("+") ? toNumber.slice(1) : toNumber;
  return `${prefix}${stripped}`;
}

/**
 * Normalize a North-American phone number written in any common format
 * to E.164 (`+1XXXXXXXXXX`). Accepts:
 *   "555.123.4567"  → "+15551234567"
 *   "555-123-4567"  → "+15551234567"
 *   "(717) 577-1023" → "+15551234567"
 *   "5551234567"    → "+15551234567"   (10 digits → assume US/Canada)
 *   "15551234567"   → "+15551234567"   (11 digits leading 1)
 *   "+15551234567"  → "+15551234567"   (already E.164, passthrough)
 *   "+44 20 7946 0958" → "+442079460958" (international, kept as-is)
 *
 * Anything that doesn't fit one of these shapes is returned unchanged so
 * an operator can pass exotic dial strings (PIN-prefixed, internal
 * extension dialing, etc.) without the plugin second-guessing them.
 *
 * The output of this function is the input to `applyOutboundPrefix` —
 * always run normalization first so a user typing "555.123.4567" with
 * a company prefix "9" ends up dialing "915551234567".
 */
export function normalizeUSDestination(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return trimmed;

  // International (already-prefixed-with-+) — strip whitespace/dashes,
  // keep the leading + and digits.
  if (trimmed.startsWith("+")) {
    const compact = "+" + trimmed.slice(1).replace(/[^\d]/g, "");
    return compact.length > 1 ? compact : trimmed;
  }

  // Internal extension (3-5 digits) — pass through unchanged so click-to-call
  // can dial extension-to-extension within the PBX without normalization.
  if (/^\d{3,5}$/.test(trimmed)) return trimmed;

  // Strip non-digits and decide based on length.
  const digits = trimmed.replace(/[^\d]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;

  // Doesn't match a recognized US/CA shape; leave untouched.
  return trimmed;
}

/**
 * Translate Call Control API errors into the plugin's `[E3CX_*]` codes.
 * 403 typically means the Service Principal's Call Control API isn't
 * enabled or the operating extension isn't in its Extensions selector;
 * 404 means the participant id is unknown (call already ended); 4xx
 * other = bad request. 5xx = upstream.
 */
function mapCcError(err: unknown, action: string, detail: Record<string, unknown>): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("[E3CX_AUTH]") || msg.includes("[E3CX_HTTP_403]")) {
    return new Error(
      `[E3CX_CC_NOT_ENABLED] /callcontrol ${action} returned 403. ` +
        `Verify "Enable access to the 3CX Call Control API" is checked on the Service Principal AND the operating extension is added to its Extension(s) selector. detail=${JSON.stringify(detail)}`,
    );
  }
  if (msg.includes("[E3CX_NOT_FOUND]")) {
    return new Error(
      `[E3CX_NOT_FOUND] ${action}: participant or destination not found. detail=${JSON.stringify(detail)}`,
    );
  }
  return new Error(`[E3CX_CC_FAILED] ${action} via Call Control API failed: ${msg}`);
}

/** Soft-clients (mobile / web) ring inside an app, not on a desk phone.
 *  We prefer skipping them when picking a "ring from this extension"
 *  device for click-to-call. Heuristic on user_agent + device_id host. */
function isSoftClient(d: RawCcDevice): boolean {
  const ua = (d.user_agent ?? "").toLowerCase();
  const id = (d.device_id ?? "").toLowerCase();
  if (ua.includes("mobile client")) return true;
  if (ua.includes("webclient")) return true;
  if (ua.includes("web client")) return true;
  if (ua.includes("3cx softphone")) return true;
  // SIP URI on loopback usually = soft-client running on the PBX itself
  if (id.includes("@127.0.0.1")) return true;
  return false;
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
  const startedAt = r.SegmentStartTime ?? r.StartTime ?? new Date().toISOString();
  const endedAt = r.SegmentEndTime ?? r.EndTime ?? startedAt;
  // CallTime is seconds in v20; DurationSec is the legacy field name.
  const durationSec =
    typeof r.CallTime === "number"
      ? r.CallTime
      : (r.DurationSec ?? 0);
  // SrcDn / DstDn are the canonical source/destination DNs in v20. Numbers
  // come back as either bare digits or E.164; the active-calls / history
  // tools surface them as-is (operator can normalize on their side).
  const fromNumber = r.SrcDn ?? r.CallerNumber ?? "";
  const toNumber = r.DstDn ?? r.CalleeNumber ?? "";
  // Direction inferred from the DN pattern when v20 doesn't expose Direction
  // as a discrete column. External-looking → outbound/inbound; both internal → internal.
  const inferredDirection = inferDirection(fromNumber, toNumber, r.Direction);
  // Disposition: v20 uses CallAnswered (bool); older swagger uses Status string.
  let disposition = mapStatus(r.Status);
  if (r.CallAnswered === true) disposition = "answered";
  if (r.CallAnswered === false && !r.Status) disposition = "missed";
  return {
    callId: String(r.SegmentId ?? r.CallId ?? ""),
    fromNumber,
    toNumber,
    extension: r.Extension ?? extensionFromDn(fromNumber, toNumber),
    queue: r.Queue,
    startedAt,
    endedAt,
    durationSec,
    direction: inferredDirection,
    disposition,
    recordingUrl: exposeRecordings && r.RecordingUrl ? r.RecordingUrl : undefined,
  };
}

function inferDirection(
  src: string,
  dst: string,
  declared: string | undefined,
): "inbound" | "outbound" | "internal" {
  if (declared) return mapDirection(declared);
  const srcInternal = isInternalDn(src);
  const dstInternal = isInternalDn(dst);
  if (srcInternal && dstInternal) return "internal";
  if (srcInternal && !dstInternal) return "outbound";
  if (!srcInternal && dstInternal) return "inbound";
  return "internal"; // unknown — default
}

function isInternalDn(dn: string): boolean {
  // 3CX internal DNs are typically 3-4 digit extension numbers; external are
  // 10+ digits or contain '+'. This heuristic is good enough for direction
  // inference; explicit Direction field always wins when present.
  if (!dn) return false;
  if (dn.startsWith("+")) return false;
  return /^\d{2,5}$/.test(dn);
}

function extensionFromDn(src: string, dst: string): string | undefined {
  if (isInternalDn(src)) return src;
  if (isInternalDn(dst)) return dst;
  return undefined;
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
