import { randomUUID } from "node:crypto";
import { Projector, fail, type Shape } from "./safety.js";

// One response returns whole records only, up to these totals. A record that
// is not returned stays reachable through nextCursor or a next offset.
export const PAGE_BYTES = 72 * 1024;
export const PAGE_NODES = 1400;
export const CURSOR_TTL = 900_000;
export interface Rec { json: string; bytes: number; nodes: number; truncated: boolean }
export interface Batch { recs: Rec[]; bytes: number }

// Scrubs selected strings before cuts, then scrubs the projected record again. A record too
// large for one response alone is projected again with half the nodes until
// it fits, and is flagged truncated, so a page can never be stuck empty.
export function projectRecord(raw: unknown, shape: Shape, scrub: (v: unknown) => unknown): Rec {
  return projectWith(p => p.pick(raw, shape), scrub);
}
export function projectWith(project: (p: Projector) => unknown, scrub: (v: unknown) => unknown, nodes = PAGE_NODES): Rec {
  for (;;) {
    const p = new Projector(nodes, 32 * 1024, value => scrub(value) as string);
    const json = JSON.stringify(scrub(project(p)) ?? null);
    const bytes = Buffer.byteLength(json);
    if (bytes <= PAGE_BYTES || nodes <= 16) return { json, bytes, nodes: p.nodesUsed, truncated: p.truncated };
    nodes = Math.floor(nodes / 2);
  }
}
// A provider page is projected whole before anything is returned, so the
// unreturned remainder is sanitized data, never raw provider output.
export function projectBatch(rows: unknown[], shape: Shape, scrub: (v: unknown) => unknown): Batch {
  const recs: Rec[] = []; let bytes = 0;
  for (const row of rows) {
    const rec = projectRecord(row, shape, scrub);
    bytes += rec.bytes;
    // A valid provider page is at most 8 MiB, and projection only removes data.
    if (bytes > 9 * 1024 * 1024) fail("ERESPONSE");
    recs.push(rec);
  }
  return { recs, bytes };
}
export interface Taken { values: unknown[]; next: number; bytes: number; nodes: number; truncated: boolean }
// Whole records from start, at most max, within the remaining budget. With
// force, the first record is always returned so every call makes progress.
export function take(recs: Rec[], start: number, max: number, budget = { bytes: PAGE_BYTES, nodes: PAGE_NODES }, force = true): Taken {
  const out: Taken = { values: [], next: start, bytes: 0, nodes: 0, truncated: false };
  for (let i = start; i < recs.length && out.values.length < max; i++) {
    const r = recs[i];
    if ((out.bytes + r.bytes > budget.bytes || out.nodes + r.nodes > budget.nodes) && !(force && !out.values.length)) break;
    out.values.push(JSON.parse(r.json)); out.bytes += r.bytes; out.nodes += r.nodes; out.truncated ||= r.truncated; out.next = i + 1;
  }
  return out;
}

export type Query = Record<string, string | number | boolean | undefined>;
// A cursor is immutable once issued: retrying a call with the same cursor
// returns the same page, and a failed call never consumes it. Cursors that
// continue one provider page share its batch, which is counted once.
export interface CursorState {
  binding: string; query: Query; batch?: Batch; index: number;
  token?: string; tokenExpires: number; expires: number;
}
export class CursorStore {
  private cursors = new Map<string, CursorState>();
  private refs = new Map<Batch, number>();
  private bytes = 0;
  constructor(private readonly maxCount = 500, private readonly maxBytes = 24 * 1024 * 1024) {}
  get size() { return this.cursors.size; }
  get cachedBytes() { return this.bytes; }
  // Returns a copy, so a config change or eviction during the call cannot
  // change what this call continues from.
  get(id: string, binding: string, now: number): CursorState {
    const c = this.cursors.get(id);
    if (!c || c.binding !== binding || c.expires <= now) return fail("ECURSOR");
    return { ...c };
  }
  put(state: CursorState, now: number): string {
    for (const [k, c] of this.cursors) if (c.expires <= now) this.drop(k);
    const id = randomUUID();
    this.cursors.set(id, state);
    if (state.batch) {
      const n = this.refs.get(state.batch) ?? 0;
      if (!n) this.bytes += state.batch.bytes;
      this.refs.set(state.batch, n + 1);
    }
    // Oldest first. An evicted cursor answers ECURSOR, never a silent gap.
    for (const k of this.cursors.keys()) {
      if (this.cursors.size <= this.maxCount && this.bytes <= this.maxBytes) break;
      if (k !== id) this.drop(k);
    }
    return id;
  }
  private drop(id: string) {
    const c = this.cursors.get(id);
    if (!c) return;
    this.cursors.delete(id);
    if (!c.batch) return;
    const n = (this.refs.get(c.batch) ?? 1) - 1;
    if (n > 0) this.refs.set(c.batch, n);
    else { this.refs.delete(c.batch); this.bytes -= c.batch.bytes; }
  }
  clear() { this.cursors.clear(); this.refs.clear(); this.bytes = 0; }
}

// Projected, scrubbed rows of a DONE report, so later offsets do not download
// the document again. Keyed by company, connection, current credentials,
// operation and report ID. Memory only; no URL or raw document is kept.
export interface ReportEntry {
  report: unknown; columns?: string[]; rows?: string[]; dates?: Rec[]; asins?: Rec[];
  bytes: number; expires: number; normalizedText?: boolean;
}
export class ReportCache {
  private entries = new Map<string, ReportEntry>();
  private bytes = 0;
  constructor(private readonly maxCount = 8, private readonly maxBytes = 16 * 1024 * 1024) {}
  get size() { return this.entries.size; }
  get(key: string, now: number): ReportEntry | undefined {
    const e = this.entries.get(key);
    if (e && e.expires <= now) { this.drop(key); return undefined; }
    return e;
  }
  // Best effort: an entry too large to keep is simply not cached.
  put(key: string, entry: ReportEntry, now: number) {
    if (entry.bytes > this.maxBytes / 2) return;
    this.drop(key);
    for (const [k, e] of this.entries) if (e.expires <= now) this.drop(k);
    this.entries.set(key, entry); this.bytes += entry.bytes;
    for (const k of this.entries.keys()) {
      if (this.entries.size <= this.maxCount && this.bytes <= this.maxBytes) break;
      if (k !== key) this.drop(k);
    }
  }
  private drop(key: string) {
    const e = this.entries.get(key);
    if (e) { this.entries.delete(key); this.bytes -= e.bytes; }
  }
  clear() { this.entries.clear(); this.bytes = 0; }
}
