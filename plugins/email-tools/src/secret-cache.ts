/**
 * Short-lived in-memory cache for resolved mailbox passwords.
 *
 * `buildMailboxRuntime` runs on every mailbox operation: every list, every
 * mark-read, every move or delete, every background and IDLE-triggered poll.
 * Without this cache each of those asked the host to decrypt the mailbox
 * password again, so one operator click could cost two or three resolutions
 * and a busy minute could ask for hundreds. The host rate-limits secret
 * resolution, and blowing through that limit is what surfaced to the operator
 * as a 502 mid-triage.
 *
 * Rules this cache follows:
 *
 * - **In memory only.** Never written to plugin state, disk, or logs.
 * - **Short lived.** Entries expire after `SECRET_CACHE_TTL_MS` so a rotated
 *   password is picked up on the next operation rather than being pinned for
 *   the life of the worker.
 * - **Keyed by mailbox and secret ref.** Pointing a mailbox at a different
 *   secret misses the cache immediately, with no stale value to evict.
 * - **One resolution per burst.** Concurrent callers share a single in-flight
 *   resolution instead of each firing their own.
 */

/** How long a resolved password may be reused before it is fetched again. */
export const SECRET_CACHE_TTL_MS = 60_000;

interface CacheEntry {
  value: string;
  expiresAt: number;
}

export interface SecretCacheOptions {
  /** Reuse window in milliseconds. Defaults to {@link SECRET_CACHE_TTL_MS}. */
  ttlMs?: number;
  /** Clock injection point for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export class SecretCache {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private entries = new Map<string, CacheEntry>();
  private inFlight = new Map<string, Promise<string>>();

  constructor(options: SecretCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? SECRET_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Return the cached value for `secretRef` within this mailbox, or call
   * `resolver` and cache what it returns.
   *
   * A rejected resolution is never cached, and clears the shared in-flight
   * entry so the next caller retries rather than inheriting the failure.
   */
  async resolve(
    mailboxKey: string,
    secretRef: string,
    resolver: () => Promise<string>,
  ): Promise<string> {
    const cacheKey = `${mailboxKey} ${secretRef}`;

    const cached = this.entries.get(cacheKey);
    if (cached && cached.expiresAt > this.now()) {
      return cached.value;
    }
    if (cached) this.entries.delete(cacheKey);

    const pending = this.inFlight.get(cacheKey);
    if (pending) return pending;

    const attempt = resolver()
      .then((value) => {
        this.entries.set(cacheKey, { value, expiresAt: this.now() + this.ttlMs });
        return value;
      })
      .finally(() => {
        this.inFlight.delete(cacheKey);
      });

    this.inFlight.set(cacheKey, attempt);
    return attempt;
  }

  /** Drop every cached value for one mailbox, across all of its secret refs. */
  invalidateMailbox(mailboxKey: string): void {
    const prefix = `${mailboxKey} `;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  /** Drop everything. Called on worker shutdown so nothing outlives the process. */
  clear(): void {
    this.entries.clear();
  }

  /** Number of live (unexpired) entries. Test and diagnostics helper. */
  get size(): number {
    const now = this.now();
    let live = 0;
    for (const entry of this.entries.values()) {
      if (entry.expiresAt > now) live += 1;
    }
    return live;
  }
}
