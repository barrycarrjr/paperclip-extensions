// Published default usage plans (requests per second, burst) from Amazon's
// official API models, checked 2026-10-18. x-amzn-RateLimit-Limit replaces the
// rate for that seller, application and operation only.
export const USAGE: Record<string, readonly [rate: number, burst: number]> = {
  searchOrders: [0.0056, 20], getOrder: [0.5, 30], listTransactions: [0.5, 10], listBalances: [0.5, 10],
  getReports: [0.0222, 10], getReport: [2, 15], createReport: [0.0167, 15], getReportDocument: [0.0167, 15],
  getInventorySummaries: [2, 2], searchListingsItems: [5, 5], getListingsItem: [5, 10], getCatalogItem: [2, 2],
  searchContentDocuments: [10, 10], getContentDocument: [10, 10], searchContentPublishRecords: [10, 10],
  getSubscription: [1, 5], getDestinations: [1, 5],
};
interface Bucket { tokens: number; rate: number; burst: number; updated: number; blockedUntil: number }
// One token bucket per seller, application and operation, worker-local.
// Callers reserve a token before sleeping, so concurrent calls queue behind
// each other instead of all seeing the same free token.
export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private bucket(key: string, op: string, now: number): Bucket {
    let b = this.buckets.get(key);
    if (!b) {
      const [rate, burst] = USAGE[op] ?? [1, 1];
      b = { tokens: burst, rate, burst, updated: now, blockedUntil: 0 };
      this.buckets.set(key, b);
      if (this.buckets.size > 400) this.buckets.delete(this.buckets.keys().next().value!);
    }
    b.tokens = Math.min(b.burst, b.tokens + Math.max(0, now - b.updated) * b.rate / 1000);
    b.updated = Math.max(b.updated, now);
    return b;
  }
  // Milliseconds until a request may start, with a token reserved, or
  // undefined (nothing reserved) when that is later than maxWait.
  acquire(key: string, op: string, now: number, maxWait: number): number | undefined {
    const wait = this.wait(key, op, now);
    if (wait > maxWait) return undefined;
    this.bucket(key, op, now).tokens -= 1;
    return wait;
  }
  wait(key: string, op: string, now: number): number {
    const b = this.bucket(key, op, now);
    // The small tolerance keeps float error from adding a millisecond.
    return Math.max(0, Math.ceil(Math.max(b.blockedUntil - now, b.tokens >= 1 ? 0 : (1 - b.tokens) * 1000 / b.rate) - 1e-6));
  }
  observe(key: string, op: string, now: number, header: string | undefined) {
    const advertised = Number(header);
    if (header !== undefined && Number.isFinite(advertised) && advertised > 0) this.bucket(key, op, now).rate = Math.min(1000, Math.max(0.0001, advertised));
  }
  // A 429 means Amazon's bucket is empty: the next token is due exactly when
  // Amazon's Retry-After (or the backoff) ends, not a full refill later.
  block(key: string, op: string, now: number, delay: number) {
    const b = this.bucket(key, op, now);
    b.tokens = Math.min(b.tokens, 1 - delay * b.rate / 1000);
    b.blockedUntil = Math.max(b.blockedUntil, now + delay);
  }
  clear() { this.buckets.clear(); }
}
