import { isMissingExecutable, runProcess } from "./runProcess.js";
import { fingerprint } from "./fingerprint.js";

export interface DeadExportFinding {
  file: string;
  symbol: string;
  kind: string;
  fingerprint: string;
}

export interface DeadExportScanOptions {
  repoPath: string;
  binary: string;
  maxFindings: number;
  timeoutMs?: number;
}

interface KnipJsonReport {
  files?: string[];
  exports?: Record<string, Array<{ name: string; line?: number }>>;
  types?: Record<string, Array<{ name: string; line?: number }>>;
  duplicates?: Record<string, Array<{ name: string }>>;
}

const ESCANNER_KNIP_MISSING =
  "[ESCANNER_KNIP_MISSING] knip not found or failed to run. Install with `pnpm add -D knip` in the target repo, or set `knipBinary` in the plugin's settings.";

export async function runDeadExportScan(
  opts: DeadExportScanOptions,
): Promise<DeadExportFinding[]> {
  // knip's binary spec might be `npx knip` (two tokens). Split on
  // whitespace; first token is the executable, rest become argv.
  const tokens = opts.binary.trim().split(/\s+/);
  const command = tokens[0];
  const baseArgs = tokens.slice(1);

  let result;
  try {
    result = await runProcess(
      command,
      [...baseArgs, "--reporter", "json", "--no-progress"],
      {
        cwd: opts.repoPath,
        timeoutMs: opts.timeoutMs ?? 180_000,
        // knip exits non-zero when it finds problems — treat all <= 5 as
        // "ran successfully, here's the report".
        okExitCodes: [0, 1, 2, 3, 4, 5],
      },
    );
  } catch (err) {
    if (isMissingExecutable(err)) {
      throw new Error(ESCANNER_KNIP_MISSING);
    }
    throw err;
  }

  const stdout = result.stdout.trim();
  if (stdout.length === 0) return [];

  let report: KnipJsonReport;
  try {
    report = JSON.parse(stdout) as KnipJsonReport;
  } catch {
    throw new Error(`${ESCANNER_KNIP_MISSING} (could not parse knip JSON output)`);
  }

  const findings: DeadExportFinding[] = [];

  const pushBucket = (bucket: KnipJsonReport["exports"], kind: string) => {
    if (!bucket) return;
    for (const [file, entries] of Object.entries(bucket)) {
      for (const entry of entries) {
        if (findings.length >= opts.maxFindings) return;
        findings.push({
          file,
          symbol: entry.name,
          kind,
          fingerprint: fingerprint("dead-export", file, entry.name, kind),
        });
      }
    }
  };

  pushBucket(report.exports, "export");
  if (findings.length < opts.maxFindings) pushBucket(report.types, "type");
  return findings;
}
