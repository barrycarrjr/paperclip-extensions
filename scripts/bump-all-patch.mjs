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
  // v0.65.0: backup-tools and gbp-reviews carry the release's real changes —
  // both were unreadable under the dark theme. The other 22 are alignment bumps.
  "backup-tools":
    "The Backups page is readable in dark mode, and the Overview card reports its\n" +
    "  cadence. Every colour on the page was a hardcoded light-mode hex, so the tab\n" +
    "  you were currently on was painted near-black against the dark theme's\n" +
    "  near-black page — the selected tab was the one tab you could not read. The\n" +
    "  page now reads the host's theme tokens (`--foreground`, `--muted-foreground`,\n" +
    "  `--border`, `--card`, `--primary`, `--destructive`), which is what the other\n" +
    "  plugin pages already do, so it follows light and dark without a second\n" +
    "  palette. Buttons also show a disabled state, which they previously did not.\n" +
    "\n" +
    "  Separately, `dashboard.health` never selected the `cadence` column the\n" +
    "  Overview card renders, so the card always printed a bare \"Cadence:\" with\n" +
    "  nothing after it. The column is now in the query.",
  "gbp-reviews":
    "Location names are visible in dark mode. The location cards painted a fixed\n" +
    "  near-white background while the name inherited the theme's text colour, so\n" +
    "  under the dark theme the name was near-white on near-white. The cards now use\n" +
    "  the host's `--card` surface, and the \"needs attention\" variant tints that\n" +
    "  surface with amber instead of replacing it.",
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

// Two manifest shapes in the wild: older plugins hoist a `const PLUGIN_VERSION`,
// newer ones (acx-tools, kdp-tools, s3-tools, youtube-tools) write the version
// inline on the manifest object. Handle both — a plugin that matches neither is
// a real problem worth stopping for.
function bumpManifest(manifestPath, expectedNewVer) {
  const raw = readFileSync(manifestPath, "utf8");
  const constRe = /(const\s+PLUGIN_VERSION\s*=\s*")[^"]+(")/;
  if (constRe.test(raw)) {
    writeFileSync(manifestPath, raw.replace(constRe, `$1${expectedNewVer}$2`));
    return;
  }
  const inlineRe = /(^\s*version\s*:\s*")[^"]+(",)/m;
  if (inlineRe.test(raw)) {
    writeFileSync(manifestPath, raw.replace(inlineRe, `$1${expectedNewVer}$2`));
    return;
  }
  throw new Error(`no PLUGIN_VERSION or inline version in ${manifestPath}`);
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
