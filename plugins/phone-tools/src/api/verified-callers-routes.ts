/**
 * Verified personal caller IDs via Twilio's OutgoingCallerIds API.
 *
 * Lets an operator add their cell phone (or any other number they
 * personally own but don't have routed through Vapi/Jambonz) as the
 * From number shown on outbound calls placed by their assistant.
 *
 * Why a separate Twilio creds field on the account: Vapi uses its own
 * Twilio sub-account internally — its API key can't manage the
 * operator's personal OutgoingCallerIds. The operator's own Twilio
 * account is the only place a verified personal caller ID can live.
 *
 * Flow:
 *   1. Operator submits a phone number via /verified-callers/request.
 *   2. We POST to Twilio's OutgoingCallerIds endpoint, which calls the
 *      number and returns a 6-digit `validation_code`.
 *   3. UI shows the code to the operator; they enter it on the keypad
 *      when their phone rings.
 *   4. UI polls /verified-callers/refresh which re-reads the Twilio
 *      list and caches it locally.
 *   5. /accounts/numbers merges the local cache so verified personal
 *      numbers appear in the wizard's caller-ID dropdown.
 *
 * Engine compatibility for actually USING a verified caller ID on a
 * placed call:
 *   - DIY (jambonz) — works: jambonz forwards whatever caller ID we
 *     pass to the SIP trunk.
 *   - Vapi          — does NOT work today. Vapi only lets you call
 *     from a phoneNumber it manages. The verified personal caller is
 *     shown in the dropdown with a note; if selected on a Vapi
 *     account the placeCall path falls back to the account's
 *     defaultNumberId and logs a warning.
 */

import type {
  PluginApiRequestInput,
  PluginApiResponse,
  PluginContext,
} from "@paperclipai/plugin-sdk";
import type { ConfigAccount, InstanceConfig } from "../engines/types.js";

interface VerifiedCallerRecord {
  /** Twilio OutgoingCallerId SID (PNxxxx…). Used as the dropdown id. */
  sid: string;
  e164: string;
  /** Human label (defaults to "Personal — <last 4>"). */
  label: string | null;
  /** ISO timestamp this entry was added/refreshed in our cache. */
  verifiedAt: string;
}

interface VerifiedCallerCache {
  accountSid: string;
  numbers: VerifiedCallerRecord[];
}

function stateKeyFor(accountKey: string): string {
  return `verified-callers:${accountKey}`;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readBodyAsObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  return body as Record<string, unknown>;
}

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

/**
 * Resolve a phone-tools account by key for the calling company. We
 * deliberately re-read the instance config (rather than going through
 * `getResolvedAccount`) because the Twilio creds are independent of
 * the engine connection — we don't want to fail this whole flow if
 * Vapi or Jambonz auth is broken.
 */
async function resolveAccountByKey(
  ctx: PluginContext,
  companyId: string,
  accountKey?: string,
): Promise<{ account: ConfigAccount; accountKey: string } | { error: string }> {
  const config = (await ctx.config.get()) as InstanceConfig | null;
  const accounts = config?.accounts ?? [];
  if (accounts.length === 0) {
    return { error: "No phone-tools accounts configured for this company." };
  }

  // Prefer explicit key; fall back to defaultAccount; fall back to first.
  let account: ConfigAccount | undefined;
  if (accountKey) {
    account = accounts.find((a) => a.key === accountKey);
    if (!account) return { error: `No phone-tools account "${accountKey}".` };
  } else if (config?.defaultAccount) {
    account = accounts.find((a) => a.key === config.defaultAccount);
    if (!account) return { error: `Default account "${config.defaultAccount}" not found.` };
  } else {
    account = accounts[0];
  }
  if (!account) return { error: "Could not resolve a phone-tools account." };

  // Allowed-companies check.
  const allowed = account.allowedCompanies ?? [];
  if (allowed.length > 0 && !allowed.includes(companyId) && !allowed.includes("*")) {
    return { error: `Phone-tools account "${account.key}" is not allowed for this company.` };
  }

  return { account, accountKey: account.key ?? "default" };
}

interface TwilioCreds {
  accountSid: string;
  authToken: string;
}

async function resolveTwilioCreds(
  ctx: PluginContext,
  account: ConfigAccount,
): Promise<TwilioCreds | { error: string }> {
  if (!account.twilioAccountSid || !account.twilioAuthTokenRef) {
    return {
      error:
        "This phone-tools account has no Twilio Account SID + Auth Token configured. Add them on the plugin settings page to enable verified personal caller IDs.",
    };
  }
  const authToken = await ctx.secrets.resolve(account.twilioAuthTokenRef);
  if (!authToken) {
    return {
      error: `Twilio Auth Token secret "${account.twilioAuthTokenRef}" did not resolve.`,
    };
  }
  return { accountSid: account.twilioAccountSid, authToken };
}

