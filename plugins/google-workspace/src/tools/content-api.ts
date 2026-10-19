import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { getGoogleAccount, type ConfigAccount, type InstanceConfig } from "../googleAuth.js";
import { isCompanyAllowed } from "../companyAccess.js";

export const MAX_FILE_BYTES = 1024 * 1024;
export const DEFAULT_FILE_BYTES = 32 * 1024;
export const MAX_DOC_BYTES = 2 * 1024 * 1024;
export const MAX_TEXT_CHARS = 20000;

export class ContentError extends Error {
  constructor(readonly code: string, message: string) { super(`[${code}] ${message}`); }
}

export function invalid(message: string): never { throw new ContentError("EINVALID_INPUT", message); }
export function fileId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) invalid("Use an exact file or tab ID, not a URL or path.");
  return value;
}
export function documentTabId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]{1,200}$/.test(value) || value === "." || value === "..") invalid("Use the exact tab ID returned by gdoc_read.");
  return value;
}
export function integer(value: unknown, fallback: number, min: number, max: number): number {
  const n = value === undefined ? fallback : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < min || n > max) invalid("Numeric input is outside the supported range.");
  return n;
}
export function input(params: unknown, fields: string[]): Record<string, unknown> {
  if (!params || typeof params !== "object" || Array.isArray(params)) invalid("An input object is required.");
  if (Object.keys(params).some(key => !fields.includes(key))) invalid("Unexpected input field.");
  const p = params as Record<string, unknown>;
  if (p.account !== undefined && (typeof p.account !== "string" || !p.account.trim())) invalid("Account must be a nonempty key.");
  return p;
}
export function revision(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 500 || /[\x00-\x1f\x7f]/.test(value)) invalid("A revision ID from gdoc_read is required.");
  return value;
}
export function splitSurrogate(text: string, index: number): boolean {
  return index > 0 && index < text.length && /[\uD800-\uDBFF]/.test(text[index - 1]) && /[\uDC00-\uDFFF]/.test(text[index]);
}
export function editText(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > MAX_TEXT_CHARS) invalid("Text must contain 1 to 20000 UTF-16 units.");
  // Docs silently strips these characters. Refuse rather than claim an exact edit.
  if (/[\x00-\x08\x0c-\x1f\uE000-\uF8FF]/.test(value)) invalid("Text contains characters that Google Docs strips.");
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid("Text contains an incomplete Unicode character.");
    } else if (c >= 0xdc00 && c <= 0xdfff) invalid("Text contains an incomplete Unicode character.");
  }
  return value;
}

// Never return provider messages, request URLs, headers, secret errors or bodies.
export function contentError(err: unknown): string {
  return err instanceof ContentError ? err.message : "[EGOOGLE_UNAVAILABLE] Google request failed. Check the connection and retry reads. Verify the remote result before retrying a write.";
}

export function googleUrl(service: "docs" | "drive", id: string, suffix = "", query: Record<string, string> = {}): URL {
  const base = service === "docs" ? "https://docs.googleapis.com/v1/documents/" : "https://www.googleapis.com/drive/v3/files/";
  const url = new URL(base + fileId(id) + suffix);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url;
}

function credentialIdentity(account: ConfigAccount): string {
  return JSON.stringify([account.key?.toLowerCase(), account.clientIdRef, account.clientSecretRef, account.refreshTokenRef, account.scopes]);
}

