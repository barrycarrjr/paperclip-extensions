import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkPlugin,
  contentFingerprint,
  pnpmCommand,
  readTarball,
  stampedVersion,
  updateLockEntry,
} from "./vendored-sdk.mjs";

const checkScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "check-vendored-sdk.mjs");
const LONG_PATH = `dist/${"nested-folder/".repeat(8)}file.js`;
// One name segment over 100 characters cannot be split into tar's prefix and
// name fields, so tar has to write a pax or GNU long-name record for it.
const LONG_NAME = `dist/${"x".repeat(120)}.js`;
const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

/** A fake repo: vendor/sdk/fake.tgz and plugins/demo, whose overrides point at it. */
function fakeRepo(files, { topFolder = "package" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vendored-sdk-test-"));
  roots.push(root);
  const packageDir = path.join(root, "pack", topFolder);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(packageDir, name)), { recursive: true });
    fs.writeFileSync(path.join(packageDir, name), content);
  }
  fs.mkdirSync(path.join(root, "vendor", "sdk"), { recursive: true });
  // Relative names only: GNU tar reads a "C:" path as a remote host.
  const tar = spawnSync("tar", ["-czf", "fake.tgz", topFolder], { cwd: path.join(root, "pack") });
  assert.equal(tar.status, 0, String(tar.stderr));
  fs.copyFileSync(path.join(root, "pack", "fake.tgz"), path.join(root, "vendor", "sdk", "fake.tgz"));

  const pluginDir = path.join(root, "plugins", "demo");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify({ name: "demo", pnpm: { overrides: { "@acme/fake": "file:../../vendor/sdk/fake.tgz", zod: "3.25.76" } } }),
  );
  return { root, pluginDir };
}

/** Install the fake package into the plugin's node_modules, as a copy of the given files. */
function install(pluginDir, files) {
  const dir = path.join(pluginDir, "node_modules", "@acme", "fake");
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
}

const FILES = {
  "package.json": JSON.stringify({ name: "@acme/fake", version: "1.0.0" }, null, 2),
  "dist/index.js": "export const sendsImages = true;\n",
  [LONG_PATH]: "export const deep = 1;\n",
  [LONG_NAME]: "export const long = 1;\n",
};

test("reads every file from a tarball, including long paths and a long file name", () => {
  const { root } = fakeRepo(FILES);
  const files = readTarball(path.join(root, "vendor", "sdk", "fake.tgz"));
  assert.equal(files.get("package/dist/index.js").toString(), FILES["dist/index.js"]);
  assert.equal(files.get(`package/${LONG_PATH}`).toString(), FILES[LONG_PATH]);
  assert.equal(files.get(`package/${LONG_NAME}`).toString(), FILES[LONG_NAME]);
  assert.equal(JSON.parse(files.get("package/package.json").toString()).version, "1.0.0");
});

test("a tarball without a package/ folder is reported, not silently passed", () => {
  const { pluginDir } = fakeRepo(FILES, { topFolder: "other" });
  install(pluginDir, FILES);
  const [result] = checkPlugin(pluginDir);
  assert.equal(result.stale, true);
  assert.match(result.differences[0], /no package\/ folder/);
});

test("a plugin whose installed copy matches the tarball is not stale", () => {
  const { pluginDir } = fakeRepo(FILES);
  install(pluginDir, FILES);
  const [result] = checkPlugin(pluginDir);
  assert.equal(result.name, "@acme/fake");
  assert.equal(result.stale, false);
  assert.deepEqual(result.differences, []);
});

test("a repacked tarball with the same version is still caught, file by file", () => {
  const { pluginDir } = fakeRepo({ ...FILES, "dist/index.js": "export const sendsImages = true;\n// repacked\n" });
  install(pluginDir, FILES);
  const [result] = checkPlugin(pluginDir);
  assert.equal(result.stale, true);
  assert.equal(result.installedVersion, "1.0.0");
  assert.equal(result.packedVersion, "1.0.0");
  assert.deepEqual(result.differences, ["changed dist/index.js"]);
});

test("a package that only arrives through another one is found in pnpm's store", () => {
  const { pluginDir } = fakeRepo(FILES);
  const storeCopy = path.join(pluginDir, "node_modules", ".pnpm", "@acme+fake@file+..+..+vendor+sdk+fake.tgz", "node_modules", "@acme", "fake");
  for (const [name, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(storeCopy, name)), { recursive: true });
    fs.writeFileSync(path.join(storeCopy, name), content);
  }
  assert.equal(checkPlugin(pluginDir)[0].stale, false);
  fs.writeFileSync(path.join(storeCopy, "dist", "index.js"), "old\n");
  assert.deepEqual(checkPlugin(pluginDir)[0].differences, ["changed dist/index.js"]);
});

