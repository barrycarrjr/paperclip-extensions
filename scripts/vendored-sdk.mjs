// Helpers for the vendored Paperclip SDK (vendor/sdk/*.tgz).
//
// Plugins that need Paperclip's own SDK (newer than the one on npm) take it from
// tarballs in vendor/sdk/, wired in through each plugin's pnpm.overrides as
// `file:` dependencies. pnpm identifies a `file:` tarball by its path, so after
// the tarball is repacked a frozen install, and every install after one, keeps
// the copy the plugin already has, even with a new version and a new integrity
// in the lock file. A plugin built from the stale copy ships the old SDK: on
// 2026-10-09 a local build of the Slack plugin silently dropped images that way.
// checkPlugin() compares the installed copy with the tarball file by file, and
// scripts/check-vendored-sdk.mjs runs it before every build.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/**
 * How to start pnpm, as `{ command, args, shell }`. Under `pnpm run` from an
 * npm-installed pnpm, npm_execpath is pnpm's own script (pnpm.cjs), which Node
 * runs directly, so arguments keep their spaces. Otherwise (run outside pnpm,
 * or a standalone pnpm binary, which Node cannot run as a script) it is the
 * `pnpm` command. On Windows that is a .cmd shim Node only starts through a
 * shell, so the arguments are quoted into one command line (Node warns when a
 * shell is given separate arguments).
 */
export function pnpmCommand(args, execPath = process.env.npm_execpath ?? "", platform = process.platform) {
  if (/pnpm/i.test(path.basename(execPath)) && /\.[cm]?js$/i.test(execPath)) {
    return { command: process.execPath, args: [execPath, ...args], shell: false };
  }
  if (platform === "win32") return { command: ["pnpm", ...args.map(quoteForCmd)].join(" "), args: [], shell: true };
  return { command: "pnpm", args, shell: false };
}

export function runPnpm(args, cwd, options = {}) {
  const { command, args: commandArgs, shell } = pnpmCommand(args);
  return spawnSync(command, commandArgs, { cwd, stdio: "inherit", shell, ...options }).status === 0;
}

function quoteForCmd(arg) {
  return /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

/**
 * Replace a plugin's installed packages with a clean frozen install. This is
 * the reliable way to refresh a repacked `file:` tarball: `pnpm install
 * --force` also works, but it installs every platform's optional binaries too.
 * Node's rm removes links and junctions without following them, so nothing
 * outside node_modules is touched.
 */
export function reinstallPlugin(pluginDir) {
  fs.rmSync(path.join(pluginDir, "node_modules"), { recursive: true, force: true });
  return runPnpm(["install", "--frozen-lockfile"], pluginDir);
}

/** Every regular file in a .tgz, keyed by its path inside the archive (for example `package/package.json`). */
export function readTarball(tgzPath) {
  const data = zlib.gunzipSync(fs.readFileSync(tgzPath));
  const files = new Map();
  let offset = 0;
  let nextPath = null;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = parseInt(text(header, 124, 12).trim() || "0", 8);
    const type = text(header, 156, 1) || "0";
    const body = data.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;

    if (type === "x") {
      nextPath = paxPath(body) ?? nextPath;
      continue;
    }
    if (type === "L") {
      nextPath = body.toString("utf8").replace(/\0[\s\S]*$/, "");
      continue;
    }
    if (type === "g") continue;

    const prefix = text(header, 345, 155);
    const name = nextPath ?? (prefix ? `${prefix}/${text(header, 0, 100)}` : text(header, 0, 100));
    nextPath = null;
    if (type === "0" || type === "7") files.set(name.replace(/^\.\//, ""), Buffer.from(body));
  }
  return files;
}

function text(header, start, length) {
  return header.subarray(start, start + length).toString("utf8").replace(/\0[\s\S]*$/, "");
}

/** The `path` record of a pax extended header, if it has one. Records are `<length> <key>=<value>\n`, lengths in bytes. */
function paxPath(body) {
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space < 0) break;
    const length = parseInt(body.subarray(offset, space).toString("utf8"), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = body.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals > 0 && record.slice(0, equals) === "path") return record.slice(equals + 1);
    offset += length;
  }
  return null;
}

/** The lock-file integrity of a file: `sha512-` and the base64 digest, as pnpm writes it. */
export function integrityOf(filePath) {
  return "sha512-" + createHash("sha512").update(fs.readFileSync(filePath)).digest("base64");
}

/**
 * A short fingerprint of a packed package's contents, ignoring its own version
 * (the version is what gets stamped with this fingerprint). Same files, same
 * fingerprint, so repacking unchanged code gives the same stamp.
 */