async function twilioRequest<T = unknown>(
  creds: TwilioCreds,
  path: string,
  method: "GET" | "POST" | "DELETE",
  formBody?: Record<string, string>,
): Promise<T> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(creds.accountSid)}${path}`;
  const auth = Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString("base64");
  const headers: Record<string, string> = {
    Authorization: `Basic ${auth}`,
    Accept: "application/json",
  };
  let body: string | undefined;
  if (formBody) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(formBody)) params.set(k, v);
    body = params.toString();
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }

  let res: Response;
  try {
    res = await fetch(url, { method, headers, body });
  } catch (err) {
    throw new Error(`[ETWILIO_NETWORK] ${(err as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    // Twilio returns JSON error bodies — surface the message when present.
    let message = `${res.status}`;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && "message" in parsed) {
        message = `${res.status}: ${(parsed as { message: string }).message}`;
      }
    } catch {
      message = `${res.status}: ${text.slice(0, 200)}`;
    }
    throw new Error(`[ETWILIO] ${method} ${path} → ${message}`);
  }
  if (!text) return null as T;
  return JSON.parse(text) as T;
}

interface TwilioOutgoingCallerId {
  sid: string;
  phone_number: string;
  friendly_name: string;
}

interface TwilioOutgoingCallerIdsList {
  outgoing_caller_ids: TwilioOutgoingCallerId[];
}

interface TwilioValidationRequest {
  account_sid: string;
  phone_number: string;
  friendly_name: string;
  validation_code: string;
  call_sid: string | null;
}

async function readCache(
  ctx: PluginContext,
  accountKey: string,
): Promise<VerifiedCallerCache | null> {
  const value = await ctx.state.get({
    scopeKind: "instance",
    stateKey: stateKeyFor(accountKey),
  });
  if (!value || typeof value !== "object") return null;
  return value as VerifiedCallerCache;
}

async function writeCache(
  ctx: PluginContext,
  accountKey: string,
  cache: VerifiedCallerCache,
): Promise<void> {
  await ctx.state.set(
    { scopeKind: "instance", stateKey: stateKeyFor(accountKey) },
    cache,
  );
}

function defaultLabel(e164: string): string {
  const last4 = e164.replace(/\D/g, "").slice(-4);
  return `Personal — ${last4}`;
}

function mapTwilioListToCache(
  accountSid: string,
  list: TwilioOutgoingCallerIdsList,
  existing: VerifiedCallerCache | null,
): VerifiedCallerCache {
  const existingBySid = new Map(
    (existing?.numbers ?? []).map((n) => [n.sid, n] as const),
  );
  const now = new Date().toISOString();
  const numbers: VerifiedCallerRecord[] = list.outgoing_caller_ids.map((t) => {
    const prev = existingBySid.get(t.sid);
    return {
      sid: t.sid,
      e164: t.phone_number,
      label: t.friendly_name || prev?.label || defaultLabel(t.phone_number),
      verifiedAt: prev?.verifiedAt ?? now,
    };
  });
  return { accountSid, numbers };
}

// ─── Route handler ────────────────────────────────────────────────────

export async function handleVerifiedCallersApi(
  ctx: PluginContext,
  input: PluginApiRequestInput,
): Promise<PluginApiResponse | null> {
  switch (input.routeKey) {
    case "verified-callers.list":
      return listVerified(ctx, input);
    case "verified-callers.request":
      return requestVerification(ctx, input);
    case "verified-callers.refresh":
      return refreshFromTwilio(ctx, input);
    case "verified-callers.delete":
      return deleteVerified(ctx, input);
    default:
      return null;
  }
}

async function listVerified(
  ctx: PluginContext,
  input: PluginApiRequestInput,
): Promise<PluginApiResponse> {
  const accountKey = asString(input.query?.account);
  const resolved = await resolveAccountByKey(ctx, input.companyId, accountKey);
  if ("error" in resolved) return badRequest(resolved.error);
  const cache = await readCache(ctx, resolved.accountKey);
  return ok({
    accountKey: resolved.accountKey,
    twilioConfigured: !!(resolved.account.twilioAccountSid && resolved.account.twilioAuthTokenRef),
    numbers: cache?.numbers ?? [],
  });
}

