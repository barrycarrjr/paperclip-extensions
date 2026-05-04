import { runProcess } from "./runProcess.js";
import { fingerprint } from "./fingerprint.js";

export interface TodoFinding {
  file: string;
  line: number;
  type: "TODO" | "FIXME" | "XXX";
  text: string;
  addedDate: string;
  ageDays: number;
  author?: string;
  fingerprint: string;
}

export interface TodoScanOptions {
  repoPath: string;
  minAgeMonths: number;
  maxFindings: number;
  timeoutMs?: number;
}

const TODO_PATTERN = /\b(TODO|FIXME|XXX)\b/;

interface GitGrepHit {
  file: string;
  line: number;
  text: string;
  type: "TODO" | "FIXME" | "XXX";
}

function parseGitGrep(stdout: string): GitGrepHit[] {
  const hits: GitGrepHit[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    if (raw.length === 0) continue;
    // Format: `path:line:content`. content may itself contain colons.
    const firstColon = raw.indexOf(":");
    if (firstColon < 0) continue;
    const secondColon = raw.indexOf(":", firstColon + 1);
    if (secondColon < 0) continue;
    const file = raw.slice(0, firstColon);
    const lineNum = Number(raw.slice(firstColon + 1, secondColon));
    if (!Number.isFinite(lineNum)) continue;
    const content = raw.slice(secondColon + 1);
    const match = content.match(TODO_PATTERN);
    if (!match) continue;
    hits.push({
      file,
      line: lineNum,
      text: content.trim().slice(0, 240),
      type: match[1] as "TODO" | "FIXME" | "XXX",
    });
  }
  return hits;
}

interface BlameInfo {
  authorTime: number;
  author: string;
}

async function blameOne(
  repoPath: string,
  file: string,
  line: number,
): Promise<BlameInfo | null> {
  try {
    const result = await runProcess(
      "git",
      ["blame", "--porcelain", "-L", `${line},${line}`, "--", file],
      { cwd: repoPath, timeoutMs: 15_000 },
    );
    let authorTime: number | null = null;
    let author = "";
    for (const raw of result.stdout.split(/\r?\n/)) {
      if (raw.startsWith("author-time ")) {
        authorTime = Number(raw.slice("author-time ".length));
      } else if (raw.startsWith("author ")) {
        author = raw.slice("author ".length);
      }
    }
    if (!authorTime || !Number.isFinite(authorTime)) return null;
    return { authorTime: authorTime * 1000, author };
  } catch {
    return null;
  }
}

export async function runTodoAgeScan(opts: TodoScanOptions): Promise<TodoFinding[]> {
  const grepResult = await runProcess(
    "git",
    ["grep", "-n", "-E", "\\b(TODO|FIXME|XXX)\\b"],
    {
      cwd: opts.repoPath,
      timeoutMs: opts.timeoutMs ?? 60_000,
      okExitCodes: [0, 1],
    },
  );

  const hits = parseGitGrep(grepResult.stdout);
  const ageThresholdMs = opts.minAgeMonths * 30 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const findings: TodoFinding[] = [];

  for (const hit of hits) {
    if (findings.length >= opts.maxFindings) break;
    const blame = await blameOne(opts.repoPath, hit.file, hit.line);
    if (!blame) continue;
    const ageMs = now - blame.authorTime;
    if (ageMs < ageThresholdMs) continue;
    findings.push({
      file: hit.file,
      line: hit.line,
      type: hit.type,
      text: hit.text,
      addedDate: new Date(blame.authorTime).toISOString(),
      ageDays: Math.floor(ageMs / (24 * 60 * 60 * 1000)),
      author: blame.author || undefined,
      fingerprint: fingerprint("todo-age", hit.file, hit.type, String(hit.line)),
    });
  }
  return findings;
}
