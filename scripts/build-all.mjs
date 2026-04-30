// Run `pnpm install --frozen-lockfile=false && pnpm build` in every plugin
// folder. Used by the release workflow before packing — same effect as the
// developer running `pnpm build` in each plugin folder by hand.
import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGINS_DIR = path.resolve(__dirname, "..", "plugins");

const entries = await readdir(PLUGINS_DIR, { withFileTypes: true });
for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const dir = path.join(PLUGINS_DIR, entry.name);
  if (!existsSync(path.join(dir, "package.json"))) continue;
  console.log(`\n=== ${entry.name} ===`);
  console.log(`  pnpm install`);
  await execFileAsync("pnpm", ["install"], { cwd: dir, shell: true, timeout: 300_000 });
  console.log(`  pnpm build`);
  await execFileAsync("pnpm", ["build"], { cwd: dir, shell: true, timeout: 300_000 });
  const distExists = existsSync(path.join(dir, "dist", "manifest.js"));
  console.log(`  ✓ built (dist/manifest.js: ${distExists ? "yes" : "MISSING"})`);
  if (!distExists) process.exit(1);
}
console.log("\nAll plugins built.");
