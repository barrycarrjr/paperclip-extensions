import { isMissingExecutable, runProcess } from "./runProcess.js";
import { fingerprint } from "./fingerprint.js";

export interface SecretFinding {
  file: string;
  line: number;
  kind: string;
  fingerprint: string;
  ruleId?: string;
  description?: string;
}

export interface SecretScanOptions {
  repoPath: string;
  binary: string;
  maxFindings: number;
  timeoutMs?: number;
}

interface GitleaksJsonEntry {
  RuleID?: string;
  Description?: string;
  StartLine?: number;
  File?: string;
  Match?: string;
  Tags?: string[];
  Fingerprint?: string;
}

const ESCANNER_GITLEAKS_MISSING =
  "[ESCANNER_GITLEAKS_MISSING] gitleaks not found. Install from https://github.com/gitleaks/gitleaks/releases and put it on PATH, or set `gitleaksBinary` in the plugin's settings to an absolute path.";

/**
 * Run `gitleaks detect --no-banner --report-format json --report-path -` in
 * the repo and parse the JSON. gitleaks exits 1 when it finds issues; we
 * treat both 0 and 1 as success since we want findings either way.
 */
export async function runSecretScan(opts: SecretScanOptions): Promise<SecretFinding[]> {
  let result;
  try {
    result = await runProcess(
      opts.binary,
      [
        "detect",
        "--no-banner",
        "--report-format",
        "json",
        "--report-path",
        "/dev/stdout",
        "--source",
        ".",
      ],
      {
        cwd: opts.repoPath,
        timeoutMs: opts.timeoutMs ?? 120_000,
        okExitCodes: [0, 1],
      },
    );
  } catch (err) {
    if (isMissingExecutable(err)) {
      throw new Error(ESCANNER_GITLEAKS_MISSING);
    }
    throw err;
  }

  // gitleaks may emit non-JSON banner lines on stderr; stdout is JSON.
  const stdout = result.stdout.trim();
  if (stdout.length === 0) return [];

  let raw: GitleaksJsonEntry[];
  try {
    raw = JSON.parse(stdout) as GitleaksJsonEntry[];
  } catch {
    // gitleaks might print a JSON object with a `findings` array, or
    // newline-delimited JSON. Try line-by-line as a fallback.
    raw = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("{"))
      .map((line) => {
        try {
          return JSON.parse(line) as GitleaksJsonEntry;
        } catch {
          return null;
        }
      })
      .filter((value): value is GitleaksJsonEntry => Boolean(value));
  }

  const findings: SecretFinding[] = [];
  for (const entry of raw) {
    if (!entry.File || typeof entry.StartLine !== "number") continue;
    const ruleId = entry.RuleID ?? "unknown";
    findings.push({
      file: entry.File,
      line: entry.StartLine,
      kind: ruleId,
      ruleId,
      description: entry.Description,
      fingerprint: fingerprint("secret-scan", entry.File, ruleId, String(entry.StartLine)),
    });
    if (findings.length >= opts.maxFindings) break;
  }
  return findings;
}
