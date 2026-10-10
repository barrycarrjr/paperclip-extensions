/**
 * Background fetch jobs, so a run can outlast the 5-minute tool limit and the
 * 30-second action limit: start it, then ask how it is doing.
 *
 * One job per company and carrier at a time. Asking to start a carrier that
 * is already running (or waiting its turn) returns that job, so a retry never
 * signs in a second time or asks for a second login code.
 *
 * Jobs live in memory only: a restart of the plugin forgets them, and a
 * finished job is dropped after an hour.
 */
import { randomUUID } from "node:crypto";

export type JobStatus = "running" | "done" | "failed";

export interface Job<R> {
  id: string;
  companyId: string;
  carrier: string;
  status: JobStatus;
  startedAt: string;
  finishedAt?: string;
  result?: R;
  error?: string;
  /** Settles when the job finishes, either way. */
  done: Promise<void>;
}

export class JobStore<R> {
  private jobs = new Map<string, Job<R>>();

  constructor(private readonly keepMs = 3_600_000) {}

  /**
   * Start `run` for this company and carrier, or return the job already
   * running for them (`reused: true`). `failedIf` marks a finished result as
   * failed (a result that carries an error).
   */
  start(
    companyId: string,
    carrier: string,
    run: () => Promise<R>,
    failedIf: (r: R) => string | null = () => null,
  ): { job: Job<R>; reused: boolean } {
    for (const j of this.jobs.values()) {
      if (j.companyId === companyId && j.carrier === carrier && j.status === "running") return { job: j, reused: true };
    }
    const job = {
      id: randomUUID(),
      companyId,
      carrier,
      status: "running",
      startedAt: new Date().toISOString(),
    } as Job<R>;
    job.done = run()
      .then((r) => {
        job.result = r;
        const err = failedIf(r);
        job.status = err ? "failed" : "done";
        if (err) job.error = err;
      })
      .catch((err) => {
        job.status = "failed";
        job.error = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        job.finishedAt = new Date().toISOString();
        setTimeout(() => this.jobs.delete(job.id), this.keepMs).unref?.();
      });
    this.jobs.set(job.id, job);
    return { job, reused: false };
  }

  /** The job, only if it belongs to this company. */
  get(id: string, companyId: string): Job<R> | null {
    const j = this.jobs.get(id);
    return j && j.companyId === companyId ? j : null;
  }

  /** The job whatever its company: only for the board's own operator actions. */
  getAny(id: string): Job<R> | null {
    return this.jobs.get(id) ?? null;
  }

  /** Wait up to `ms` for the job to finish, then return it as it stands. */
  async wait(id: string, companyId: string, ms: number): Promise<Job<R> | null> {
    const j = this.get(id, companyId);
    if (!j) return null;
    if (j.status === "running" && ms > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([j.done, new Promise<void>((r) => (timer = setTimeout(r, ms)))]);
      if (timer) clearTimeout(timer);
    }
    return j;
  }
}

/** What a caller sees of a job: never the internal promise. */
export function jobView<R>(j: Job<R>) {
  const { done: _done, ...rest } = j;
  return rest;
}