export async function openContentSession(ctx: PluginContext, run: ToolRunContext, tool: string, key: unknown, mutation: boolean) {
  const deadline = Date.now() + 25000;
  let writeDispatched = false;
  const company = run.companyId;
  if (typeof company !== "string" || !company.trim()) throw new ContentError("ECOMPANY_NOT_ALLOWED", "A host company context is required.");
  let identity: string | undefined;
  let accountKey: string | undefined;
  async function check(): Promise<ConfigAccount> {
    const config = await ctx.config.get() as InstanceConfig;
    const requested = accountKey ?? (key as string | undefined) ?? config.defaultAccount;
    const matches = (config.accounts ?? []).filter(a => typeof a.key === "string" && a.key.toLowerCase() === requested?.trim().toLowerCase());
    if (matches.length !== 1) throw new ContentError("EACCOUNT_REQUIRED", "Configure one unambiguous account key or pass account explicitly.");
    const account = matches[0];
    if (!Array.isArray(account.allowedCompanies) || !account.allowedCompanies.every(value => typeof value === "string") || !isCompanyAllowed(account.allowedCompanies, company)) throw new ContentError("ECOMPANY_NOT_ALLOWED", "This company cannot use that account.");
    if (![account.clientIdRef, account.clientSecretRef, account.refreshTokenRef].every(value => typeof value === "string" && value.trim())) throw new ContentError("ECONFIG", "Configure all three credential references for this account.");
    if (mutation && config.allowMutations !== true) throw new ContentError("EMUTATIONS_DISABLED", "Enable mutation tools in plugin settings before editing files.");
    if (identity && identity !== credentialIdentity(account)) throw new ContentError("EACCOUNT_CHANGED", "Account credentials changed during the call. Verify the remote result before retrying a write.");
    return account;
  }
  const account = await check();
  accountKey = account.key!;
  identity = credentialIdentity(account);
  let resolved: Awaited<ReturnType<typeof getGoogleAccount>>;
  try { resolved = await getGoogleAccount(ctx, run, tool, accountKey); }
  catch { throw new ContentError("ECONFIG", "Account credentials could not be resolved. Check the configured secret references."); }
  if (credentialIdentity(resolved.account) !== identity) throw new ContentError("EACCOUNT_CHANGED", "Account credentials changed during the call. Verify the remote result before retrying a write.");

  async function request(url: URL, method: "GET" | "POST" | "PATCH" = "GET", body?: unknown, maxBytes = MAX_DOC_BYTES, headers: Record<string, string> = {}) {
    // This helper is internal: no tool can supply arbitrary URLs or request bodies.
    if (!((url.origin === "https://docs.googleapis.com" && url.pathname.startsWith("/v1/documents/")) || (url.origin === "https://www.googleapis.com" && url.pathname.startsWith("/drive/v3/files/")))) invalid("Unsupported Google endpoint.");
    if (method !== "GET" && !mutation) invalid("A read session cannot write.");
    await check();
    const authBudget = Math.min(10000, deadline - Date.now());
    if (authBudget <= 0) throw new ContentError("EGOOGLE_TIMEOUT", "The request time budget expired.");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const token = await Promise.race([
      resolved.oauth2Client.getAccessToken(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new ContentError("EGOOGLE_TIMEOUT", "Google authentication timed out. No file request was made.")), authBudget); }),
    ]).finally(() => clearTimeout(timer));
    if (!token.token) throw new ContentError("EGOOGLE_AUTH", "Google did not provide an access token. Reconnect the account.");
    await check();
    const remaining = Math.min(10000, deadline - Date.now());
    if (remaining <= 0) throw new ContentError("EGOOGLE_TIMEOUT", "The request time budget expired.");
    const payload = body === undefined ? undefined : JSON.stringify(body);
    // Mark only after every local check and token request. Once sent, even a
    // rejected fetch can mean that Google committed a write but lost its reply.
    if (method !== "GET") writeDispatched = true;
    const response = await fetch(url, {
      method, redirect: "error", signal: AbortSignal.timeout(remaining),
      headers: { Authorization: `Bearer ${token.token}`, ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(payload === undefined ? {} : { body: payload }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const known: Record<number, [string, string]> = {
        400: ["EGOOGLE_BAD_REQUEST", "Google rejected the request. For Docs edits, read the document again and check its revision and indices."],
        401: ["EGOOGLE_AUTH", "Reconnect the Google account."],
        403: ["EGOOGLE_FORBIDDEN", "Check file access, the enabled API and the existing OAuth grant. No permissions were changed."],
        404: ["EGOOGLE_NOT_FOUND", "The exact file ID was not found or is not accessible."],
        409: ["EGOOGLE_CONFLICT", "The file changed. Read it again before editing."],
        412: ["EGOOGLE_CONFLICT", "The file changed. Read it again before editing."],
        429: ["EGOOGLE_RATE_LIMIT", "Google rate limited the request. No automatic retry was made."],
      };
      const [code, message] = known[response.status] ?? ["EGOOGLE_UNAVAILABLE", "Google could not complete the request. Verify the remote result before retrying a write."];
      throw new ContentError(code, message);
    }
    const length = response.headers.get("content-length");
    if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
      await response.body?.cancel();
      if (method !== "GET") throw new ContentError("EWRITE_UNCONFIRMED", "The write was dispatched but its response exceeded the size limit. Verify the remote result before retrying.");
      throw new ContentError("EREAD_LIMIT", "The response exceeds the read size limit.");
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) throw new ContentError("EREAD_LIMIT", "The response exceeds the read size limit.");
          chunks.push(value);
        }
      } catch (err) {
        await reader.cancel().catch(() => {});
        if (method !== "GET") throw new ContentError("EWRITE_UNCONFIRMED", "The write was dispatched but its response could not be read. Verify the remote result before retrying.");
        throw err;
      }
      finally { reader.releaseLock(); }
    }
    try { await check(); }
    catch (err) {
      if (method !== "GET") throw new ContentError("EWRITE_UNCONFIRMED", "The write was dispatched before access or configuration changed. Verify the remote result before retrying.");
      throw err;
    }
    return { bytes: Buffer.concat(chunks, size), headers: response.headers };
  }
  async function json<T>(url: URL, method: "GET" | "POST" | "PATCH" = "GET", body?: unknown, headers?: Record<string, string>): Promise<{ data: T; headers: Headers }> {
    const response = await request(url, method, body, MAX_DOC_BYTES, headers);
    try { return { data: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.bytes)) as T, headers: response.headers }; }
    catch { throw new ContentError("EGOOGLE_FORMAT", "Google returned an invalid JSON response. Verify the remote result before retrying a write."); }
  }
  async function audit(phase: "attempt" | "completed", id: string): Promise<boolean> {
    try {
      await ctx.activity.log({ companyId: company, message: `Google file operation ${phase}`, metadata: { tool, account: accountKey, fileId: id, phase } });
      return true;
    } catch {
      if (phase === "attempt") throw new ContentError("EAUDIT_UNAVAILABLE", "The activity log is unavailable. No write was attempted.");
      return false;
    }
  }
  return { accountKey, request, json, check, audit, get writeDispatched() { return writeDispatched; } };
}

export type ContentSession = Awaited<ReturnType<typeof openContentSession>>;