async function requestVerification(
  ctx: PluginContext,
  input: PluginApiRequestInput,
): Promise<PluginApiResponse> {
  const body = readBodyAsObject(input.body);
  const e164Raw = asString(body.e164);
  const label = asString(body.label);
  const accountKey = asString(body.account);

  if (!e164Raw) return badRequest("Missing 'e164' phone number.");
  if (!/^\+[1-9]\d{6,14}$/.test(e164Raw)) {
    return badRequest("Phone must be in E.164 format, e.g. +17175771023.");
  }

  const resolved = await resolveAccountByKey(ctx, input.companyId, accountKey);
  if ("error" in resolved) return badRequest(resolved.error);

  const credsOrError = await resolveTwilioCreds(ctx, resolved.account);
  if ("error" in credsOrError) return badRequest(credsOrError.error);

  const friendlyName = label ?? defaultLabel(e164Raw);

  let validation: TwilioValidationRequest;
  try {
    validation = await twilioRequest<TwilioValidationRequest>(
      credsOrError,
      "/OutgoingCallerIds.json",
      "POST",
      {
        PhoneNumber: e164Raw,
        FriendlyName: friendlyName,
        // CallDelay=0 means Twilio rings immediately. Default is 0 anyway
        // but we set it explicitly so the operator hears their phone
        // ring while they're still on the wizard screen.
        CallDelay: "0",
      },
    );
  } catch (err) {
    return serverError((err as Error).message);
  }

  return created({
    sid: null,
    accountKey: resolved.accountKey,
    e164: validation.phone_number,
    friendlyName: validation.friendly_name,
    validationCode: validation.validation_code,
    callSid: validation.call_sid,
    instructions:
      "Twilio is calling the number now. When prompted, enter the 6-digit code above on the phone's keypad. Once Twilio confirms, click 'Refresh' to pull the verified number into the list.",
  });
}

async function refreshFromTwilio(
  ctx: PluginContext,
  input: PluginApiRequestInput,
): Promise<PluginApiResponse> {
  const body = readBodyAsObject(input.body);
  const accountKey = asString(body.account);
  const resolved = await resolveAccountByKey(ctx, input.companyId, accountKey);
  if ("error" in resolved) return badRequest(resolved.error);

  const credsOrError = await resolveTwilioCreds(ctx, resolved.account);
  if ("error" in credsOrError) return badRequest(credsOrError.error);

  let list: TwilioOutgoingCallerIdsList;
  try {
    list = await twilioRequest<TwilioOutgoingCallerIdsList>(
      credsOrError,
      "/OutgoingCallerIds.json",
      "GET",
    );
  } catch (err) {
    return serverError((err as Error).message);
  }

  const existing = await readCache(ctx, resolved.accountKey);
  const next = mapTwilioListToCache(credsOrError.accountSid, list, existing);
  await writeCache(ctx, resolved.accountKey, next);

  return ok({
    accountKey: resolved.accountKey,
    numbers: next.numbers,
  });
}

async function deleteVerified(
  ctx: PluginContext,
  input: PluginApiRequestInput,
): Promise<PluginApiResponse> {
  const sid = input.params.sid;
  if (!sid) return badRequest("Missing 'sid' path param.");
  const accountKey = asString(input.query?.account);
  const resolved = await resolveAccountByKey(ctx, input.companyId, accountKey);
  if ("error" in resolved) return badRequest(resolved.error);

  const credsOrError = await resolveTwilioCreds(ctx, resolved.account);
  if ("error" in credsOrError) return badRequest(credsOrError.error);

  try {
    await twilioRequest(
      credsOrError,
      `/OutgoingCallerIds/${encodeURIComponent(sid)}.json`,
      "DELETE",
    );
  } catch (err) {
    // If Twilio says 404, the entry already doesn't exist — fall
    // through to the cache cleanup. Other errors bubble up.
    const msg = (err as Error).message;
    if (!msg.includes("[ETWILIO] DELETE") || !msg.includes("404")) {
      return serverError(msg);
    }
  }

  const existing = await readCache(ctx, resolved.accountKey);
  if (existing) {
    const filtered = existing.numbers.filter((n) => n.sid !== sid);
    await writeCache(ctx, resolved.accountKey, { ...existing, numbers: filtered });
  }
  return ok({ deleted: sid });
}

// Used by /accounts/numbers to merge verified personals into the
// caller-ID dropdown. Pure read of the local cache — does not hit
// Twilio. Caller is responsible for refreshing the cache if it might
// be stale (typically: explicit user click on a Refresh button).
export async function readVerifiedCachedNumbers(
  ctx: PluginContext,
  accountKey: string,
): Promise<VerifiedCallerRecord[]> {
  const cache = await readCache(ctx, accountKey);
  return cache?.numbers ?? [];
}

export type { VerifiedCallerRecord };
