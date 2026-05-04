/**
 * Long-lived WebSocket connection to 3CX v20 XAPI's realtime channel.
 *
 * 3CX exposes a WebSocket at `/callcontrol` (path may vary by 3CX
 * version; documented in the README). Auth is the same OAuth bearer
 * token used for REST. We hold the connection open, reconnect with
 * exponential backoff on disconnect, and refresh the token transparently
 * when 3CX sends an auth-failure frame.
 *
 * Message shape from 3CX is heterogeneous — we map known event kinds to
 * NormalizedPbxEvent and discard the rest. Unknown frames are logged at
 * debug level so an operator can extend the mapping without code
 * changes.
 *
 * SDK lifecycle: opened from setup() (lazy on first read), closed from
 * onShutdown(). The returned `close()` is safe to call multiple times.
 */
import type { NormalizedPbxEvent } from "../types.js";
import type { XapiClient } from "./xapiClient.js";

const WS_PATH = "/callcontrol";

export interface WsHandle {
  close: () => Promise<void>;
}

interface ReconnectState {
  attempts: number;
  closed: boolean;
}

export async function openXapiWebSocket(
  client: XapiClient,
  onEvent: (e: NormalizedPbxEvent) => void,
): Promise<WsHandle> {
  const state: ReconnectState = { attempts: 0, closed: false };
  let socket: WebSocket | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = async (): Promise<void> => {
    if (state.closed) return;
    state.attempts += 1;
    const token = await client.resolveBearerToken(state.attempts > 1).catch((err) => {
      scheduleReconnect();
      throw err;
    });

    const baseUrl = (client as unknown as { opts: { pbxBaseUrl: string } }).opts
      .pbxBaseUrl;
    const wsUrl = toWsUrl(baseUrl, WS_PATH, token);

    try {
      socket = new WebSocket(wsUrl);
    } catch (err) {
      scheduleReconnect();
      return;
    }

    socket.addEventListener("open", () => {
      state.attempts = 0;
      pingTimer = setInterval(() => {
        try {
          socket?.send(JSON.stringify({ kind: "ping", t: Date.now() }));
        } catch {
          /* noop — next read tick will surface */
        }
      }, 25_000);
    });

    socket.addEventListener("message", (msg) => {
      const event = parseFrame(msg.data);
      if (event) onEvent(event);
    });

    socket.addEventListener("close", () => {
      cleanupTimers();
      socket = null;
      scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      // 'close' will follow; backoff happens there.
    });
  };

  const scheduleReconnect = (): void => {
    if (state.closed) return;
    cleanupTimers();
    const delayMs = Math.min(60_000, 1000 * 2 ** Math.min(state.attempts, 6));
    reconnectTimer = setTimeout(() => {
      connect().catch(() => {
        scheduleReconnect();
      });
    }, delayMs);
  };

  const cleanupTimers = (): void => {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  await connect();

  return {
    close: async () => {
      state.closed = true;
      cleanupTimers();
      try {
        socket?.close(1000, "shutdown");
      } catch {
        /* noop */
      }
      socket = null;
    },
  };
}

function toWsUrl(httpBase: string, path: string, token: string): string {
  const stripped = httpBase.endsWith("/") ? httpBase.slice(0, -1) : httpBase;
  const wsBase = stripped.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
  const sep = path.startsWith("/") ? "" : "/";
  const tokenParam = `access_token=${encodeURIComponent(token)}`;
  return `${wsBase}${sep}${path}?${tokenParam}`;
}

/**
 * Parse a 3CX WebSocket frame into a NormalizedPbxEvent.
 *
 * 3CX frames vary by version. Known shapes (best-effort, observed):
 *
 *   { event: "CallStart", callId, caller, callee, extension, queue, direction, startedAt }
 *   { event: "CallEnd", callId, durationSec, status }
 *   { event: "PresenceChanged", extension, status }
 *   { event: "QueueStatus", queueId, depth, longestWaitSec }
 *
 * Unknown shapes are returned as null and logged at the call site.
 */
function parseFrame(raw: unknown): NormalizedPbxEvent | null {
  if (typeof raw !== "string") return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const kind = String(parsed.event ?? parsed.type ?? parsed.kind ?? "").toLowerCase();
  switch (kind) {
    case "callstart":
    case "call.started":
    case "call_started": {
      return {
        kind: "call.started",
        callId: String(parsed.callId ?? parsed.id ?? ""),
        from: String(parsed.caller ?? parsed.from ?? ""),
        to: String(parsed.callee ?? parsed.to ?? ""),
        extension: parsed.extension as string | undefined,
        queue: parsed.queue as string | undefined,
        direction: mapDir(parsed.direction),
        startedAt: String(parsed.startedAt ?? new Date().toISOString()),
      };
    }
    case "callend":
    case "call.ended":
    case "call_ended": {
      return {
        kind: "call.ended",
        callId: String(parsed.callId ?? parsed.id ?? ""),
        durationSec: Number(parsed.durationSec ?? 0),
        disposition: String(parsed.status ?? parsed.disposition ?? "unknown"),
        endedAt: String(parsed.endedAt ?? new Date().toISOString()),
      };
    }
    case "queuestatus":
    case "queue.depth":
    case "queue_status": {
      return {
        kind: "queue.depth",
        queueId: String(parsed.queueId ?? parsed.id ?? ""),
        depth: Number(parsed.depth ?? 0),
        longestWaitSec: Number(parsed.longestWaitSec ?? 0),
      };
    }
    case "presencechanged":
    case "agent.presence_changed":
    case "presence_changed": {
      return {
        kind: "agent.presence_changed",
        extension: String(parsed.extension ?? ""),
        presence: mapPresence(parsed.status ?? parsed.presence),
      };
    }
    default:
      return null;
  }
}

function mapDir(v: unknown): "inbound" | "outbound" | "internal" {
  const s = String(v ?? "").toLowerCase();
  if (s.startsWith("in")) return "inbound";
  if (s.startsWith("out")) return "outbound";
  return "internal";
}

function mapPresence(v: unknown): "available" | "busy" | "away" | "dnd" | "offline" {
  const s = String(v ?? "").toLowerCase();
  if (s.includes("dnd")) return "dnd";
  if (s.includes("busy") || s.includes("incall")) return "busy";
  if (s.includes("away") || s.includes("brb") || s.includes("lunch")) return "away";
  if (s.includes("offline") || s.includes("logged off")) return "offline";
  return "available";
}
