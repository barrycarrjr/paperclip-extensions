import { execFile } from "node:child_process";

export interface RunProcessOptions {
  cwd: string;
  timeoutMs?: number;
  maxBufferBytes?: number;
  /** Treat these exit codes as success. Default `[0]`. */
  okExitCodes?: number[];
  /** Optional stdin payload. */
  input?: string;
}

export interface RunProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const DEFAULT_TIMEOUT = 60_000;
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Promise wrapper around execFile with sensible defaults. Never invokes a
 * shell (no shell-metachar interpolation). Caller passes the executable and
 * a literal argv array.
 *
 * Throws if the process exits with a non-OK code OR if it times out OR if
 * the executable cannot be found. Distinguishes ENOENT explicitly so the
 * caller can surface a `[ESCANNER_*_MISSING]` for known prerequisites.
 */
export function runProcess(
  command: string,
  args: string[],
  options: RunProcessOptions,
): Promise<RunProcessResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT,
        maxBuffer: options.maxBufferBytes ?? DEFAULT_MAX_BUFFER,
        windowsHide: true,
        encoding: "utf8",
      },
      (err, stdoutRaw, stderrRaw) => {
        const stdout = typeof stdoutRaw === "string" ? stdoutRaw : String(stdoutRaw ?? "");
        const stderr = typeof stderrRaw === "string" ? stderrRaw : String(stderrRaw ?? "");

        if (err) {
          const errno = (err as NodeJS.ErrnoException).code;
          if (errno === "ENOENT") {
            reject(new Error(`ENOENT: ${command} not found on PATH`));
            return;
          }
          const exitCode = typeof (err as { code?: number }).code === "number"
            ? (err as { code: number }).code
            : 1;
          const okExitCodes = options.okExitCodes ?? [0];
          if (okExitCodes.includes(exitCode)) {
            resolve({ stdout, stderr, exitCode });
            return;
          }
          reject(
            new Error(
              `process ${command} exited with code ${exitCode}: ${stderr.trim() || err.message}`,
            ),
          );
          return;
        }
        resolve({ stdout, stderr, exitCode: 0 });
      },
    );

    if (options.input !== undefined) {
      child.stdin?.write(options.input);
      child.stdin?.end();
    }
  });
}

export function isMissingExecutable(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("ENOENT:");
}
