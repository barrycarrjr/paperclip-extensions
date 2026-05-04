import { readFile } from "node:fs/promises";
import path from "node:path";
import { runProcess } from "./runProcess.js";
import { fingerprint } from "./fingerprint.js";

export interface DocDriftFinding {
  doc: string;
  claim: string;
  kind: "function" | "env-var" | "file-path";
  status: "missing";
  fingerprint: string;
}

export interface DocDriftScanOptions {
  repoPath: string;
  maxFindings: number;
  timeoutMs?: number;
}

interface Claim {
  text: string;
  kind: DocDriftFinding["kind"];
  /** What to grep for. */
  searchTerm: string;
}

const DOCS_TO_CHECK = ["README.md", "AGENTS.md"];

const FUNCTION_PATTERN = /`([a-zA-Z_$][a-zA-Z0-9_$]{2,})\(\)`/g;
const ENV_VAR_PATTERN = /`([A-Z][A-Z0-9_]{4,})`/g;
const FILE_PATH_PATTERN = /`([a-zA-Z0-9_./-]+\.(?:ts|tsx|js|jsx|py|go|md|json|sql))`/g;

function extractClaims(content: string): Claim[] {
  const claims: Claim[] = [];
  const seen = new Set<string>();
  const push = (claim: Claim) => {
    const key = `${claim.kind}:${claim.searchTerm}`;
    if (seen.has(key)) return;
    seen.add(key);
    claims.push(claim);
  };

  for (const match of content.matchAll(FUNCTION_PATTERN)) {
    push({ text: match[0], kind: "function", searchTerm: match[1] });
  }
  for (const match of content.matchAll(ENV_VAR_PATTERN)) {
    push({ text: match[0], kind: "env-var", searchTerm: match[1] });
  }
  for (const match of content.matchAll(FILE_PATH_PATTERN)) {
    push({ text: match[0], kind: "file-path", searchTerm: match[1] });
  }

  return claims;
}

async function gitGrepExists(
  repoPath: string,
  needle: string,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const result = await runProcess(
      "git",
      ["grep", "-l", "--fixed-strings", needle],
      { cwd: repoPath, timeoutMs, okExitCodes: [0, 1] },
    );
    return result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function fileExistsInRepo(repoPath: string, relPath: string): Promise<boolean> {
  try {
    await readFile(path.join(repoPath, relPath));
    return true;
  } catch {
    return false;
  }
}

export async function runDocDriftScan(
  opts: DocDriftScanOptions,
): Promise<DocDriftFinding[]> {
  const findings: DocDriftFinding[] = [];
  const grepTimeout = Math.floor((opts.timeoutMs ?? 90_000) / 4);

  for (const doc of DOCS_TO_CHECK) {
    if (findings.length >= opts.maxFindings) break;

    let content: string;
    try {
      content = await readFile(path.join(opts.repoPath, doc), "utf8");
    } catch {
      continue;
    }

    const claims = extractClaims(content);
    for (const claim of claims) {
      if (findings.length >= opts.maxFindings) break;
      let exists: boolean;
      if (claim.kind === "file-path") {
        exists = await fileExistsInRepo(opts.repoPath, claim.searchTerm);
      } else {
        exists = await gitGrepExists(opts.repoPath, claim.searchTerm, grepTimeout);
      }
      if (!exists) {
        findings.push({
          doc,
          claim: claim.text,
          kind: claim.kind,
          status: "missing",
          fingerprint: fingerprint("doc-drift", doc, claim.kind, claim.searchTerm),
        });
      }
    }
  }

  return findings;
}
