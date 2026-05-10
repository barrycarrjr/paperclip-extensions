#!/usr/bin/env node
/**
 * One-shot patch-bump every plugin and append a Recent-changes entry to its README.
 *
 * Used to refresh per-plugin versions when ALL plugins should appear as
 * "update available" inside Paperclip's Plugin Manager — which compares the
 * installed plugin's `version` against the latest registry entry. Repo-level
 * monotonic release tags don't move per-plugin versions; this script does.
 *
 * Run: node scripts/bump-all-patch.mjs
 *
 * Per-plugin notes are configured in SPECIAL_NOTES below — edit those each
 * release to describe what's actually shipping. Plugins not in SPECIAL_NOTES
 * get the uniform alignment-bump line.
 *
 * Idempotency: re-running the script is NOT safe. Each invocation bumps
 * patch by 1 unconditionally. Run once per release.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(__dirname);
const PLUGINS_DIR = join(REPO_ROOT, "plugins");

const SPECIAL_NOTES = {
  "backup-tools":
    "First release on the registry. v0.1.0 ships system-snapshot management: encrypted backups (Argon2id + AES-256-GCM, client-side) on a schedule, fan-out to S3-compatible + Google Drive destinations, and a restore wizard with typed-confirmation. Requires paperclip core ≥ the matching system-snapshot endpoints landing in the host repo. Full feature list and v0.2 roadmap in README.",
};

const DEFAULT_NOTE = "Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.";

function bumpPatch(version) {
  const parts = version.split(".").map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
    throw new Error(`unparseable version: ${version}`);
  }
  parts[2] += 1;
  return parts.join(".");
}

function bumpPackageJson(pkgPath) {
  const raw = readFileSync(pkgPath, "utf8");
  const before = raw.match(/"version"\s*:\s*"([^"]+)"/);
  if (!before) throw new Error(`no version in ${pkgPath}`);
  const oldVer = before[1];
  const newVer = bumpPatch(oldVer);
  const next = raw.replace(/"version"\s*:\s*"[^"]+"/, `"version": "${newVer}"`);
  writeFileSync(pkgPath, next);
  return { oldVer, newVer };
}

function bumpManifest(manifestPath, expectedNewVer) {
  const raw = readFileSync(manifestPath, "utf8");
  const re = /(const\s+PLUGIN_VERSION\s*=\s*")[^"]+(")/;
  if (!re.test(raw)) throw new Error(`no PLUGIN_VERSION in ${manifestPath}`);
  const next = raw.replace(re, `$1${expectedNewVer}$2`);
  writeFileSync(manifestPath, next);
}

function updateReadme(readmePath, plugin, oldVer, newVer) {
  const raw = readFileSync(readmePath, "utf8");
  const note = SPECIAL_NOTES[plugin] ?? DEFAULT_NOTE;
  const entry = `- **v${newVer}** — ${note}\n`;

  if (raw.includes("## Recent changes")) {
    // Prepend new entry at the top of the existing list.
    const next = raw.replace(
      /(## Recent changes\s*\n+)/,
      `$1${entry}\n`,
    );
    writeFileSync(readmePath, next);
    return "appended";
  }

  // No existing Recent changes section → insert one above the first `## ` heading.
  const firstSection = raw.match(/^##\s+.*$/m);
  if (!firstSection) {
    throw new Error(`no ## heading in ${readmePath}`);
  }
  const idx = firstSection.index;
  const prefix = raw.slice(0, idx);
  const rest = raw.slice(idx);
  const block = `## Recent changes\n\n${entry}\n`;
  writeFileSync(readmePath, prefix + block + rest);
  return "created";
}

const plugins = readdirSync(PLUGINS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

const results = [];
for (const plugin of plugins) {
  const pkgPath = join(PLUGINS_DIR, plugin, "package.json");
  const manifestPath = join(PLUGINS_DIR, plugin, "src", "manifest.ts");
  const readmePath = join(PLUGINS_DIR, plugin, "README.md");
  if (!existsSync(pkgPath) || !existsSync(manifestPath)) {
    console.warn(`SKIP ${plugin} — missing package.json or src/manifest.ts`);
    continue;
  }
  const { oldVer, newVer } = bumpPackageJson(pkgPath);
  bumpManifest(manifestPath, newVer);
  let readmeStatus = "skipped";
  if (existsSync(readmePath)) {
    readmeStatus = updateReadme(readmePath, plugin, oldVer, newVer);
  }
  results.push({ plugin, oldVer, newVer, readmeStatus });
}

console.table(results);
console.log(`\nBumped ${results.length} plugins. Now: stage, commit, tag, push.`);
