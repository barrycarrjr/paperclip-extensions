import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

/**
 * Resolve the per-run storage directory under
 *   ~/.paperclip/instances/default/data/storage/image-tools/<run-id>/
 * and create it if missing. Returns the absolute path.
 *
 * If the run-id isn't available (e.g. in tests), falls back to a 'shared'
 * directory under the same root.
 */
export async function ensureStorageDir(runId: string | undefined): Promise<string> {
  const base =
    process.env.PAPERCLIP_DATA_DIR ??
    path.join(os.homedir(), ".paperclip", "instances", "default", "data");
  const dir = path.join(base, "storage", "image-tools", runId || "shared");
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  return dir;
}

/**
 * Generate a destination file path for a freshly created image. If the
 * caller passed an explicit outputPath, return it unchanged (after creating
 * its parent dir). Otherwise build a UUID-named file under the run storage.
 */
export async function resolveOutputPath(
  runId: string | undefined,
  outputPath: string | undefined,
  ext: string,
  hint: string,
): Promise<string> {
  if (outputPath) {
    const parent = path.dirname(outputPath);
    if (!existsSync(parent)) {
      await mkdir(parent, { recursive: true });
    }
    return outputPath;
  }
  const dir = await ensureStorageDir(runId);
  return path.join(dir, `${hint}-${randomUUID().slice(0, 8)}${ext.startsWith(".") ? ext : "." + ext}`);
}
