import { request } from "node:https";
import { lookup } from "node:dns";
import { BlockList, isIP } from "node:net";
import { gunzipSync } from "node:zlib";

export class AmazonError extends Error {
  // request_report only. "unknown": the POST may have reached Amazon.
  // "accepted": Amazon accepted it, but the result cannot be returned.
  dispatch?: "unknown" | "accepted";
  // Transport only: the connection failed before any request byte was sent.
  notSent = false;
  constructor(public readonly code: string, public readonly status?: number, public readonly retryAfterSeconds?: number) {
    super(`[${code}] ${status ? `Amazon returned HTTP ${status}.` : MESSAGES[code] ?? "Amazon request failed."}${retryAfterSeconds ? ` Retry after ${retryAfterSeconds} seconds.` : ""}`);
  }
}
const MESSAGES: Record<string, string> = {
  EINPUT: "Invalid tool arguments. Check the tool schema.",
  ECONFIG: "Check Amazon account configuration and company access.",
  ECOMPANY: "This company cannot use this Amazon connection.",
  ECREDENTIALS: "Check the encrypted Amazon credentials reference and JSON fields.",
  EAUTH: "Amazon authorization failed. Check credentials and app roles.",
  ENETWORK: "Amazon could not be reached within the request deadline.",
  ERESPONSE: "Amazon returned an unsupported or oversized response.",
  EREPORT: "This report type or report scope is not permitted.",
  EDOWNLOAD: "Amazon returned an unsupported report download host or encoding.",
  ECURSOR: "Cursor expired, was evicted, or does not belong to this company, connection, and query. Repeat the query without cursor.",
  EPAGE_EXPIRED: "Amazon's page token behind this cursor has expired. Repeat the query without cursor and continue promptly.",
  ERATE: "Amazon usage limit reached. Retry later.",
  EREPORT_UNKNOWN: "Report creation outcome is unknown. Do not request it again; list reports first.",
  EREPORT_DISPATCHED: "Amazon accepted the report request, but this connection changed before the result could be returned, so the report ID is withheld. Do not request it again; list reports once access is confirmed.",
  EDEADLINE: "The Amazon operation reached its total deadline before completing. Retry later.",
  EAUDIT: "The activity log is unavailable. Retry after the host recovers.",
  EHOST: "Amazon connection settings or secret lookup is temporarily unavailable. Retry after the host recovers.",
};
export const fail = (code = "EINPUT"): never => { throw new AmazonError(code); };
export const object = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
export function text(v: unknown, max = 256, pattern?: RegExp): string {
  if (typeof v !== "string" || !v.length || v.length > max || /[\x00-\x1f\x7f]/.test(v) || (pattern && !pattern.test(v))) fail();
  return v as string;
}
export function integer(v: unknown, fallback: number, max: number): number {
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > max) fail();
  return v as number;
}
export function date(v: unknown): string {
  const s = text(v, 35, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/);
  if (!Number.isFinite(Date.parse(s)) || new Date(`${s.slice(0,10)}T00:00:00Z`).toISOString().slice(0,10) !== s.slice(0,10)) fail();
  return s;
}
export function range(after: unknown, before: unknown, maxDays = 180, now = Date.now(), capDefaultEnd = false): { after: string; before: string } {
  const a = date(after), b = before === undefined ? new Date(Math.min(now - 180_000, capDefaultEnd ? Date.parse(a) + maxDays * 86400_000 : Infinity)).toISOString() : date(before);
  if (Date.parse(a) >= Date.parse(b) || Date.parse(b) > now - 120_000 || Date.parse(b) - Date.parse(a) > maxDays * 86400_000) fail();
  return { after: a, before: b };
}

