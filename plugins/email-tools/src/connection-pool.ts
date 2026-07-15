import type { ImapFlow } from "imapflow";
import { openConnection, safeLogout, type MailboxRuntime } from "./imap.js";

// Serializes async work — callers queue behind each other on a single
// connection instead of racing to open N simultaneous connections.
class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn);
    // Swallow rejection on the tail so a failed call doesn't block the queue.
    this.tail = next.then(
      () => {},
      () => {},
    );
    return next;
  }
}

interface PoolEntry {
  client: ImapFlow | null;
  runtime: MailboxRuntime;
  mutex: AsyncMutex;
}

// One persistent ImapFlow connection per mailbox. All callers for the same
// mailbox serialize through a single connection, eliminating the Gmail
// per-account connection-rate limit that causes 502s on rapid UI actions.
export class ActionConnectionPool {
  private entries = new Map<string, PoolEntry>();

  private getEntry(rt: MailboxRuntime): PoolEntry {
    let entry = this.entries.get(rt.key);
    if (!entry) {
      entry = { client: null, runtime: rt, mutex: new AsyncMutex() };
      this.entries.set(rt.key, entry);
    }
    // Always refresh runtime so credential rotations take effect on next reconnect.
    entry.runtime = rt;
    return entry;
  }

  async run<T>(rt: MailboxRuntime, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const entry = this.getEntry(rt);
    return entry.mutex.run(async () => {
      // Reconnect if the previous connection was dropped (timeout, network error, etc.).
      if (entry.client != null && !entry.client.usable) {
        await safeLogout(entry.client);
        entry.client = null;
      }
      if (entry.client == null) {
        entry.client = await openConnection(entry.runtime);
      }
      try {
        return await fn(entry.client);
      } catch (err) {
        // Invalidate the connection only if it is no longer usable; semantic
        // IMAP errors (missing folder, bad UID, etc.) should not force a reconnect.
        if (entry.client != null && !entry.client.usable) {
          await safeLogout(entry.client).catch(() => {});
          entry.client = null;
        }
        throw err;
      }
    });
  }

  async drop(key: string): Promise<void> {
    const entry = this.entries.get(key);
    this.entries.delete(key);
    if (entry?.client != null) {
      await safeLogout(entry.client).catch(() => {});
    }
  }

  async dropAll(): Promise<void> {
    await Promise.all(Array.from(this.entries.keys()).map((k) => this.drop(k)));
  }
}
