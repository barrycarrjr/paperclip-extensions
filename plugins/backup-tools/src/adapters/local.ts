/**
 * Local filesystem destination adapter.
 *
 * Writes archives to a directory the operator nominates on the host
 * (e.g. `C:\Users\barry\.paperclip\backups`, `/Volumes/NAS/backups`, etc.).
 * Also serves the `nas-smb` kind — from the plugin's perspective an SMB
 * mount is indistinguishable from a local path.
 *
 * The worker process already has fs access (it writes the in-flight
 * encrypted archive to tmpdir during every run), so this adapter is just
 * doing more of the same. No host capability gate is needed beyond what
 * the worker already does for tmp files.
 */

import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type {
  BackupDestinationAdapter,
  DestinationObject,
  HealthCheckResult,
  ListOptions,
} from "./types.js";
import { adapterError } from "./types.js";

export type LocalAdapterConfig = {
  /** Absolute path. Tilde is expanded to home dir. Trailing slash optional. */
  path: string;
};

function expandPath(input: string): string {
  if (!input) throw new Error("[EBACKUP_DEST_CONFIG_INCOMPLETE] local destination requires a path");
  let p = input.trim();
  if (p === "~") p = homedir();
  else if (p.startsWith("~/") || p.startsWith("~\\")) p = join(homedir(), p.slice(2));
  if (!isAbsolute(p)) {
    throw new Error(`[EBACKUP_DEST_CONFIG_INCOMPLETE] local destination path must be absolute: ${input}`);
  }
  return resolve(p);
}

export class LocalAdapter implements BackupDestinationAdapter {
  readonly kind: "local" | "nas-smb";
  readonly destinationId: string;
  readonly label: string;
  private readonly dir: string;

  constructor(input: {
    kind: "local" | "nas-smb";
    destinationId: string;
    label: string;
    config: LocalAdapterConfig;
  }) {
    this.kind = input.kind;
    this.destinationId = input.destinationId;
    this.label = input.label;
    this.dir = expandPath(input.config.path);
  }

  async healthCheck(): Promise<HealthCheckResult> {
    try {
      // Ensure the directory exists (creating it if not), then write+remove
      // a small probe file to verify we can actually write here.
      mkdirSync(this.dir, { recursive: true });
      const probePath = join(this.dir, `.paperclip-health-${Date.now()}.tmp`);
      const fh = await open(probePath, "w");
      await fh.write("paperclip backup-tools health probe\n");
      await fh.close();
      rmSync(probePath, { force: true });
      const stat = statSync(this.dir);
      if (!stat.isDirectory()) {
        return { ok: false, reason: `${this.dir} exists but is not a directory` };
      }
      return { ok: true, details: { dir: this.dir } };
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
        details: { dir: this.dir },
      };
    }
  }

  async list(options?: ListOptions): Promise<DestinationObject[]> {
    try {
      if (!existsSync(this.dir)) return [];
      const prefix = options?.prefix ?? "";
      const entries = readdirSync(this.dir, { withFileTypes: true });
      const out: DestinationObject[] = [];
      for (const e of entries) {
        if (!e.isFile()) continue;
        if (prefix && !e.name.startsWith(prefix)) continue;
        if (e.name.startsWith(".paperclip-health-")) continue; // skip probes
        const full = join(this.dir, e.name);
        const stat = statSync(full);
        out.push({
          key: e.name,
          sizeBytes: stat.size,
          lastModified: stat.mtime.toISOString(),
        });
        if (options?.limit && out.length >= options.limit) break;
      }
      // Sort newest first — matches s3/drive output ordering convention.
      out.sort((a, b) => (b.lastModified ?? "").localeCompare(a.lastModified ?? ""));
      return out;
    } catch (err) {
      throw adapterError(this.kind, "EBACKUP_DEST_UNREACHABLE", err);
    }
  }

  async upload(key: string, body: NodeJS.ReadableStream, _sizeHint?: number): Promise<void> {
    try {
      assertSafeKey(key);
      mkdirSync(this.dir, { recursive: true });
      const dest = join(this.dir, key);
      // Write to a .partial file first; rename on success. Avoids leaving a
      // half-written archive that list() would surface.
      const tmp = `${dest}.partial`;
      await pipeline(body, createWriteStream(tmp));
      const { rename } = await import("node:fs/promises");
      await rename(tmp, dest);
    } catch (err) {
      throw adapterError(this.kind, "EBACKUP_UPLOAD_FAILED", err);
    }
  }

  async download(key: string): Promise<NodeJS.ReadableStream> {
    try {
      assertSafeKey(key);
      const src = join(this.dir, key);
      if (!existsSync(src)) {
        throw new Error(`archive ${key} not found in ${this.dir}`);
      }
      return createReadStream(src);
    } catch (err) {
      throw adapterError(this.kind, "EBACKUP_DOWNLOAD_FAILED", err);
    }
  }

  async downloadHead(key: string, bytes = 64 * 1024): Promise<Uint8Array> {
    try {
      assertSafeKey(key);
      const src = join(this.dir, key);
      if (!existsSync(src)) {
        throw new Error(`archive ${key} not found in ${this.dir}`);
      }
      const fh = await open(src, "r");
      try {
        const buf = Buffer.alloc(bytes);
        const { bytesRead } = await fh.read(buf, 0, bytes, 0);
        return buf.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
    } catch (err) {
      throw adapterError(this.kind, "EBACKUP_DOWNLOAD_FAILED", err);
    }
  }

  async delete(keys: string[]): Promise<void> {
    try {
      for (const key of keys) {
        assertSafeKey(key);
        const full = join(this.dir, key);
        if (existsSync(full)) rmSync(full, { force: true });
      }
    } catch (err) {
      throw adapterError(this.kind, "EBACKUP_DELETE_FAILED", err);
    }
  }
}

/**
 * Guard against keys with path separators or `..`. Archive keys are produced
 * by archiveKeyFor() so they should never contain these, but a malicious
 * or buggy caller passing `../../etc/passwd` to delete() would be a problem.
 */
function assertSafeKey(key: string): void {
  if (!key || key.length === 0) {
    throw new Error("empty archive key");
  }
  if (key.includes("..") || key.includes("/") || key.includes("\\") || key.includes(sep)) {
    throw new Error(`[EBACKUP_UNSAFE_KEY] archive key cannot contain path separators or '..': ${key}`);
  }
}