const blocked = new BlockList();
for (const [ip, bits] of [["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.168.0.0",16],["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",4],["240.0.0.0",4]] as const) blocked.addSubnet(ip, bits, "ipv4");
export const publicIPv4 = (ip: string) => isIP(ip) === 4 && !blocked.check(ip, "ipv4");
export function downloadUrl(value: unknown): URL {
  let u: URL;
  try { u = new URL(text(value, 12000)); } catch { return fail("EDOWNLOAD"); }
  // Only regional S3 virtual-hosted buckets and CloudFront distributions. No
  // arbitrary amazonaws.com services, credentials, ports, fragments or redirects.
  const s3 = /^[a-z0-9][a-z0-9.-]{1,100}\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/;
  const cf = /^[a-z0-9]{8,40}\.cloudfront\.net$/;
  if (u.protocol !== "https:" || u.port || u.username || u.password || u.hash || !(s3.test(u.hostname) || cf.test(u.hostname))) fail("EDOWNLOAD");
  return u;
}
export interface HttpReply { status: number; headers: Record<string, string>; body: Buffer }
// A transport that knows a request never left the machine (for example the
// connection was refused) throws an AmazonError with notSent set.
export type Transport = (url: URL, method: "GET" | "POST", headers: Record<string, string>, body?: string, signal?: AbortSignal) => Promise<HttpReply>;
export const MAX_BYTES = 8 * 1024 * 1024;
export const transport: Transport = (url, method, headers, body, signal) => new Promise((resolve, reject) => {
  // Request bytes can only reach Amazon once the TLS session exists, so any
  // failure before that point proves the request was not sent.
  let connected = false;
  const failed = () => Object.assign(new AmazonError("ENETWORK"), { notSent: !connected });
  // Pin a validated public IPv4 address for this exact connection. HTTPS still
  // verifies the original hostname. Avoid DNS rebinding and metadata/local IPs.
  const req = request(url, {
    method, headers, agent: false,
    lookup(host, _options, callback) {
      lookup(host, { family: 4, all: true }, (err, addresses) => {
        if (err || !addresses.length || addresses.some(a => !publicIPv4(a.address))) return callback(new Error("DNS denied"), "", 4);
        // Node may request all addresses depending on its auto-family settings.
        if (object(_options).all) (callback as any)(null, [addresses[0]]);
        else callback(null, addresses[0].address, 4);
      });
    },
  }, res => {
    const chunks: Buffer[] = []; let size = 0;
    res.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BYTES) req.destroy(new AmazonError("ERESPONSE"));
      else chunks.push(chunk);
    });
    res.on("error", () => reject(failed()));
    res.on("end", () => {
      const h: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) if (typeof v === "string") h[k] = v;
      resolve({ status: res.statusCode ?? 500, headers: h, body: Buffer.concat(chunks) });
    });
  });
  req.on("socket", socket => socket.once((socket as { encrypted?: boolean }).encrypted ? "secureConnect" : "connect", () => { connected = true; }));
  // The caller's total deadline and this request's own 20 seconds both end it.
  const abort = () => req.destroy(failed());
  const timer = setTimeout(abort, 20_000);
  signal?.addEventListener("abort", abort, { once: true });
  req.on("close", () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); });
  req.on("error", e => reject(e instanceof AmazonError ? e : failed()));
  if (signal?.aborted) abort(); else req.end(body);
});

// Report downloads declare their charset in Content-Type, as in Amazon's
// retrieve-a-report sample. Only these labels are decoded; an unlisted label
// fails closed. An undeclared charset is decoded as strict UTF-8 only, so a
// non-UTF-8 document without a label fails instead of being guessed.
const CHARSETS: Record<string, string> = {
  "utf-8": "utf-8", utf8: "utf-8",
  "windows-1252": "windows-1252", cp1252: "windows-1252", "x-cp1252": "windows-1252",
  shift_jis: "shift_jis", "shift-jis": "shift_jis", sjis: "shift_jis", "x-sjis": "shift_jis", "windows-31j": "shift_jis", ms932: "shift_jis",
};
export function reportCharset(contentType = ""): string {
  const labels = [...contentType.matchAll(/(?:^|;)\s*charset\s*=\s*(?:"([^"]*)"|([^;\s]*))/gi)].map(m => (m[1] ?? m[2] ?? "").trim().toLowerCase());
  if (!labels.length) return "utf-8";
  if (labels.length > 1 || !Object.hasOwn(CHARSETS, labels[0])) fail("EDOWNLOAD");
  return CHARSETS[labels[0]];
}
// Node's TextDecoder decodes windows-1252 as Latin-1 in current releases
// (0x80 to 0x9F become control characters), so that range comes from the
// WHATWG index instead. Every other byte equals its code point.
const CP1252 = [0x20ac,0x81,0x201a,0x192,0x201e,0x2026,0x2020,0x2021,0x2c6,0x2030,0x160,0x2039,0x152,0x8d,0x17d,0x8f,0x90,0x2018,0x2019,0x201c,0x201d,0x2022,0x2013,0x2014,0x2dc,0x2122,0x161,0x203a,0x153,0x9d,0x17e,0x178];
function windows1252(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...Array.from(bytes.subarray(i, i + 8192), b => b >= 0x80 && b < 0xa0 ? CP1252[b - 0x80] : b));
  return out;
}
export function decode(reply: HttpReply, gzip = false, report = false): string {
  const charset = report ? reportCharset(reply.headers["content-type"]) : "utf-8";
  if (reply.body.length > MAX_BYTES) fail("ERESPONSE");
  const enc = reply.headers["content-encoding"]?.toLowerCase();
  if (enc && enc !== "identity" && enc !== "gzip") fail("EDOWNLOAD");
  try {
    // Magic bytes avoid decompressing twice when Amazon sets both metadata and
    // Content-Encoding. Never persist the raw document or pre-signed URL.
    const compressed = (gzip || enc === "gzip") && reply.body[0] === 0x1f && reply.body[1] === 0x8b;
    if ((gzip || enc === "gzip") && !compressed) fail("ERESPONSE");
    const bytes = compressed ? gunzipSync(reply.body, { maxOutputLength: MAX_BYTES }) : reply.body;
    return (charset === "windows-1252" ? windows1252(bytes) : new TextDecoder(charset, { fatal: true }).decode(bytes)).replace(/^\uFEFF/, "");
  } catch { return fail("ERESPONSE"); }
}

