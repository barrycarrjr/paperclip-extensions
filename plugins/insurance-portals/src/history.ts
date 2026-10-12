/**
 * What each carrier's recent runs found, kept between runs (plugin state,
 * per company and carrier). Pure functions; the worker reads and writes the
 * stored value.
 *
 *   - "Still missing": documents a run saw listed but could not download.
 *     The next run reports which ones came through and which are still
 *     missing, with how many runs in a row missed them.
 *   - "Something broke": a sign-in that fails, or two runs in a row that
 *     find nothing, is said plainly so a portal redesign is noticed.
 */

export interface DocKey {
  policy: string;
  title: string;
  posted: string | null;
}

export interface MissingDoc extends DocKey {
  /** Runs in a row that saw it listed and could not get it. */
  tries: number;
  firstMissed: string;
  lastMissed: string;
}

export interface RunRecord {
  at: string;
  outcome: "ok" | "signin_failed" | "error";
  /** Documents found: newly saved plus already saved. */
  found: number;
}

export interface CarrierHistory {
  runs: RunRecord[];
  missing: MissingDoc[];
}

export interface HealthReport {
  /** Plain warning that the carrier may have changed or sign-in failed, or null. */
  alert: string | null;
  /** Documents missed before that came through this run. */
  recovered: DocKey[];
  /** Documents still missing, oldest problem first. */
  stillMissing: MissingDoc[];
}

export const EMPTY_HISTORY: CarrierHistory = { runs: [], missing: [] };

/** Runs kept in the record. */
const KEEP_RUNS = 10;

const same = (a: DocKey, b: DocKey) =>
  a.policy === b.policy && a.title.toLowerCase() === b.title.toLowerCase() && (a.posted ?? "") === (b.posted ?? "");

/** A stored value read back from plugin state, made safe to use. */
export function asHistory(value: unknown): CarrierHistory {
  const v = (value ?? {}) as Partial<CarrierHistory>;
  return {
    runs: Array.isArray(v.runs) ? v.runs.filter((r) => r && typeof r.at === "string") : [],
    missing: Array.isArray(v.missing) ? v.missing.filter((m) => m && typeof m.title === "string") : [],
  };
}

/**
 * Add one run to the record and say what it means.
 *
 * `got` is every document the run found (saved or already saved); `missed`
 * is every document it saw listed but could not download. A document missed
 * before and not seen at all this run (a current-term-only run, or a run cut
 * short) stays on the list with its count unchanged.
 */
export function recordRun(
  prev: CarrierHistory,
  run: { at: string; outcome: RunRecord["outcome"]; got: DocKey[]; missed: DocKey[] },
  carrierName: string,
): { history: CarrierHistory; report: HealthReport } {
  const found = run.got.length;
  const runs = [...prev.runs, { at: run.at, outcome: run.outcome, found }].slice(-KEEP_RUNS);

  const recovered: DocKey[] = [];
  const missing: MissingDoc[] = [];
  if (run.outcome === "ok") {
    for (const m of prev.missing) {
      if (run.got.some((g) => same(g, m))) recovered.push({ policy: m.policy, title: m.title, posted: m.posted });
      else if (run.missed.some((x) => same(x, m))) missing.push({ ...m, tries: m.tries + 1, lastMissed: run.at });
      else missing.push(m);
    }
    for (const x of run.missed) {
      if (missing.some((m) => same(m, x)) || run.got.some((g) => same(g, x))) continue;
      missing.push({ policy: x.policy, title: x.title, posted: x.posted, tries: 1, firstMissed: run.at, lastMissed: run.at });
    }
  } else {
    // A failed run tells nothing about single documents.
    missing.push(...prev.missing);
  }

  let alert: string | null = null;
  const last = prev.runs.at(-1);
  if (run.outcome === "signin_failed") {
    alert =
      last?.outcome === "signin_failed"
        ? `${carrierName}: sign-in failed on the last two runs. The saved password may be wrong or the sign-in page may have changed.`
        : `${carrierName}: sign-in failed. If the next run fails too, the saved password or the sign-in page needs checking.`;
  } else if (run.outcome === "error") {
    alert =
      last && last.outcome !== "ok"
        ? `${carrierName}: the last two runs stopped with an error. The site may have changed.`
        : `${carrierName}: the run stopped with an error.`;
  } else if (found === 0 && last?.outcome === "ok" && last.found === 0) {
    alert = `${carrierName}: signed in but found no documents on two runs in a row. The site's layout may have changed.`;
  }

  return {
    history: { runs, missing },
    report: { alert, recovered, stillMissing: [...missing].sort((a, b) => b.tries - a.tries || a.firstMissed.localeCompare(b.firstMissed)) },
  };
}

/** Plain lines for the run's result. */
export function describeHealth(report: HealthReport): string[] {
  const lines: string[] = [];
  if (report.alert) lines.push(`ALERT: ${report.alert}`);
  const name = (d: DocKey) => [d.policy, d.title, d.posted ? `posted ${d.posted}` : null].filter(Boolean).join(", ");
  for (const r of report.recovered) lines.push(`Recovered (missing on an earlier run): ${name(r)}.`);
  for (const m of report.stillMissing) {
    lines.push(`Still missing${m.tries > 1 ? ` after ${m.tries} runs` : ""}: ${name(m)}.`);
  }
  return lines;
}
