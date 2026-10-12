#!/usr/bin/env node
// Repack Paperclip's plugin SDK into vendor/sdk/ and point every plugin at it.
// This is the supported way to change vendor/sdk/*.tgz; do not repack by hand.
//
// Usage: node scripts/vendor-sdk.mjs --paperclip <path to a Paperclip checkout> [--skip-build]
//
// 1. Builds @paperclipai/shared and @paperclipai/plugin-sdk in that checkout
//    (unless --skip-build).
// 2. Packs both with `pnpm pack`, so workspace versions are resolved and
//    publishConfig is applied.
// 3. Stamps each with a unique version, `<version>-vendor.<fingerprint>`, taken
//    from its contents, so the installed version shows which pack a plugin has.
//    A pack whose contents did not change keeps the tarball already in
//    vendor/sdk, so an unchanged SDK changes no files.
// 4. Writes vendor/sdk/shared.tgz and vendor/sdk/plugin-sdk.tgz, only once both
//    packs succeeded.
// 5. Updates every plugin lock file that uses them (integrity and version),
//    only once every one of them has the expected entry.
// 6. Reinstalls each such plugin from a clean node_modules and checks its copy
//    matches. pnpm keeps an old copy of a repacked `file:` tarball otherwise
//    (see scripts/vendored-sdk.mjs).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkPlugin,
  contentFingerprint,
  integrityOf,
  readTarball,
  reinstallPlugin,
  runPnpm,
  stampedVersion,
  updateLockEntry,
  vendoredOverrides,
} from "./vendored-sdk.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = path.join(repoRoot, "vendor", "sdk");
const pluginsDir = path.join(repoRoot, "plugins");
const RECOVER =
  "To put the previous SDK back: git checkout -- vendor/sdk plugins/*/pnpm-lock.yaml, then rebuild the plugins " +
  "(each build refreshes its packages).";
// shared first: the SDK's dependency on it is rewritten to shared's stamped version.
const PACKAGES = [
  { name: "@paperclipai/shared", dir: "packages/shared", file: "shared.tgz" },
  { name: "@paperclipai/plugin-sdk", dir: "packages/plugins/sdk", file: "plugin-sdk.tgz" },
];

const args = process.argv.slice(2);
const paperclipArg = args[args.indexOf("--paperclip") + 1];
if (!args.includes("--paperclip") || !paperclipArg || paperclipArg.startsWith("--")) {
  console.error("Usage: node scripts/vendor-sdk.mjs --paperclip <path to a Paperclip checkout> [--skip-build]");
  process.exit(2);
}
const paperclip = path.resolve(paperclipArg);
const skipBuild = args.includes("--skip-build");