test("missing files and a missing package are reported", () => {
  const { pluginDir } = fakeRepo({ ...FILES, "dist/new.js": "export {};\n" });
  install(pluginDir, FILES);
  assert.deepEqual(checkPlugin(pluginDir)[0].differences, ["missing dist/new.js"]);
  fs.rmSync(path.join(pluginDir, "node_modules"), { recursive: true });
  assert.deepEqual(checkPlugin(pluginDir)[0].differences, ["not installed"]);
});

test("the build check fails on a stale copy with --no-fix, and passes on a current one", () => {
  const { pluginDir } = fakeRepo({ ...FILES, "dist/index.js": "changed\n" });
  install(pluginDir, FILES);
  const stale = spawnSync(process.execPath, [checkScript, "--no-fix"], { cwd: pluginDir, encoding: "utf8" });
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /remove this plugin's node_modules, then run: pnpm install --frozen-lockfile/);
  assert.match(stale.stderr + stale.stdout, /@acme\/fake: installed 1\.0\.0, packed 1\.0\.0 \(changed dist\/index\.js\)/);

  install(pluginDir, { ...FILES, "dist/index.js": "changed\n" });
  const current = spawnSync(process.execPath, [checkScript, "--no-fix"], { cwd: pluginDir, encoding: "utf8" });
  assert.equal(current.status, 0, current.stderr);
});

test("the fingerprint ignores the version and follows the contents", () => {
  const files = (version, body) =>
    new Map([
      ["package/package.json", Buffer.from(JSON.stringify({ name: "x", version }))],
      ["package/dist/index.js", Buffer.from(body)],
    ]);
  assert.equal(contentFingerprint(files("1.0.0", "a")), contentFingerprint(files("1.0.0-vendor.abc", "a")));
  assert.notEqual(contentFingerprint(files("1.0.0", "a")), contentFingerprint(files("1.0.0", "b")));
  assert.match(contentFingerprint(files("1.0.0", "a")), /^[0-9a-f]{12}$/);
});

test("pnpm runs through Node only when npm_execpath is pnpm's script", () => {
  const args = ["pack", "--pack-destination", "C:\\Temp dir\\pack"];
  const script = "C:\\npm\\node_modules\\pnpm\\bin\\pnpm.cjs";
  assert.deepEqual(pnpmCommand(args, script, "win32"), { command: process.execPath, args: [script, ...args], shell: false });
  // A standalone pnpm binary, and npm's own script under `npm run`, use the pnpm command.
  assert.deepEqual(pnpmCommand(args, "/Users/dev/Library/pnpm/pnpm", "darwin"), { command: "pnpm", args, shell: false });
  assert.deepEqual(pnpmCommand(args, "/usr/lib/node_modules/npm/bin/npm-cli.js", "linux"), { command: "pnpm", args, shell: false });
  assert.deepEqual(pnpmCommand(args, "", "win32"), {
    command: 'pnpm pack --pack-destination "C:\\Temp dir\\pack"',
    args: [],
    shell: true,
  });
});

test("a stamp replaces an earlier stamp instead of stacking", () => {
  assert.equal(stampedVersion("1.0.0", "abc123abc123"), "1.0.0-vendor.abc123abc123");
  assert.equal(stampedVersion("1.0.0-vendor.0123456789ab", "abc123abc123"), "1.0.0-vendor.abc123abc123");
});

for (const eol of ["\n", "\r\n"]) {
  test(`updates the lock file entry's integrity and version together (${eol === "\n" ? "LF" : "CRLF"})`, () => {
    const lock = [
      "packages:",
      "",
      "  '@paperclipai/plugin-sdk@file:../../vendor/sdk/plugin-sdk.tgz':",
      "    resolution: {integrity: sha512-OLD==, tarball: file:../../vendor/sdk/plugin-sdk.tgz}",
      "    version: 1.0.0",
      "    hasBin: true",
      "",
      "snapshots:",
      "",
      "  '@paperclipai/plugin-sdk@file:../../vendor/sdk/plugin-sdk.tgz':",
      "    dependencies:",
      "      zod: 3.25.76",
      "",
    ].join(eol);
    const { text, count } = updateLockEntry(lock, "file:../../vendor/sdk/plugin-sdk.tgz", "sha512-NEW==", "1.0.0-vendor.abc123abc123");
    assert.equal(count, 1);
    assert.match(text, /resolution: \{integrity: sha512-NEW==, tarball: file:\.\.\/\.\.\/vendor\/sdk\/plugin-sdk\.tgz\}\r?\n {4}version: 1\.0\.0-vendor\.abc123abc123/);
    assert.equal(text.split(eol).length, lock.split(eol).length, "line endings kept");
    assert.ok(text.includes(`    dependencies:${eol}      zod: 3.25.76`), "the snapshot entry is left alone");
    assert.equal(updateLockEntry(lock, "file:../../vendor/sdk/shared.tgz", "x", "y").count, 0);
  });
}
