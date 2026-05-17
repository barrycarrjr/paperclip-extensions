/**
 * HTTP route handlers for Jambonz application hooks (DIY engine).
 *
 * Jambonz POSTs to:
 *   /api/plugins/phone-tools/api/diy/jambonz/call?accountKey=...&callSid=...
 *     — on call answer; we respond with [say firstMessage, gather caller]
 *   /api/plugins/phone-tools/api/diy/jambonz/next?accountKey=...&callSid=...
 *     — on each subsequent gather completion; we call the LLM and return
 *       [say <llm reply>, gather caller]
 *   /api/plugins/phone-tools/api/diy/jambonz/status?accountKey=...&callSid=...
 *     — on call status changes (call_status hook); we update local state
 *       and emit normalized events to consumers.
 *
 * All three are auth: "webhook" — no Paperclip credential is sent; the
 * plugin verifies a Jambonz HMAC signature inside the handler.
 */

import type {
  PluginApiRequestInput,
  PluginApiResponse,
  PluginContext,
} from "@paperclipai/plugin-sdk";
import { getDiyEngineForAccount } from "../engines/registry.js";
import type { NormalizedPhoneEvent } from "../engines/types.js";

const ROUTE_KEYS = {
  call: "diy.jambonz.call",
  next: "diy.jambonz.next",
  status: "diy.jambonz.status",
} as const;

function readQuery(input: PluginApiRequestInput, key: string): string | undefined {
  const q = (input as unknown as { query?: Record<string, string | string[]> }).query;
  if (!q) return undefined;
  const v = q[key];
  if (Array.isArray(v)) return v[0];
  return v;
}

function readHeader(input: PluginApiRequestInput, name: string): string | undefined {
  const h = (input as unknown as { headers?: Record<string, string | string[]> }).headers;
  if (!h) return undefined;
  const v = h[name] ?? h[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return v;
}

function readRawBody(input: PluginApiRequestInput): string {
  const raw = (input as unknown as { rawBody?: string; body?: unknown }).rawBody;
  if (typeof raw === "string") return raw;
  const body = (input as unknown as { body?: unknown }).body;
  if (typeof body === "string") return body;
  if (body && typeof body === "object") return JSON.stringify(body);
  return "";
}

function readJsonBody(input: PluginApiRequestInput): unknown {
  const body = (input as unknown as { body?: unknown }).body;
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }
  return body ?? null;
}

export async function handleDiyJambonzApi(
  ctx: PluginContext,
  input: PluginApiRequestInput,
  emit: (event: NormalizedPhoneEvent, accountKey: string, allowedCompanies: string[]) => Promise<void>,
): Promise<PluginApiResponse | null> {
  if (
    input.routeKey !== ROUTE_KEYS.call &&
    input.routeKey !== ROUTE_KEYS.next &&
    input.routeKey !== ROUTE_KEYS.status
  ) {
    return null;
  }

  const accountKey = readQuery(input, "accountKey");
  const callSid = readQuery(input, "callSid");
  if (!accountKey || !callSid) {
    return {
      status: 400,
      body: { error: "missing accountKey or callSid query param" },
    };
  }

  const resolved = await getDiyEngineForAccount(ctx, accountKey);
  if (!resolved) {
    return {
      status: 404,
      body: { error: `no DIY engine for accountKey="${accountKey}"` },
    };
  }
  const { account, engine } = resolved;

  const signature =
    readHeader(input, "x-jambonz-signature") ?? readHeader(input, "jambonz-signature");
  const rawBody = readRawBody(input);

  if (input.routeKey === ROUTE_KEYS.call) {
    const r = await engine.handleCallHook(callSid, rawBody, signature);
    if (!r.ok) return { status: r.status, body: { error: r.reason } };
    return { status: 200, body: r.verbs };
  }

  if (input.routeKey === ROUTE_KEYS.next) {
    const parsed = readJsonBody(input) as
      | { speech?: { transcript?: string } }
      | null;
    const r = await engine.handleNextHook(callSid, rawBody, signature, parsed);
    if (!r.ok) return { status: r.status, body: { error: r.reason } };
    return { status: 200, body: r.verbs };
  }

  // status
  const parsed = readJsonBody(input) as {
    call_status?: string;
    duration?: number;
    end_time?: string;
    termination_reason?: string;
    recording_url?: string;
  } | null;
  const r = await engine.handleStatusHook(callSid, rawBody, signature, parsed);
  if (!r.ok) return { status: r.status, body: { error: r.reason } };
  if (r.event) {
    const allowed = (account.allowedCompanies ?? []).filter((c) => c && c !== "*");
    await emit(r.event, account.key ?? accountKey, allowed);
  }
  return { status: 200, body: { ok: true } };
}