/** tar with relative names only: GNU tar reads a "C:" path as a remote host. */
function tar(tarArgs, cwd) {
  const result = spawnSync("tar", tarArgs, { cwd, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`tar ${tarArgs.join(" ")} failed in ${cwd}`);
}

/**
 * pnpm rewrites the first line of a package's bin files when it ends in CRLF,
 * on Linux and Mac. Packed that way, every install there would differ from the
 * tarball, and the build check would reinstall for ever. Refuse such a pack.
 */
function assertBinFilesUseLf(manifest, files) {
  const bins = typeof manifest.bin === "string" ? [manifest.bin] : Object.values(manifest.bin ?? {});
  for (const bin of bins) {
    const content = files.get(`package/${bin.replace(/^\.\//, "")}`);
    if (!content) continue;
    const firstLine = content.subarray(0, content.indexOf(0x0a) >= 0 ? content.indexOf(0x0a) + 1 : content.length);
    if (firstLine.includes(0x0d)) throw new Error(`${manifest.name}: bin file ${bin} has a CRLF first line; rebuild it with LF`);
  }
}

// Pack and stamp both packages before anything in vendor/sdk changes.
const work = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-sdk-"));
const results = [];
const stampedVersions = new Map();
try {
  for (const pkg of PACKAGES) {
    const source = path.join(paperclip, pkg.dir);
    if (!fs.existsSync(path.join(source, "package.json"))) throw new Error(`${pkg.name} not found at ${source}`);
    if (!skipBuild && !runPnpm(["--filter", pkg.name, "build"], paperclip)) throw new Error(`building ${pkg.name} failed`);

    // Pack into an empty folder of its own, so the one .tgz there is this pack.
    const packDir = path.join(work, pkg.file.replace(/\.tgz$/, ""));
    fs.mkdirSync(packDir);
    if (!runPnpm(["pack", "--pack-destination", packDir], source)) throw new Error(`packing ${pkg.name} failed`);
    const packed = fs.readdirSync(packDir).filter((name) => name.endsWith(".tgz"));
    if (packed.length !== 1) throw new Error(`expected one pack for ${pkg.name}, found ${packed.length}`);

    const files = readTarball(path.join(packDir, packed[0]));
    const manifest = JSON.parse(files.get("package/package.json").toString("utf8"));
    if (manifest.name !== pkg.name) throw new Error(`packed ${manifest.name}, expected ${pkg.name}`);
    for (const [dependency, version] of stampedVersions) {
      if (manifest.dependencies?.[dependency]) manifest.dependencies[dependency] = version;
    }
    files.set("package/package.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));
    assertBinFilesUseLf(manifest, files);
    const fingerprint = contentFingerprint(files);
    manifest.version = stampedVersion(manifest.version, fingerprint);
    stampedVersions.set(pkg.name, manifest.version);

    const target = path.join(vendorDir, pkg.file);
    const current = fs.existsSync(target) ? readTarball(target) : null;
    const unchanged =
      current &&
      contentFingerprint(current) === fingerprint &&
      JSON.parse(current.get("package/package.json")?.toString("utf8") ?? "{}").version === manifest.version;
    if (unchanged) {
      results.push({ pkg, version: manifest.version, target, stamped: null });
      continue;
    }

    tar(["-xzf", packed[0]], packDir);
    fs.writeFileSync(path.join(packDir, "package", "package.json"), JSON.stringify(manifest, null, 2) + "\n");
    tar(["-czf", "stamped.tgz", "package"], packDir);
    const stamped = path.join(packDir, "stamped.tgz");
    const check = readTarball(stamped);
    if (contentFingerprint(check) !== fingerprint || JSON.parse(check.get("package/package.json").toString("utf8")).version !== manifest.version) {
      throw new Error(`${pkg.name}: the stamped tarball does not read back as packed`);
    }
    results.push({ pkg, version: manifest.version, target, stamped });
  }

  for (const result of results) {
    if (result.stamped) fs.copyFileSync(result.stamped, result.target);
    console.log(`[vendor-sdk] ${result.pkg.name} ${result.version}${result.stamped ? ` -> vendor/sdk/${result.pkg.file}` : " unchanged"}`);
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
if (results.every((result) => !result.stamped)) {
  console.log("[vendor-sdk] nothing to do.");
  process.exit(0);
}

// Work out every lock file change first, so a missing entry stops the run
// before any lock file is written.
const targets = new Map(PACKAGES.map((pkg) => [path.join(vendorDir, pkg.file), pkg]));
const lockUpdates = [];
for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const pluginDir = path.join(pluginsDir, entry.name);
  if (!fs.existsSync(path.join(pluginDir, "package.json"))) continue;
  const uses = vendoredOverrides(pluginDir).filter((override) => targets.has(override.tarball));
  if (uses.length === 0) continue;
  const lockPath = path.join(pluginDir, "pnpm-lock.yaml");
  let lock = fs.readFileSync(lockPath, "utf8");
  for (const override of uses) {
    const { name } = targets.get(override.tarball);
    const { text, count } = updateLockEntry(lock, override.spec, integrityOf(override.tarball), stampedVersions.get(name));
    if (count !== 1) {
      throw new Error(`${lockPath}: expected one entry for ${override.spec}, found ${count}. ${RECOVER}`);
    }
    lock = text;
  }
  lockUpdates.push({ name: entry.name, pluginDir, lockPath, lock });
}

for (const update of lockUpdates) fs.writeFileSync(update.lockPath, update.lock);
for (const update of lockUpdates) {
  if (!reinstallPlugin(update.pluginDir)) throw new Error(`${update.name}: the reinstall failed. ${RECOVER}`);
  const stale = checkPlugin(update.pluginDir).filter((result) => result.stale);
  if (stale.length > 0) {
    throw new Error(`${update.name}: still stale after the reinstall (${stale.map((s) => s.name).join(", ")}). ${RECOVER}`);
  }
}

console.log(`[vendor-sdk] updated ${lockUpdates.length} plugins: ${lockUpdates.map((u) => u.name).join(", ")}`);
console.log("[vendor-sdk] commit vendor/sdk/*.tgz and those plugins' pnpm-lock.yaml together.");
