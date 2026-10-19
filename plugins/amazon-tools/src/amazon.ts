import { createHash } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { REPORT_TYPES, NOTIFICATIONS, TOOLS, TIMEOUT_MARGIN_MS } from "./manifest.js";
import { AmazonError, date, decode, downloadUrl, fail, integer, jsonText, object, range, redact, redactor, text, transport, type Transport, type Shape } from "./safety.js";
import { CURSOR_TTL, CursorStore, PAGE_BYTES, PAGE_NODES, ReportCache, projectBatch, projectRecord, projectWith, take, type Batch, type Query, type ReportEntry } from "./paging.js";
import { RateLimiter } from "./rate.js";
import * as shapes from "./shapes.js";
import { documentFields, extractModule } from "./aplus.js";

const ENDPOINTS = { NA: "https://sellingpartnerapi-na.amazon.com", EU: "https://sellingpartnerapi-eu.amazon.com", FE: "https://sellingpartnerapi-fe.amazon.com" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPORT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
// Amazon: an FBA inventory nextToken expires 30 seconds after it is created.
const FBA_TOKEN_MS = 25_000;
const ORDER_TOKEN_MS = 24 * 60 * 60_000;
const MAX_WAIT_MS = 10_000;
const timeoutFor = (operation: string) => TOOLS.find(t => t.name === `amazon_${operation}`)?.executionTimeoutMs ?? 70_000;
export interface Account { key: string; credentialsRef: string; region: keyof typeof ENDPOINTS; marketplaceIds: string[]; allowedCompanies: string[] }
interface Credentials { clientId: string; clientSecret: string; refreshToken: string; sellerId: string }
export function accounts(config: unknown): Account[] {
  const cfg = object(config);
  if (Object.keys(cfg).some(k => k !== "accounts") || !Array.isArray(cfg.accounts) || cfg.accounts.length > 20) fail("ECONFIG");
  const seen = new Set<string>();
  return cfg.accounts.map((value: unknown) => {
    const a = object(value);
    if (Object.keys(a).some(k => !["key","credentialsRef","region","marketplaceIds","allowedCompanies"].includes(k)) ||
      typeof a.key !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(a.key) || seen.has(a.key) ||
      typeof a.credentialsRef !== "string" || !UUID.test(a.credentialsRef) || !Object.hasOwn(ENDPOINTS, a.region) ||
      !Array.isArray(a.marketplaceIds) || !a.marketplaceIds.length || a.marketplaceIds.length > 10 || a.marketplaceIds.some((v: unknown) => typeof v !== "string" || !/^[A-Z0-9]{1,32}$/.test(v)) || new Set(a.marketplaceIds).size !== a.marketplaceIds.length ||
      !Array.isArray(a.allowedCompanies) || a.allowedCompanies.some((v: unknown) => typeof v !== "string" || !UUID.test(v)) || new Set(a.allowedCompanies).size !== a.allowedCompanies.length) fail("ECONFIG");
    seen.add(a.key);
    return structuredClone(a) as Account;
  });
}
export function selectAccount(config: unknown, company: string, key?: unknown): Account {
  if (!UUID.test(company)) fail("ECOMPANY");
  const allowed = accounts(config).filter(a => a.allowedCompanies.includes(company));
  const a = key === undefined ? (allowed.length === 1 ? allowed[0] : undefined) : allowed.find(a => a.key === key);
  if (!a) fail("ECOMPANY");
  return a as Account;
}
function credentials(raw: string): Credentials {
  try {
    if (raw.length > 16000) fail();
    const c = object(JSON.parse(raw));
    if (Object.keys(c).sort().join() !== "clientId,clientSecret,refreshToken,sellerId") fail();
    for (const k of ["clientId","clientSecret","refreshToken"]) text(c[k], 4096);
    text(c.sellerId, 64, /^[A-Z0-9]+$/);
    return c as Credentials;
  } catch { return fail("ECREDENTIALS"); }
}
// Provider continuation tokens are opaque and never returned to callers.
function providerToken(v: unknown): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || v.length > 16000 || /[\x00-\x1f\x7f]/.test(v)) fail("ERESPONSE");
  return v as string;
}
// Amazon flat files are TSV, not comma-separated. Preserve decimal commas,
// quote characters and strings exactly. Exact column counts reject shifted or
// multiline values instead of moving data into an allowed column. Only
// allowlisted columns are kept, as tab-joined rows.
export function parseTsv(document: string, columns: string[]): { columns: string[]; rows: string[] } {
  const lines = document.split(/\r?\n/).filter(line => line.length > 0);
  const headers = (lines.shift() ?? "").split("\t");
  if (new Set(headers).size !== headers.length || !headers.some(h=>columns.includes(h)) || headers.some(h=>h.includes('"'))) fail("ERESPONSE");
  if (lines.length > 100000) fail("ERESPONSE");
  const keep = headers.flatMap((h,i) => columns.includes(h) ? [i] : []);
  const rows = lines.map(line => {
    const cells = line.split("\t");
    if (cells.length !== headers.length) fail("ERESPONSE");
    return keep.map(i => cells[i].length > 1500 ? fail("ERESPONSE") : cells[i]).join("\t");
  });
  return { columns: keep.map(i => headers[i]), rows };
}
// Whole rows from offset within one response; nextOffset counts rows actually
// returned, so a size-limited page never skips the rows it could not hold.
export function pageRows(columns: string[], rows: string[], offset: number, limit: number) {
  const out: Record<string,string>[] = []; let bytes = 0, i = offset;
  for (; i < rows.length && out.length < limit; i++) {
    const cells = rows[i].split("\t");
    const row = Object.fromEntries(columns.map((c,n) => [c, cells[n]]));
    const size = Buffer.byteLength(JSON.stringify(row));
    if (out.length && bytes + size > PAGE_BYTES) break;
    out.push(row); bytes += size;
  }
  return { rows: out, rowCount: rows.length, nextOffset: i < rows.length ? i : null };
}
interface Token { value: string; expires: number }
interface Deps { send?: Transport; now?: () => number; sleep?: (ms: number) => Promise<void> }
interface ListSpec { op: string; path: string; query: Query; tokenParam: string; exclusive?: boolean; rows: (j: any) => unknown; next: (j: any) => unknown; shape: Shape; max?: number; tokenMs?: number; grantless?: boolean }
export class AmazonService {
  private tokens = new Map<string, Token>();
  private cursors = new CursorStore();
  private reports = new ReportCache();
  private rates = new RateLimiter();
  private send: Transport;
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;
  constructor(private ctx: Pick<PluginContext, "config" | "secrets">, deps: Deps = {}) {
    this.send = deps.send ?? transport; this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }
  clear() { this.tokens.clear(); this.cursors.clear(); this.reports.clear(); this.rates.clear(); }
  get cacheStats() { return { cursors: this.cursors.size, cursorBytes: this.cursors.cachedBytes, reports: this.reports.size, tokens: this.tokens.size }; }
  async run(operation: string, p: Record<string, any>, company: string, startedAt = this.now()): Promise<Record<string, unknown>> {
    // The whole call, host lookups included, ends before the declared host
    // timeout, so the host never abandons work that is still running.
    const deadline = startedAt + timeoutFor(operation) - TIMEOUT_MARGIN_MS;
    const report = { posted: false, accepted: false };
    try { return await this.execute(operation, p, company, deadline, report); }
    catch (e) {
      // Once the report POST may have reached Amazon, every failure is an
      // uncertain or withheld outcome, never one that invites a retry.
      if (!report.posted || (e instanceof AmazonError && e.dispatch)) throw e;
      const accepted = report.accepted;
      throw Object.assign(new AmazonError(accepted ? "EREPORT_DISPATCHED" : "EREPORT_UNKNOWN"), { dispatch: accepted ? "accepted" : "unknown" });
    }
  }
  private async execute(operation: string, p: Record<string, any>, company: string, deadline: number, report: { posted: boolean; accepted: boolean }): Promise<Record<string, unknown>> {
    const left = () => deadline - this.now();
    // Host lookups race the same deadline; a late answer is ignored.
    const within = <T>(work: Promise<T>): Promise<T> => {
      const ms = left();
      if (ms <= 0) return Promise.reject(new AmazonError("EDEADLINE"));
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new AmazonError("EDEADLINE")), ms); timer.unref?.();
        work.then(v => { clearTimeout(timer); if (left() > 0) resolve(v); else reject(new AmazonError("EDEADLINE")); }, e => { clearTimeout(timer); reject(e); });
      });
    };
    // The current host flattens handler errors into INTERNAL_ERROR plus text;
    // the SDK preserves RPC codes but not the original error name. Recognize
    // only exact permanent host messages; unknown lookup errors are transient.
    const hostFailure = (e: unknown, ref?: string): never => {
      if (e instanceof AmazonError && e.code === "EDEADLINE") throw e;
      if (left() <= 0) fail("EDEADLINE");
      const err = object(e);
      if (err.name === "CapabilityDeniedError" || ((err.code === -32001 || err.code === -32603) && /^Plugin "[^"]+" is missing required capability "[^"]+" for method "(?:config.get|secrets.resolve)"$/.test(err.message ?? ""))) fail("ECONFIG");
      if (ref && [`Secret not found: ${ref}`, `No version found for secret: ${ref}`, `Invalid secret reference: ${ref}`].includes(err.message)) fail("ECREDENTIALS");
      return fail("EHOST");
    };
    const getConfig = async () => {
      try { return await within(this.ctx.config.get()); }
      catch (e) { return hostFailure(e); }
    };
    const resolveSecret = async (ref: string) => {
      try { return await within(this.ctx.secrets.resolve(ref, company)); }
      catch (e) { return hostFailure(e, ref); }
    };
    const account = selectAccount(await getConfig(), company, p.account);
    const raw = await resolveSecret(account.credentialsRef);
    const creds = credentials(raw);
    const fingerprint = digest([company, account, raw]);
    const sensitive = [raw, ...Object.values(creds)];
    let scrubber: ((value: string) => string) | undefined;
    const addSensitive = (value: string) => { sensitive.push(value); scrubber = undefined; };
    const scrub = (value: unknown) => redact(value, scrubber ??= redactor(sensitive));
    // Old credentials are never reused: tokens, cursors and cached report rows
    // are partitioned by a digest of CURRENT secret material, company and config.
    const ensureCurrent = async () => {
      const current = selectAccount(await getConfig(), company, account.key);
      if (digest(current) !== digest(account)) fail("ECONFIG");
      if (await resolveSecret(current.credentialsRef) !== raw) fail("ECREDENTIALS");
    };
    const signal = () => AbortSignal.timeout(Math.max(1, Math.min(20_000, left())));
    const token = async (grantless: boolean) => {
      const key = `${fingerprint}:${grantless}`;
      const cached = this.tokens.get(key);
      if (cached && cached.expires > this.now() + 60_000) { addSensitive(cached.value); return cached.value; }
      await ensureCurrent();
      if (left() < 2_000) fail("EDEADLINE");
      const form = new URLSearchParams({ grant_type: grantless ? "client_credentials" : "refresh_token", client_id: creds.clientId, client_secret: creds.clientSecret,
        ...(grantless ? { scope: "sellingpartnerapi::notifications" } : { refresh_token: creds.refreshToken }) });
      let r;
      try { r = await this.send(new URL("https://api.amazon.com/auth/o2/token"), "POST", { "content-type": "application/x-www-form-urlencoded", "accept-encoding": "identity" }, form.toString(), signal()); }
      catch (e) {
        if (e instanceof AmazonError && e.code === "ERESPONSE") throw e;
        return fail(left() <= 0 ? "EDEADLINE" : "ENETWORK");
      }
      if (r.status === 429) {
        const retry = r.headers["retry-after"];
        const delay = retry && /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) : retry ? (Date.parse(retry) - this.now()) / 1000 : 1;
        throw new AmazonError("ERATE", undefined, Number.isFinite(delay) ? Math.max(1, Math.ceil(delay)) : 1);
      }
      if (r.status === 400 || r.status === 401) fail("EAUTH");
      if (r.status !== 200) throw new AmazonError("EHTTP", r.status);
      let j: Record<string, any>;
      try { j = object(JSON.parse(decode(r))); } catch { return fail("EAUTH"); }
      if (typeof j.access_token !== "string" || j.access_token.length < 1 || j.access_token.length > 4096 || /[\x00-\x1f\x7f]/.test(j.access_token) || typeof j.expires_in !== "number" || !Number.isFinite(j.expires_in) || j.expires_in <= 60 || typeof j.token_type !== "string" || j.token_type.toLowerCase() !== "bearer") fail("EAUTH");
      this.tokens.set(key, { value: j.access_token, expires: this.now() + Math.min(j.expires_in, 3600) * 1000 });
      if (this.tokens.size > 40) this.tokens.delete(this.tokens.keys().next().value!);
      addSensitive(j.access_token); return j.access_token as string;
    };
    const api = async (op: string, path: string, query: Query = {}, body?: Record<string, unknown>, grantless = false): Promise<any> => {
      // All paths originate below, never from caller-supplied URLs/methods.
      const url = new URL(path, ENDPOINTS[account.region]);
      for (const [k,v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
      const access = await token(grantless);
      // Buckets are per seller, application and operation, so one account's
      // throttling or advertised rate never changes another's.
      const rateKey = digest([account.region, creds.clientId, grantless ? "" : creds.sellerId, op]);
      // Never sleep past the point where the request itself could still finish.
      const maxWait = () => Math.min(MAX_WAIT_MS, Math.max(0, left() - 5_000));
      const retryIn = () => Math.max(1, Math.ceil(this.rates.wait(rateKey, op, this.now()) / 1000));
      for (let attempt = 0; ; attempt++) {
        await ensureCurrent();
        const wait = this.rates.acquire(rateKey, op, this.now(), maxWait());
        if (wait === undefined) throw new AmazonError("ERATE", undefined, retryIn());
        if (wait) { await this.sleep(wait); await ensureCurrent(); }
        if (left() < 2_000) fail("EDEADLINE");
        if (body) report.posted = true;
        let r;
        try { r = await this.send(url, body ? "POST" : "GET", { "x-amz-access-token": access, "user-agent": "PaperclipAmazon/0.1.0 (Language=JavaScript)", "x-amz-date": new Date(this.now()).toISOString().replace(/[:-]|\.\d{3}/g, ""), "accept": "application/json", "accept-encoding": "identity", ...(body ? { "content-type": "application/json" } : {}) }, body ? JSON.stringify(body) : undefined, signal()); }
        catch (e) {
          // A connection that never opened cannot have created a report.
          if (body && e instanceof AmazonError && e.notSent) report.posted = false;
          if (!body && e instanceof AmazonError && e.code === "ERESPONSE") throw e;
          return fail(report.posted ? "EREPORT_UNKNOWN" : left() <= 0 ? "EDEADLINE" : "ENETWORK");
        }
        this.rates.observe(rateKey, op, this.now(), r.headers["x-amzn-ratelimit-limit"]);
        if (r.status === 429) {
          const retry = r.headers["retry-after"];
          const parsed = retry && /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : retry ? Date.parse(retry) - this.now() : 0;
          const delay = Math.max(1000 * 2 ** attempt, Number.isFinite(parsed) ? parsed : 0);
          this.rates.block(rateKey, op, this.now(), delay);
          // A throttled report POST was refused, not created, and is never
          // retried automatically.
          if (body) report.posted = false;
          if (body || attempt === 2 || delay > maxWait()) throw new AmazonError("ERATE", undefined, retryIn());
          continue;
        }
        if (r.status < 200 || r.status >= 300) {
          if (body && r.status >= 500) fail("EREPORT_UNKNOWN");
          // Amazon rejected the request outright, so nothing was created.
          if (body) report.posted = false;
          throw new AmazonError(r.status === 401 || r.status === 403 ? "EAUTH" : "EHTTP", r.status);
        }
        try {
          const j = object(JSON.parse(decode(r)));
          if (j.errors?.length) fail("ERESPONSE");
          return j;
        } catch { return fail(body ? "EREPORT_UNKNOWN" : "ERESPONSE"); }
      }
    };
    let truncated = false;
    const single = (value: unknown, shape: Shape) => {
      const rec = projectRecord(value, shape, scrub);
      truncated ||= rec.truncated;
      return JSON.parse(rec.json);
    };
    const binding = digest([fingerprint, operation, Object.fromEntries(Object.entries(p).filter(([k]) => k !== "cursor").sort(([a],[b])=>a.localeCompare(b)))]);
    // A snapshot of the caller's cursor, taken before any await, so a config
    // change or eviction during this call cannot break the continuation.
    const resumed = p.cursor === undefined ? undefined : this.cursors.get(text(p.cursor, 64), binding, this.now());
    const list = async (s: ListSpec) => {
      const query = resumed?.query ?? s.query;
      let batch: Batch, start = 0, next: string | undefined, nextExpires = 0;
      if (resumed?.batch && resumed.index < resumed.batch.recs.length) {
        // Serve the unreturned remainder of a provider page before advancing.
        batch = resumed.batch; start = resumed.index; next = resumed.token; nextExpires = resumed.tokenExpires;
      } else {
        if (resumed && !resumed.token) fail("ECURSOR");
        if (resumed && resumed.tokenExpires <= this.now()) fail("EPAGE_EXPIRED");
        const j = await api(s.op, s.path, resumed ? { ...(s.exclusive ? {} : query), [s.tokenParam]: resumed.token } : query, undefined, s.grantless);
        const rows = s.rows(j);
        if (!Array.isArray(rows)) fail("ERESPONSE");
        batch = projectBatch(rows as unknown[], s.shape, scrub);
        next = providerToken(s.next(j));
        // Only documented provider lifetimes are hard limits. Each new local
        // cursor still expires after 15 minutes, including cached remainders.
        nextExpires = next ? (s.tokenMs ? this.now() + s.tokenMs : Infinity) : 0;
      }
      const page = take(batch.recs, start, s.max ?? Number.MAX_SAFE_INTEGER);
      truncated ||= page.truncated;
      const more = page.next < batch.recs.length;
      // Never return provider tokens, URLs or secrets in pagination metadata.
      const nextCursor = more || next ? this.cursors.put({ binding, query, batch: more ? batch : undefined, index: page.next, token: next, tokenExpires: nextExpires, expires: this.now() + CURSOR_TTL }, this.now()) : null;
      return { values: page.values, nextCursor };
    };
    const market = () => {
      const m = p.marketplaceId ?? (account.marketplaceIds.length === 1 ? account.marketplaceIds[0] : undefined);
      if (typeof m !== "string" || !account.marketplaceIds.includes(m)) fail();
      return m as string;
    };
    const limit = integer(p.limit, 25, 100); if (limit === 0) fail();
    const reportsBase = "/reports/2021-06-30";
    const validateReport = (r: any, settlement = false) => {
      if (!REPORT_TYPES.includes(r.reportType) || (settlement && r.reportType !== REPORT_TYPES[0])) fail("EREPORT");
      // marketplaceIds is optional in Amazon's Report schema. Settlements are
      // seller-wide and may omit it; other report types require provable scope.
      if (r.reportType === REPORT_TYPES[0] && r.marketplaceIds === undefined) return;
      if (!Array.isArray(r.marketplaceIds) || r.marketplaceIds.some((m: unknown)=> !account.marketplaceIds.includes(m as string)) || (!r.marketplaceIds.length && r.reportType !== REPORT_TYPES[0])) fail("EREPORT");
    };
    const reportEntry = async (id: string, settlement: boolean): Promise<ReportEntry | { report: unknown }> => {
      const j = await api("getReport", `${reportsBase}/reports/${encodeURIComponent(id)}`);
      validateReport(j, settlement);
      const meta = single(j, shapes.report);
      if (j.processingStatus !== "DONE") return { report: meta };
      let docId: string;
      try { docId = text(j.reportDocumentId,256,/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/); }
      catch { return fail("ERESPONSE"); }
      const doc = await api("getReportDocument", `${reportsBase}/documents/${encodeURIComponent(docId)}`);
      if (doc.compressionAlgorithm !== undefined && doc.compressionAlgorithm !== "GZIP") fail("EDOWNLOAD");
      const url = downloadUrl(doc.url);
      // Even an allowed storage host must never receive LWA credentials or
      // access tokens echoed into a provider-supplied path/query string.
      if (redact(url.href,sensitive.filter(v=>v!==creds.sellerId)) !== url.href) fail("EDOWNLOAD");
      await ensureCurrent();
      if (left() < 2_000) fail("EDEADLINE");
      let downloaded;
      try { downloaded = await this.send(url,"GET",{ "accept-encoding": "identity", "user-agent": "PaperclipAmazon/0.1.0 (Language=JavaScript)" },undefined,signal()); }
      catch (e) {
        if (e instanceof AmazonError && e.code === "ERESPONSE") throw e;
        return fail(left() <= 0 ? "EDEADLINE" : "ENETWORK");
      }
      if (downloaded.status !== 200) throw new AmazonError("EHTTP",downloaded.status);
      const document = decode(downloaded,doc.compressionAlgorithm === "GZIP",true);
      const expires = this.now() + CURSOR_TTL;
      if (j.reportType === "GET_SALES_AND_TRAFFIC_REPORT") {
        let sales;
        try { sales = object(JSON.parse(document)); } catch { return fail("ERESPONSE"); }
        if (!Array.isArray(sales.salesAndTrafficByDate) || !Array.isArray(sales.salesAndTrafficByAsin)) fail("ERESPONSE");
        const dates = projectBatch(sales.salesAndTrafficByDate,shapes.salesDate,scrub), asins = projectBatch(sales.salesAndTrafficByAsin,shapes.salesAsin,scrub);
        return { report: meta, dates: dates.recs, asins: asins.recs, bytes: dates.bytes + asins.bytes, expires };
      }
      const parsed = parseTsv(document, j.reportType === REPORT_TYPES[0] ? shapes.settlementColumns : shapes.inventoryColumns);
      const clean = scrubber ??= redactor(sensitive);
      let normalizedText = false;
      const rows = parsed.rows.map(row => {
        const scrubbed = clean(row), safe = jsonText(scrubbed);
        normalizedText ||= safe !== scrubbed;
        return clean(safe);
      });
      return { report: meta, columns: parsed.columns, rows, bytes: rows.reduce((n,r) => n + Buffer.byteLength(r) + 16, 0), expires, normalizedText };
    };
    let result: Record<string, any>;
    switch (operation) {
      case "test_connection": {
        const j = await api("searchListingsItems", `/listings/2021-08-01/items/${encodeURIComponent(creds.sellerId)}`, { marketplaceIds: market(), includedData: "summaries", pageSize: 1 });
        if (!Array.isArray(j.items)) fail("ERESPONSE");
        result = { connected: true, tested: "searchListingsItems", optionalRolesVerified: false }; break;
      }
      case "list_settlements": case "list_reports": {
        const type = operation === "list_settlements" ? REPORT_TYPES[0] : p.reportType;
        if (!REPORT_TYPES.includes(type)) fail("EREPORT");
        if (p.createdSince) date(p.createdSince); if (p.createdUntil) date(p.createdUntil);
        if (p.createdUntil && (!p.createdSince || Date.parse(p.createdUntil) <= Date.parse(p.createdSince))) fail();
        const q: Query = { reportTypes: type, marketplaceIds: type === REPORT_TYPES[0] ? undefined : account.marketplaceIds.join(","), pageSize: limit, createdSince: p.createdSince, createdUntil: p.createdUntil };
        // getReports requires nextToken as the only parameter of a continuation.
        const page = await list({ op: "getReports", path: `${reportsBase}/reports`, query: q, tokenParam: "nextToken", exclusive: true, max: limit, shape: shapes.report, next: j => j.nextToken,
          rows: j => Array.isArray(j.reports) ? j.reports.filter((r: any) => { try { validateReport(r); return r.reportType === type; } catch { return false; } }) : undefined });
        result = { reports: page.values, nextCursor: page.nextCursor }; break;
      }
      case "list_financial_events": {
        // A bound cursor already holds validated absolute dates. Recomputing
        // an omitted end against today's clock would invalidate the same args.
        const dates = resumed ? undefined : range(p.postedAfter,p.postedBefore,180,this.now());
        if (p.marketplaceId !== undefined) market();
        if (p.transactionStatus !== undefined && !["RELEASED","DEFERRED","DEFERRED_RELEASED"].includes(p.transactionStatus)) fail();
        if ((p.relatedIdentifierName === undefined) !== (p.relatedIdentifierValue === undefined)) fail();
        if (p.relatedIdentifierName !== undefined && !["ORDER_ID","FINANCIAL_EVENT_GROUP_ID"].includes(p.relatedIdentifierName)) fail();
        if (p.relatedIdentifierValue) text(p.relatedIdentifierValue,128);
        const q: Query = resumed?.query ?? { postedAfter: dates!.after, postedBefore: dates!.before, marketplaceId: p.marketplaceId, transactionStatus: p.transactionStatus, relatedIdentifierName: p.relatedIdentifierName, relatedIdentifierValue: p.relatedIdentifierValue };
        const page = await list({ op: "listTransactions", path: "/finances/2024-06-19/transactions", query: q, tokenParam: "nextToken", shape: shapes.transaction, next: j => object(j.payload).nextToken,
          rows: j => {
            if (j.payload !== undefined && (!j.payload || typeof j.payload !== "object" || Array.isArray(j.payload))) fail("ERESPONSE");
            return object(j.payload).transactions === undefined ? [] : j.payload.transactions;
          } });
        result = { transactions: page.values, nextCursor: page.nextCursor, scope: p.marketplaceId ? "marketplace" : "seller-account", note: "Financial data may lag 48 hours. Account-wide mode includes US merchant transactions." }; break;
      }
      case "get_balances": {
        if (p.asOfDate !== undefined) { text(p.asOfDate,10,/^\d{4}-\d\d-\d\d$/); date(`${p.asOfDate}T00:00:00Z`); }
        const q: Query = { marketplaceIds: account.marketplaceIds.join(","), asOfDate: p.asOfDate };
        const page = await list({ op: "listBalances", path: "/finances/2024-06-19/balances", query: q, tokenParam: "nextToken", shape: shapes.balance, rows: j => j.balances === undefined ? [] : j.balances, next: j => j.nextToken });
        result = { balances: page.values, nextCursor: page.nextCursor }; break;
      }
      case "get_inventory_summary": {
        const m = market(); if (p.sku !== undefined) text(p.sku,100);
        if (p.fulfillment === "FBA") {
          const q: Query = { marketplaceIds: m, granularityType: "Marketplace", granularityId: m, details: true, sellerSku: p.sku };
          const page = await list({ op: "getInventorySummaries", path: "/fba/inventory/v1/summaries", query: q, tokenParam: "nextToken", max: limit, tokenMs: FBA_TOKEN_MS, shape: shapes.inventory, rows: j => object(j.payload).inventorySummaries, next: j => object(j.pagination).nextToken });
          result = { inventory: page.values, nextCursor: page.nextCursor, fulfillment: "FBA", note: "Amazon's FBA page tokens expire 30 seconds after they are issued. A cursor still returns records already fetched for up to 15 minutes; continue promptly when it needs Amazon's next page, narrow with sku, or use the FBA inventory report for a full snapshot." };
        } else if (p.fulfillment === "MERCHANT") {
          // searchListingsItems accepts at most 20 items per page.
          const q: Query = { marketplaceIds: m, includedData: "summaries,fulfillmentAvailability", pageSize: Math.min(limit, 20), identifiers: p.sku, identifiersType: p.sku ? "SKU" : undefined };
          const page = await list({ op: "searchListingsItems", path: `/listings/2021-08-01/items/${encodeURIComponent(creds.sellerId)}`, query: q, tokenParam: "pageToken", max: limit, shape: shapes.listing, next: j => object(j.pagination).nextToken,
            rows: j => Array.isArray(j.items) ? j.items.map((v: any) => ({ ...object(v), fulfillmentAvailability: Array.isArray(v?.fulfillmentAvailability) ? v.fulfillmentAvailability.filter((a: any)=>a?.fulfillmentChannelCode === "DEFAULT") : [] })) : undefined });
          result = { inventory: page.values, nextCursor: page.nextCursor, fulfillment: "MERCHANT", note: "DEFAULT availability is current purchasable merchant quantity, not warehouse stock. Empty availability means not supplied by Amazon, never assume zero." };
        } else return fail();
        break;
      }
      case "list_orders": {
        if ((p.createdAfter === undefined) === (p.lastUpdatedAfter === undefined)) fail();
        if (p.createdAfter !== undefined && (p.lastUpdatedBefore !== undefined || p.lastUpdatedAfter !== undefined)) fail();
        if (p.lastUpdatedAfter !== undefined && p.createdBefore !== undefined) fail();
        const dates = resumed ? undefined : range(p.createdAfter ?? p.lastUpdatedAfter,p.createdBefore ?? p.lastUpdatedBefore,730,this.now());
        const q: Query = resumed?.query ?? { marketplaceIds: p.marketplaceId ? market() : account.marketplaceIds.join(","), maxResultsPerPage: limit, includedData: "PROCEEDS,FULFILLMENT", ...(p.createdAfter ? { createdAfter: dates!.after, createdBefore: dates!.before } : { lastUpdatedAfter: dates!.after, lastUpdatedBefore: dates!.before }) };
        const page = await list({ op: "searchOrders", path: "/orders/2026-01-01/orders", query: q, tokenParam: "paginationToken", max: limit, tokenMs: ORDER_TOKEN_MS, shape: shapes.order, rows: j => j.orders, next: j => object(j.pagination).nextToken });
        result = { orders: page.values, nextCursor: page.nextCursor }; break;
      }
      case "get_order": {
        const id = text(p.orderId,19,/^\d{3}-\d{7}-\d{7}$/);
        const j = await api("getOrder", `/orders/2026-01-01/orders/${id}`, { includedData: "PROCEEDS,FULFILLMENT" });
        if (!j.order || !account.marketplaceIds.includes(j.order.salesChannel?.marketplaceId)) fail("ECOMPANY");
        result = { order: single(j.order, shapes.order) }; break;
      }
      case "request_report": {
        if (!(REPORT_TYPES.slice(1) as readonly unknown[]).includes(p.reportType)) fail("EREPORT");
        const body: Record<string, unknown> = { reportType: p.reportType, marketplaceIds: [market()] };
        if (p.reportType === "GET_SALES_AND_TRAFFIC_REPORT") {
          const dates = range(p.dataStartTime,p.dataEndTime,30,this.now(),true); body.dataStartTime = dates.after; body.dataEndTime = dates.before;
          const oldest = new Date(this.now()); oldest.setUTCFullYear(oldest.getUTCFullYear() - 2);
          if (Date.parse(dates.after) < oldest.getTime()) fail();
          body.reportOptions = { dateGranularity: "DAY", asinGranularity: "SKU" };
        } else if (p.dataStartTime !== undefined || p.dataEndTime !== undefined) fail();
        const j = await api("createReport", `${reportsBase}/reports`, {}, body);
        let reportId: string;
        try { reportId = text(j.reportId,128,REPORT_ID); }
        catch { return fail("EREPORT_UNKNOWN"); }
        if (scrub(reportId) !== reportId) fail("EREPORT_UNKNOWN");
        report.accepted = true;
        result = { reportId, reportType: p.reportType, note: "Poll get_report with this reportId. Do not request the same report again; if a request ever has an uncertain outcome, list_reports first." }; break;
      }
      case "get_report": case "get_settlement": {
        const id = text(p.reportId,128,REPORT_ID);
        const offset = integer(p.offset,0,100000), dateOffset = p.dateOffset === undefined ? undefined : integer(p.dateOffset,0,100000), asinOffset = p.asinOffset === undefined ? undefined : integer(p.asinOffset,0,100000);
        if (p.offset !== undefined && (dateOffset !== undefined || asinOffset !== undefined)) fail();
        // DONE reports do not change, so their projected rows are reused for
        // later offsets instead of downloading the document again.
        const key = digest([fingerprint, operation, id]);
        let entry: ReportEntry | { report: unknown } | undefined = this.reports.get(key, this.now());
        if (!entry) {
          entry = await reportEntry(id, operation === "get_settlement");
          if ("bytes" in entry) this.reports.put(key, entry, this.now());
        }
        result = { report: entry.report };
        if (!("bytes" in entry)) break;
        truncated ||= entry.normalizedText === true;
        if (entry.rows && entry.columns) {
          if (dateOffset !== undefined || asinOffset !== undefined) fail();
          Object.assign(result, pageRows(entry.columns, entry.rows, offset, limit));
        } else if (entry.dates && entry.asins) {
          // Two independent arrays: each continues from its own offset, and
          // only the arrays the caller names are read when an offset is given.
          const both = dateOffset === undefined && asinOffset === undefined;
          let budget = { bytes: PAGE_BYTES, nodes: PAGE_NODES }, delivered = 0;
          for (const [name, recs, from] of [["Date", entry.dates, both ? offset : dateOffset], ["Asin", entry.asins, both ? offset : asinOffset]] as const) {
            if (from === undefined) continue;
            const page = take(recs, from, limit, budget, delivered === 0);
            result[`salesAndTrafficBy${name}`] = page.values; result[`next${name}Offset`] = page.next < recs.length ? page.next : null; result[`${name.toLowerCase()}Count`] = recs.length;
            budget = { bytes: budget.bytes - page.bytes, nodes: budget.nodes - page.nodes }; delivered += page.values.length; truncated ||= page.truncated;
          }
        }
        break;
      }
      case "get_catalog_item": {
        const asin = text(p.asin,10,/^[A-Z0-9]{10}$/);
        const j = await api("getCatalogItem", `/catalog/2022-04-01/items/${asin}`, { marketplaceIds: market(), includedData: "attributes,images,identifiers,productTypes,relationships,summaries" });
        if (j.asin !== asin) fail("ERESPONSE");
        result = { item: single(j,shapes.catalog), note: "Catalog content may differ from submitted seller attributes. API data does not identify override authors or guarantee the rendered retail page." }; break;
      }
      case "get_listing": {
        const sku = text(p.sku,100);
        if (sku === "." || sku === "..") fail();
        const j = await api("getListingsItem", `/listings/2021-08-01/items/${encodeURIComponent(creds.sellerId)}/${encodeURIComponent(sku)}`, { marketplaceIds: market(), includedData: "attributes,summaries,issues,fulfillmentAvailability,productTypes" });
        if (j.sku !== sku) fail("ERESPONSE");
        result = { listing: single(j,shapes.listing), note: "Attributes are the seller's latest submissions; fulfillmentAvailability is live purchasable inventory. Issue messages and contact/compliance attributes are omitted." }; break;
      }
      case "list_aplus_content": case "list_aplus_publish_records": {
        const publish = operation === "list_aplus_publish_records";
        const q: Query = { marketplaceId: market(), ...(publish ? { asin: text(p.asin,10,/^[A-Z0-9]{10}$/) } : {}) };
        // Amazon: a continuation must send pageToken as its only parameter.
        const page = await list({ op: publish ? "searchContentPublishRecords" : "searchContentDocuments", path: `/aplus/2020-11-01/${publish ? "contentPublishRecords" : "contentDocuments"}`, query: q, tokenParam: "pageToken", exclusive: true,
          shape: publish ? shapes.publishRecord : shapes.contentMetadata, rows: j => publish ? j.publishRecordList : j.contentMetadataRecords, next: j => j.nextPageToken });
        result = { records: page.values, nextCursor: page.nextCursor }; break;
      }
      case "get_aplus_content": {
        const key = text(p.contentReferenceKey,128,/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/), from = integer(p.moduleOffset,0,100000);
        const j = await api("getContentDocument", `/aplus/2020-11-01/contentDocuments/${encodeURIComponent(key)}`, { marketplaceId: market(), includedDataSet: "CONTENTS,METADATA" });
        if (j.contentRecord?.contentReferenceKey !== key || !Array.isArray(j.contentRecord?.contentDocument?.contentModuleList)) fail("ERESPONSE");
        const doc = j.contentRecord.contentDocument, modules: unknown[] = doc.contentModuleList;
        if (modules.length > 100) truncated = true;
        // Whole modules per response, each with its own text budget, so a
        // text-heavy document pages instead of failing or being cut short.
        const recs = modules.slice(0,100).map(m => projectWith(pr => extractModule(m,pr),scrub));
        const page = take(recs, from, Number.MAX_SAFE_INTEGER);
        truncated ||= page.truncated;
        result = { metadata: single(j.contentRecord,shapes.contentMetadata), content: { ...single(doc,documentFields), modules: page.values }, moduleCount: recs.length, nextModuleOffset: page.next < recs.length ? page.next : null }; break;
      }
      case "get_notification_subscription": {
        if (!(NOTIFICATIONS as readonly unknown[]).includes(p.notificationType)) fail();
        if (p.payloadVersion !== undefined) text(p.payloadVersion,16,/^\d+(?:\.\d+)*$/);
        const j = await api("getSubscription", `/notifications/v1/subscriptions/${p.notificationType}`, { payloadVersion: p.payloadVersion });
        if (typeof j.payload?.subscriptionId !== "string" || typeof j.payload?.destinationId !== "string" || typeof j.payload?.payloadVersion !== "string") fail("ERESPONSE");
        result = { notificationType: p.notificationType, subscription: single(j.payload,shapes.subscription), eventIngestion: false }; break;
      }
      case "list_notification_destinations": {
        const page = await list({ op: "getDestinations", path: "/notifications/v1/destinations", query: {}, tokenParam: "nextToken", grantless: true, shape: { destinationId: true, resourceTypes: [true] }, next: () => undefined,
          rows: j => Array.isArray(j.payload) ? j.payload.map((d: unknown) => ({ destinationId: object(d).destinationId, resourceTypes: ["sqs","eventBridge"].filter(k => object(object(d).resource)[k]) })) : undefined });
        result = { destinations: page.values, nextCursor: page.nextCursor, scope: "application", eventIngestion: false }; break;
      }
      default: return fail();
    }
    await ensureCurrent();
    const output = redact({ ...result, truncated, provenance: { provider: "amazon-sp-api", operation, region: account.region, retrievedAt: new Date(this.now()).toISOString() } },sensitive);
    // Pages are sized well below this; it only guards against a defect.
    if (Buffer.byteLength(JSON.stringify(output)) > 96 * 1024) fail("ERESPONSE");
    return output;
  }
}
