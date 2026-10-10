#!/usr/bin/env node
// Run by the build of every plugin that uses the vendored SDK (see each such
// plugin's package.json): refuses to build against a stale copy of vendor/sdk.
//
// A frozen `pnpm install` keeps an old copy of a repacked `file:` tarball (see
// scripts/vendored-sdk.mjs), so when the installed copy differs from the
// tarball this removes the plugin's node_modules, installs again from the lock
// file, and checks once more. On a fresh install, as in CI, it finds nothing to
// do.
//
// Usage, from a plugin folder: node ../../scripts/check-vendored-sdk.mjs [--no-fix]
import { checkPlugin, reinstallPlugin } from "./vendored-sdk.mjs";

const pluginDir = process.cwd();
const noFix = process.argv.includes("--no-fix");
const FIX = "remove this plugin's node_modules, then run: pnpm install --frozen-lockfile";

function describe(result) {
  const shown = result.differences.slice(0, 3).join("; ");
  const more = result.differences.length > 3 ? `; and ${result.differences.length - 3} more` : "";
  return `${result.name}: installed ${result.installedVersion ?? "nothing"}, packed ${result.packedVersion} (${shown}${more})`;
}

let stale = checkPlugin(pluginDir).filter((result) => result.stale);
if (stale.length === 0) process.exit(0);

console.warn(`[vendored-sdk] stale copy in ${pluginDir}:\n  ${stale.map(describe).join("\n  ")}`);
if (noFix) {
  console.error(`[vendored-sdk] to fix it, ${FIX}`);
  process.exit(1);
}

console.warn("[vendored-sdk] reinstalling this plugin's packages from its lock file");
if (!reinstallPlugin(pluginDir)) {
  console.error(`[vendored-sdk] the reinstall failed; the build stops here. To retry by hand, ${FIX}`);
  process.exit(1);
}

stale = checkPlugin(pluginDir).filter((result) => result.stale);
if (stale.length > 0) {
  console.error(`[vendored-sdk] still stale after the reinstall:\n  ${stale.map(describe).join("\n  ")}`);
  process.exit(1);
}
console.warn("[vendored-sdk] refreshed; building.");