export function contentFingerprint(files) {
  const hash = createHash("sha256");
  for (const name of [...files.keys()].sort()) {
    let content = files.get(name);
    if (name === "package/package.json") {
      const pkg = JSON.parse(content.toString("utf8"));
      delete pkg.version;
      content = Buffer.from(JSON.stringify(pkg));
    }
    hash.update(name).update("\0").update(content).update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

/** The version a repack stamps on a package: its own version plus `-vendor.<fingerprint>`. */
export function stampedVersion(baseVersion, fingerprint) {
  return `${String(baseVersion).replace(/-vendor\.[0-9a-f]+$/, "")}-vendor.${fingerprint}`;
}

/** The vendored tarballs a plugin's pnpm.overrides point at, as `{ name, spec, tarball }`. */
export function vendoredOverrides(pluginDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, "package.json"), "utf8"));
  const overrides = pkg.pnpm?.overrides ?? {};
  return Object.entries(overrides)
    .filter(([, spec]) => typeof spec === "string" && spec.startsWith("file:") && spec.endsWith(".tgz"))
    .map(([name, spec]) => ({ name, spec, tarball: path.resolve(pluginDir, spec.slice("file:".length)) }));
}

/**
 * Every installed copy of a vendored package in a plugin: the top-level link
 * when the plugin depends on it directly, and the copies pnpm keeps in
 * node_modules/.pnpm for a package that only arrives through another one (the
 * SDK brings @paperclipai/shared that way). Directory names there look like
 * `@paperclipai+shared@file+..+..+vendor+sdk+shared.tgz`, sometimes with a
 * `_<peer>` suffix.
 */
function installedCopies(pluginDir, name, tarball) {
  const copies = new Set();
  const direct = path.join(pluginDir, "node_modules", ...name.split("/"));
  if (fs.existsSync(path.join(direct, "package.json"))) copies.add(fs.realpathSync(direct));
  const store = path.join(pluginDir, "node_modules", ".pnpm");
  const prefix = `${name.replace("/", "+")}@file+`;
  if (fs.existsSync(store)) {
    for (const entry of fs.readdirSync(store)) {
      if (!entry.startsWith(prefix) || !entry.includes(path.basename(tarball))) continue;
      const dir = path.join(store, entry, "node_modules", ...name.split("/"));
      if (fs.existsSync(path.join(dir, "package.json"))) copies.add(fs.realpathSync(dir));
    }
  }
  return [...copies];
}

/**
 * Compare each vendored package installed in a plugin's node_modules with its
 * tarball. One result per package: `{ name, tarball, packedVersion,
 * installedVersion, stale, differences }`.
 */
export function checkPlugin(pluginDir) {
  return vendoredOverrides(pluginDir).map(({ name, tarball }) => {
    const files = readTarball(tarball);
    const packed = JSON.parse(files.get("package/package.json")?.toString("utf8") ?? "{}");
    const copies = installedCopies(pluginDir, name, tarball);
    const differences = [];
    let installedVersion = null;
    if (![...files.keys()].some((entry) => entry.startsWith("package/"))) {
      differences.push("the tarball has no package/ folder, so nothing could be compared");
    }
    if (copies.length === 0) differences.push("not installed");
    for (const installedDir of copies) {
      installedVersion ??= JSON.parse(fs.readFileSync(path.join(installedDir, "package.json"), "utf8")).version ?? null;
      for (const [entry, content] of files) {
        if (!entry.startsWith("package/")) continue;
        const relative = entry.slice("package/".length);
        const installedPath = path.join(installedDir, ...relative.split("/"));
        if (!fs.existsSync(installedPath)) differences.push(`missing ${relative}`);
        else if (!content.equals(fs.readFileSync(installedPath))) differences.push(`changed ${relative}`);
      }
    }
    return {
      name,
      tarball,
      packedVersion: packed.version ?? null,
      installedVersion,
      stale: differences.length > 0,
      differences,
    };
  });
}

/**
 * Point a lock file's entry for a vendored tarball at a new integrity and
 * version. pnpm refuses a lock file whose version does not match the tarball's
 * (ERR_PNPM_UNEXPECTED_PKG_CONTENT_IN_STORE), so both change together.
 * Returns the new text and how many entries changed. Keeps CRLF or LF as found.
 */
export function updateLockEntry(lockText, spec, integrity, version) {
  const escaped = spec.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const entry = new RegExp(
    `(@${escaped}':\\r?\\n\\s+resolution: \\{integrity: )[^,]+(, tarball: ${escaped}\\}\\r?\\n\\s+version: )[^\\r\\n]+`,
    "g",
  );
  let count = 0;
  const text = lockText.replace(entry, (_match, before, middle) => {
    count += 1;
    return before + integrity + middle + version;
  });
  return { text, count };
}
