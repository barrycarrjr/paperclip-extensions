// Pack every plugin under plugins/ into a `<plugin-id>-<version>.pcplugin`
// zip, written to dist-pcplugins/ at the repo root. The release workflow
// uploads each .pcplugin as an asset on the GitHub release.
//
// Each plugin must already be built (run `pnpm run build:all` first or run
// `pnpm build` inside each plugin folder).
//
// The packed archive contains:
//   - dist/                   ← the built JS, copied verbatim
//   - package.json            ← sanitized: only fields paperclip needs at
//                               runtime (name, version, type, paperclipPlugin,
//                               dependencies, engines)
import { readdir, readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import JSZip from "jszip";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const PLUGINS_DIR = path.join(REPO_ROOT, "plugins");
const OUTPUT_DIR = path.join(REPO_ROOT, "dist-pcplugins");

const PACKED_FIELDS = [
  "name",
  "version",
  "type",
  "paperclipPlugin",
  "dependencies",
  "engines",
];

async function loadManifestFromDist(pluginDir) {
  const manifestPath = path.join(pluginDir, "dist", "manifest.js");
  if (!existsSync(manifestPath)) {
    throw new Error(`No dist/manifest.js at ${manifestPath}. Build the plugin first.`);
  }
  const url = pathToFileURL(manifestPath).href + `?t=${Date.now()}`;
  const mod = await import(url);
  const manifest = mod.default ?? mod;
  if (!manifest?.id || !manifest?.version) {
    throw new Error(`Invalid manifest at ${manifestPath}: ${JSON.stringify(manifest)}`);
  }
  return manifest;
}

async function addDirToZip(zip, absDir, zipBase) {
  const entries = await readdir(absDir, { withFileTypes: true });
  for (const e of entries) {
    const abs = path.join(absDir, e.name);
    const rel = zipBase ? `${zipBase}/${e.name}` : e.name;
    if (e.isDirectory()) await addDirToZip(zip, abs, rel);
    else if (e.isFile()) zip.file(rel, await readFile(abs));
  }
}

async function packOne(pluginDir) {
  const distDir = path.join(pluginDir, "dist");
  const pkgRaw = await readFile(path.join(pluginDir, "package.json"), "utf-8");
  const pkg = JSON.parse(pkgRaw);
  const sanitized = {};
  for (const k of PACKED_FIELDS) {
    if (k in pkg) sanitized[k] = pkg[k];
  }

  const manifest = await loadManifestFromDist(pluginDir);

  const zip = new JSZip();
  zip.file("package.json", JSON.stringify(sanitized, null, 2) + "\n");
  await addDirToZip(zip, distDir, "dist");

  const buf = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  const outName = `${manifest.id}-${manifest.version}.pcplugin`;
  const outPath = path.join(OUTPUT_DIR, outName);
  await writeFile(outPath, buf);
  return {
    id: manifest.id,
    version: manifest.version,
    displayName: manifest.displayName ?? manifest.id,
    description: manifest.description ?? "",
    categories: manifest.categories ?? [],
    author: manifest.author ?? null,
    apiVersion: manifest.apiVersion ?? 1,
    capabilities: manifest.capabilities ?? [],
    fileName: outName,
    outPath,
    sizeBytes: buf.byteLength,
    sizeKb: Math.round(buf.byteLength / 1024),
  };
}

await rm(OUTPUT_DIR, { recursive: true, force: true });
await mkdir(OUTPUT_DIR, { recursive: true });

const entries = await readdir(PLUGINS_DIR, { withFileTypes: true });
const results = [];
for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const dir = path.join(PLUGINS_DIR, entry.name);
  if (!existsSync(path.join(dir, "package.json"))) continue;
  console.log(`Packing ${entry.name}…`);
  const r = await packOne(dir);
  results.push(r);
  console.log(`  ✓ ${r.id} v${r.version} → ${path.basename(r.outPath)} (${r.sizeKb} KB)`);
}

if (results.length === 0) {
  console.error("No plugins found to pack.");
  process.exit(1);
}

// Emit an index.json alongside the .pcplugin files. The Plugin Library UI
// fetches this index from a GitHub release to render the available plugins
// without having to download each .pcplugin and inspect its manifest.
const index = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  plugins: results.map((r) => ({
    id: r.id,
    version: r.version,
    displayName: r.displayName,
    description: r.description,
    categories: r.categories,
    author: r.author,
    apiVersion: r.apiVersion,
    capabilities: r.capabilities,
    fileName: r.fileName,
    sizeBytes: r.sizeBytes,
  })),
};
await writeFile(
  path.join(OUTPUT_DIR, "index.json"),
  JSON.stringify(index, null, 2) + "\n",
  "utf-8",
);

console.log(`\nPacked ${results.length} plugin(s) to ${OUTPUT_DIR}/`);
console.log(`Wrote ${path.join(OUTPUT_DIR, "index.json")}`);
