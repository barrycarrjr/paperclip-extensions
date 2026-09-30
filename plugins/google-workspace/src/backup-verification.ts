import { createHash } from "node:crypto";
import { lstat, realpath, opendir, open, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { isAbsolute, resolve, parse, join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";

const folderMime = "application/vnd.google-apps.folder";
const maxBytes = 1024 * 1024;
const maxFiles = 50;
export interface BackupFile { id?: string | null; name?: string | null; mimeType?: string | null; parents?: string[] | null; trashed?: boolean | null; md5Checksum?: string | null; size?: string | null; version?: string | null; modifiedTime?: string | null; capabilities?: {canDownload?: boolean | null} | null }
export interface BackupDrive {
  metadata(id: string): Promise<BackupFile>;
  children(id: string): Promise<{files: BackupFile[]; incomplete: boolean}>;
  download(id: string): Promise<Buffer>;
}
interface LocalFile { md5: string; sha256: string; size: number }
const hash = (bytes: Buffer, algorithm: string) => createHash(algorithm).update(bytes).digest("hex");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const plainName = (name: unknown): name is string => typeof name === "string" && name.length > 0 && name.length <= 180 && !/[\\/\x00-\x1f]/.test(name) && name !== "." && name !== "..";

/** Refuse symlinks/junctions in every existing root component. Local filesystem administrators remain trusted. */
async function checkedRoot(input: string) {
  if (!isAbsolute(input) || input.includes("\0")) throw new Error("Source root must be absolute");
  const root = resolve(input); let current = parse(root).root;
  for (const component of root.slice(current.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, component);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Linked source roots are unsupported");
  }
  if ((await realpath(root)).toLowerCase() !== root.toLowerCase()) throw new Error("Resolved root changed");
  return root;
}
async function localSnapshot(input: string, guard: () => Promise<void>) {
  const root = await checkedRoot(input); const files = new Map<string, LocalFile>(); let entries = 0, directories = 0, total = 0;
  async function walk(path: string, relative: string, depth: number) {
    if (++directories > 30 || depth > 5) throw new Error("Directory bound exceeded");
    const directory = await opendir(path);
    for await (const entry of directory) {
      if (++entries > 500 || !plainName(entry.name)) throw new Error("Local tree bound or unsupported name");
      const full = join(path, entry.name); const relativeName = relative + entry.name;
      const before = await lstat(full);
      if (before.isSymbolicLink()) throw new Error("Linked source entries are unsupported");
      if (before.isDirectory()) { await walk(full, relativeName + "/", depth + 1); continue; }
      if (!entry.name.toLowerCase().endsWith(".md")) continue;
      if (!before.isFile() || before.size > maxBytes || files.size >= maxFiles || (total += before.size) > 8 * maxBytes) throw new Error("File bound exceeded");
      await guard();
      const handle = await open(full, "r");
      try {
        const opened = await handle.stat();
        if (opened.ino !== before.ino || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) throw new Error("Source changed");
        // Read at most limit+1 even if a file grows after stat. No file text is returned.
        const buffer = Buffer.alloc(maxBytes + 1); let length = 0;
        while (length < buffer.length) { const read = await handle.read(buffer, length, buffer.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
        const after = await handle.stat(); const latest = await lstat(full);
        if (length > maxBytes || latest.isSymbolicLink() || latest.ino !== opened.ino || after.size !== length || after.mtimeMs !== opened.mtimeMs) throw new Error("Source changed while reading");
        const bytes = buffer.subarray(0, length);
        files.set(relativeName, {size: length,md5: hash(bytes,"md5"),sha256: hash(bytes,"sha256")});
      } finally { await handle.close(); }
    }
  }
  await walk(root, "", 0); return files;
}
function signature(files: Map<string, LocalFile>) { return [...files.entries()].sort(([a],[b])=>a.localeCompare(b)); }
function metadataSignature(file: BackupFile) { return [file.id,file.name,file.parents,file.trashed,file.mimeType,file.md5Checksum,file.size,file.version,file.modifiedTime,file.capabilities?.canDownload]; }

/** Compares only ordinary Markdown blobs, restoring matched files into a disposable isolated directory. */
export async function verifyMarkdownBackup(sourceRoot: string, folderId: string, drive: BackupDrive, guard: () => Promise<void>) {
  const started = new Date().toISOString(); const source = await localSnapshot(sourceRoot, guard);
  await guard(); const root = await drive.metadata(folderId);
  if (root.id !== folderId || root.trashed || root.mimeType !== folderMime) throw new Error("Backup root is not a live folder");
  const cloud = new Map<string, BackupFile>(); let entries = 0, directories = 0, incomplete = false, ambiguous = 0;
  async function walk(id: string, prefix: string, depth: number) {
    if (++directories > 30 || depth > 5) { incomplete = true; return; }
    await guard(); const listing = await drive.children(id); incomplete ||= listing.incomplete;
    const names = new Set<string>();
    for (const file of listing.files) {
      if (++entries > 200) { incomplete = true; return; }
      if (!plainName(file.name) || typeof file.id !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(file.id) || file.trashed || !file.parents?.includes(id)) { incomplete = true; continue; }
      const name = file.name;
      if (names.has(name)) { ambiguous++; incomplete = true; continue; } names.add(name);
      if (file.mimeType === folderMime) { await walk(file.id, prefix + name + "/", depth + 1); continue; }
      if (!name.toLowerCase().endsWith(".md")) continue;
      if (cloud.size >= maxFiles) { incomplete = true; continue; }
      cloud.set(prefix + name, file);
    }
  }
  await walk(folderId, "", 0);
  let matched = 0, missing = 0, different = 0, unavailable = 0, restored = 0;
  const temporaryRoot = await realpath(tmpdir()); const stage = await mkdtemp(join(temporaryRoot, "paperclip-backup-check-"));
  let cleaned = false; let staged = 0;
  try {
    for (const [name, local] of source) {
      const file = cloud.get(name);
      if (!file) { missing++; continue; }
      if (!/^[a-f0-9]{32}$/i.test(file.md5Checksum ?? "") || !file.size || !file.capabilities?.canDownload || file.mimeType?.startsWith("application/vnd.google-apps.")) { unavailable++; continue; }
      if (file.md5Checksum!.toLowerCase() !== local.md5 || Number(file.size) !== local.size) { different++; continue; }
      matched++;
      await guard(); const before = await drive.metadata(file.id!);
      if (!same(metadataSignature(before),metadataSignature(file))) { unavailable++; continue; }
      await guard(); const bytes = await drive.download(file.id!);
      if (bytes.length > maxBytes || bytes.length !== local.size || hash(bytes,"md5") !== local.md5 || hash(bytes,"sha256") !== local.sha256) { different++; continue; }
      // Generated filenames never contain remote names. Restored bytes are never executed or returned.
      const path = join(stage, String(staged++)); await writeFile(path, bytes, {flag:"wx",mode:0o600});
      if (hash(await readFile(path),"sha256") !== local.sha256) throw new Error("Temporary restore mismatch");
      await guard(); const after = await drive.metadata(file.id!);
      if (!same(metadataSignature(after),metadataSignature(file))) { unavailable++; continue; }
      restored++;
    }
    await guard(); const currentSource = await localSnapshot(sourceRoot, guard);
    if (!same(signature(source), signature(currentSource))) throw new Error("Source changed during verification");
    if (!same(metadataSignature(root),metadataSignature(await drive.metadata(folderId)))) throw new Error("Backup root changed");
  } finally {
    const target = resolve(stage);
    if (dirname(target) !== temporaryRoot || !basename(target).startsWith("paperclip-backup-check-")) throw new Error("Unsafe temporary cleanup target");
    await rm(target, {recursive:true,force:true}); cleaned = true;
  }
  await guard();
  const extra = [...cloud.keys()].filter(name=>!source.has(name)).length;
  return {status: source.size > 0 && !incomplete && !ambiguous && !missing && !different && !unavailable && !extra && restored === source.size ? "matched_and_restore_tested" : "needs_review",
    sourceFiles:source.size,cloudMarkdownFiles:cloud.size,checksumMatches:matched,missing,different,unavailable,extra,ambiguous,incomplete,restoreTestedFiles:restored,temporaryFilesRemoved:cleaned,observedAtUtc:started,
    limitations:"This worker host's bounded ordinary Markdown tree only (50 files, 1 MiB each, 8 MiB source total, 5 levels). No upload, persistent restore, execution, secret/config/database backup or workstation diagnosis. Names, contents and hashes remain internal. Metadata and downloaded bytes matched this observed source snapshot; this is not a historical retention guarantee, automatic sync proof or atomic provider snapshot."};
}
