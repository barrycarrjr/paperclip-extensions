import { IntakeError } from "./routing.js";

const tails = new Map<string, Promise<void>>();
/** Serialize connection/staging on a target without blocking other computers. */
export async function withRemoteSlot<T>(target: string, task: () => Promise<T>, waitMs = 30_000): Promise<T> {
  const key = target.toLowerCase();
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => gate);
  tails.set(key, tail);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([previous, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new IntakeError(409, "Another remote task is still running on this computer. Wait for its result before retrying; this task did not start.")), waitMs);
    })]);
    if (timer) clearTimeout(timer);
    return await task();
  } finally {
    if (timer) clearTimeout(timer);
    release();
    // A timed-out waiter must remain behind the active task; deleting its
    // entry early would allow a later request to jump the queue.
    void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
  }
}