export type Shape = true | { [key: string]: Shape } | readonly [Shape];
// PostgreSQL jsonb rejects NUL and unpaired UTF-16 surrogates. Keep valid
// pairs, replace invalid units, and leave numbers and numeric strings alone.
export function jsonText(value: string): string {
  return value.replace(/\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, unit => unit === "\u0000" ? "" : "\uFFFD");
}
function prefixEnd(value: string, end: number): number {
  const unit = value.charCodeAt(end - 1);
  return unit >= 0xd800 && unit <= 0xdbff ? end - 1 : end;
}
export class Projector {
  truncated = false;
  private remaining: number;
  constructor(private readonly budget = 1400, private stringBytes = 32 * 1024, private readonly scrub: (value: string) => string = value => value) { this.remaining = budget; }
  get nodesUsed() { return this.budget - Math.max(0, this.remaining); }
  pick(value: unknown, shape: Shape, depth = 0): any {
    if (value === undefined) return undefined;
    if (--this.remaining < 0 || depth > 16) { this.truncated = true; return undefined; }
    if (shape === true) {
      if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
      if (typeof value === "boolean" || value === null) return value;
      if (typeof value === "string") return this.string(value);
      return undefined; // Never copy an unexpected nested object.
    }
    if (Array.isArray(shape)) {
      if (!Array.isArray(value)) return undefined;
      if (value.length > 100) this.truncated = true;
      return value.slice(0, 100).map(v => this.pick(v, shape[0], depth + 1)).filter(v => v !== undefined);
    }
    const result: Record<string, unknown> = {};
    for (const [k, s] of Object.entries(shape)) {
      if (!Object.hasOwn(object(value), k)) continue;
      const v = this.pick(object(value)[k], s, depth + 1);
      if (v !== undefined) result[k] = v;
    }
    return result;
  }
  // Strings are cut at 1,500 characters and share one byte budget. Once the
  // budget is spent, later strings are cut short or omitted, never padded.
  private string(value: string): string | undefined {
    // Scrub the complete selected string before any normalization or cut can
    // leave an unmatched credential prefix. Unselected objects are not walked.
    const clean = this.scrub(jsonText(this.scrub(value)));
    let s = clean.slice(0, prefixEnd(clean, Math.min(clean.length, 1500)));
    if (s !== value) this.truncated = true;
    const size = (v: string) => Buffer.byteLength(JSON.stringify(v));
    if (size(s) > this.stringBytes) {
      this.truncated = true;
      let lo = 0, hi = s.length;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (size(s.slice(0, prefixEnd(s, mid))) <= this.stringBytes) lo = mid; else hi = mid - 1; }
      lo = prefixEnd(s, lo);
      if (!lo) return undefined;
      s = s.slice(0, lo);
    }
    this.stringBytes -= size(s);
    return s;
  }
}
// One pattern per call covers every secret and its URL/base64 forms, longest
// first, so cached rows and outputs can be scrubbed cheaply.
export function redactor(secrets: string[]): (value: string) => string {
  const variants = [...new Set(secrets.filter(Boolean).flatMap(s => [s, encodeURIComponent(s), Buffer.from(s).toString("base64")]))].sort((a,b) => b.length-a.length);
  if (!variants.length) return value => value;
  const pattern = new RegExp(variants.map(v => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  return value => value.replace(pattern, "[redacted]");
}
export function redact(value: unknown, secrets: string[] | ((value: string) => string)): any {
  const scrub = typeof secrets === "function" ? secrets : redactor(secrets);
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map(v => redact(v, scrub));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, redact(v, scrub)]));
  return value;
}
