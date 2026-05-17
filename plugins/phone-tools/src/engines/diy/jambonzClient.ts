/**
 * Thin fetch wrapper for the Jambonz REST API.
 *
 * Jambonz API surface used here:
 *   POST   /v1/Accounts/:accountSid/Calls           — start outbound
 *   GET    /v1/Accounts/:accountSid/Calls/:callSid  — read call detail
 *   POST   /v1/Accounts/:accountSid/Calls/:callSid  — update (used to force-end)
 *   GET    /v1/Accounts/:accountSid/PhoneNumbers    — list DIDs
 *   GET    /v1/Accounts/:accountSid/Recordings/:recSid — recording metadata
 *
 * Auth is a static API key in the `Authorization: Bearer <key>` header.
 */

export interface JambonzClient {
  apiUrl: string;
  apiKey: string;
  accountSid: string;
  applicationSid: string;
  /** HMAC secret used to verify Jambonz → plugin webhook signatures. May be null in dev. */
  webhookSecret: string | null;
}

export interface JambonzCallStartOpts {
  to: string;
  from: string;
  /**
   * The URL Jambonz will hit when the called party answers — drives
   * verb composition for the call's first turn.
   */
  callHookUrl: string;
  /**
   * The URL Jambonz posts terminal call status events to.
   */
  statusHookUrl: string;
  /** Free-form metadata Jambonz echoes back on every webhook. */
  tag?: Record<string, unknown>;
}

export interface JambonzCallStartResult {
  sid: string;
  status: string;
}

export async function jambonzStartCall(
  client: JambonzClient,
  opts: JambonzCallStartOpts,
): Promise<JambonzCallStartResult> {
  const url = `${trim(client.apiUrl)}/v1/Accounts/${enc(client.accountSid)}/Calls`;
  const body = {
    application_sid: client.applicationSid,
    from: opts.from,
    to: { type: "phone", number: opts.to },
    call_hook: { url: opts.callHookUrl, method: "POST" },
    call_status_hook: { url: opts.statusHookUrl, method: "POST" },
    tag: opts.tag,
  };
  const data = await jambonzFetch<{ sid?: string; call_sid?: string; status?: string }>(
    client,
    url,
    { method: "POST", body },
  );
  const sid = data.sid ?? data.call_sid;
  if (!sid) {
    throw new Error(
      `[EJAMBONZ_BAD_RESPONSE] Jambonz POST /Calls returned no sid — raw: ${JSON.stringify(data).slice(0, 200)}`,
    );
  }
  return { sid, status: data.status ?? "queued" };
}

export interface JambonzCallDetail {
  sid?: string;
  call_sid?: string;
  call_status?: string;
  direction?: string;
  from?: string;
  to?: string;
  start_time?: string;
  end_time?: string;
  duration?: number;
  termination_reason?: string;
  recording_url?: string;
  tag?: Record<string, unknown>;
}

export async function jambonzGetCall(
  client: JambonzClient,
  callSid: string,
): Promise<JambonzCallDetail> {
  const url = `${trim(client.apiUrl)}/v1/Accounts/${enc(client.accountSid)}/Calls/${enc(callSid)}`;
  return jambonzFetch<JambonzCallDetail>(client, url, { method: "GET" });
}

export async function jambonzEndCall(
  client: JambonzClient,
  callSid: string,
): Promise<void> {
  const url = `${trim(client.apiUrl)}/v1/Accounts/${enc(client.accountSid)}/Calls/${enc(callSid)}`;
  await jambonzFetch<unknown>(client, url, {
    method: "POST",
    body: { call_status: "completed" },
  });
}

export interface JambonzPhoneNumber {
  phone_number_sid?: string;
  number?: string;
  voip_carrier_sid?: string;
  application_sid?: string;
}

export async function jambonzListPhoneNumbers(
  client: JambonzClient,
): Promise<JambonzPhoneNumber[]> {
  const url = `${trim(client.apiUrl)}/v1/Accounts/${enc(client.accountSid)}/PhoneNumbers`;
  const data = await jambonzFetch<JambonzPhoneNumber[] | { data?: JambonzPhoneNumber[] }>(
    client,
    url,
    { method: "GET" },
  );
  if (Array.isArray(data)) return data;
  return data.data ?? [];
}

/**
 * Verify a Jambonz webhook HMAC signature. Jambonz signs the raw body with
 * the configured shared secret using HMAC-SHA256 and sends the result in
 * the `X-Jambonz-Signature` header (or `Jambonz-Signature` on older
 * versions). When the secret is null we accept everything — only safe in
 * a local-dev setup, log warning emitted at startup.
 */
export async function verifyJambonzSignature(
  webhookSecret: string | null,
  rawBody: string,
  signatureHeader: string | undefined,
): Promise<boolean> {
  if (!webhookSecret) return true;
  if (!signatureHeader) return false;
  const enc = new TextEncoder();
  const keyData = enc.encode(webhookSecret);
  const cryptoSubtle =
    (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!cryptoSubtle) {
    return false;
  }
  const key = await cryptoSubtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await cryptoSubtle.sign("HMAC", key, enc.encode(rawBody));
  const expected = Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return constantTimeEqual(expected, signatureHeader.trim().toLowerCase());
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

async function jambonzFetch<T>(
  client: JambonzClient,
  url: string,
  init: { method: "GET" | "POST"; body?: unknown },
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${client.apiKey}`,
  };
  const fetchInit: RequestInit = { method: init.method, headers };
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    fetchInit.body = JSON.stringify(init.body);
  }
  const res = await fetch(url, fetchInit);
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `[EJAMBONZ_AUTH] Jambonz ${init.method} ${strip(url)} → ${res.status}. Check apiKey + accountSid.`,
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[EJAMBONZ_HTTP_${res.status}] Jambonz ${init.method} ${strip(url)} — ${text.slice(0, 200)}`,
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function trim(u: string): string {
  return u.endsWith("/") ? u.slice(0, -1) : u;
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

function strip(u: string): string {
  return u.replace(/Bearer\s+[^\s&]+/g, "Bearer ***");
}
