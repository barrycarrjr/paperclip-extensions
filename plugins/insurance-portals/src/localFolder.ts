/**
 * Save files into a folder on this computer, typically the Google Drive for
 * desktop "My Drive" folder so they sync to Drive without any Google keys.
 *
 * Same rules as the Drive API saver: missing folders are created, an
 * identical file (same SHA-256) is skipped, a different file with the same
 * name is saved alongside with a numbered name, and nothing is ever
 * overwritten or deleted. Writes use the exclusive-create flag, so even a
 * race cannot replace an existing file.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { SavedFile } from "./drive.js";
import { safeFileName, splitDrivePath } from "./safety.js";

/** Expand a leading `~` to the home folder. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Find the Google Drive for desktop "My Drive" folder. Returns null unless
 * exactly one signed-in account is found, so it never guesses between two.
 */
export function findDriveForDesktop(home = homedir()): string | null {
  const roots: string[] = [];
  const cloud = join(home, "Library", "CloudStorage");
  if (existsSync(cloud)) {
    for (const name of readdirSync(cloud)) {
      if (!name.startsWith("GoogleDrive-")) continue;
      const my = join(cloud, name, "My Drive");
      if (existsSync(my)) roots.push(my);
    }
  }
  return roots.length === 1 ? roots[0] : null;
}

export function resolveLocalRoot(configured: string | undefined): string {
  const root = configured && configured.trim() ? expandHome(configured.trim()) : findDriveForDesktop();
  if (!root) {
    throw new Error(
      "[ELOCAL_ROOT] No local folder set, and no single Google Drive for desktop 'My Drive' folder was found. Set 'Local folder' in the plugin settings.",
    );
  }
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`[ELOCAL_ROOT] The local folder does not exist: ${root}`);
  }
  return root;
}

export class LocalFolder {
  private constructor(readonly root: string) {}

  static async open(configured: string | undefined): Promise<LocalFolder> {
    return new LocalFolder(await realpath(resolveLocalRoot(configured)));
  }

  /**
   * Resolve (creating as needed) `path` under the root. Each level is checked
   * to still be inside the root (after following any link) before the next
   * level is created, so nothing is ever created outside it.
   */
  async ensureFolder(path: string): Promise<string> {
    const inside = (p: string) => p === this.root || p.startsWith(this.root + sep);
    let dir = this.root;
    for (const part of splitDrivePath(path)) {
      const next = resolve(dir, part);
      if (!inside(next)) throw new Error("[EINVALID_DESTINATION] The folder must be inside the local folder.");
      await mkdir(next).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "EEXIST") throw err;
      });
      const real = await realpath(next);
      if (!inside(real)) throw new Error("[EINVALID_DESTINATION] The folder must be inside the local folder.");
      dir = real;
    }
    return dir;
  }

  async savePdf(dir: string, wantedName: string, bytes: Buffer): Promise<SavedFile> {
    const sha = createHash("sha256").update(bytes).digest("hex");
    const base = safeFileName(wantedName.replace(/\.pdf$/i, "")) || "document";
    for (let n = 1; n < 1000; n++) {
      const name = n === 1 ? `${base}.pdf` : `${base} (${n}).pdf`;
      const file = join(dir, name);
      try {
        await writeFile(file, bytes, { flag: "wx" });
        return { name, id: file, link: null, status: "saved" };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const existing = await readFile(file);
        if (createHash("sha256").update(existing).digest("hex") === sha) {
          return { name, id: file, link: null, status: "already_saved" };
        }
      }
    }
    throw new Error(`[ELOCAL_WRITE] Too many files named '${base}' in ${dir}`);
  }
}
