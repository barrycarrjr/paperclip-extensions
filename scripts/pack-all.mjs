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
//   - <migrationsDir>/        ← when the manifest declares
//                               `database.migrationsDir`, the SQL migration
//                               files at that path are included verbatim. The
//                               host resolves the dir relative to the install
//                               root and reads .sql files from it.
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

  // Include manifest-declared migrations directory if present. The host
  // resolves `database.migrationsDir` relative to the install root and reads
  // .sql files from it; without this they'd be missing and activation fails
  // with ENOENT scandir on the migrations path.
  const migrationsDir = manifest.database?.migrationsDir;
  if (migrationsDir) {
    const absMigrations = path.join(pluginDir, migrationsDir);
    if (existsSync(absMigrations)) {
      await addDirToZip(zip, absMigrations, migrationsDir);
    } else {
      throw new Error(
        `Manifest declares database.migrationsDir="${migrationsDir}" but ${absMigrations} does not exist.`,
      );
    }
  }

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

// Merge in `coming-soon.json` placeholder entries. These are plugin ideas
// without a packed .pcplugin asset — the host UI shows them with a "Coming
// soon" badge and the install endpoint rejects them server-side.
const comingSoonPath = path.join(REPO_ROOT, "coming-soon.json");
if (existsSync(comingSoonPath)) {
  const comingSoonRaw = await readFile(comingSoonPath, "utf-8");
  const comingSoonData = JSON.parse(comingSoonRaw);
  const stubs = Array.isArray(comingSoonData.plugins) ? comingSoonData.plugins : [];
  const builtIds = new Set(results.map((r) => r.id));
  let appended = 0;
  for (const stub of stubs) {
    if (!stub?.id) {
      console.warn("Skipping coming-soon entry without an id:", stub);
      continue;
    }
    // If the same id already shipped as a real plugin, skip the stub —
    // the built entry is authoritative.
    if (builtIds.has(stub.id)) continue;
    index.plugins.push({
      id: stub.id,
      version: stub.version ?? "0.0.0",
      displayName: stub.displayName ?? stub.id,
      description: stub.description ?? "",
      categories: stub.categories ?? [],
      author: stub.author ?? null,
      apiVersion: stub.apiVersion ?? 1,
      capabilities: stub.capabilities ?? [],
      comingSoon: true,
    });
    appended++;
  }
  if (appended > 0) {
    console.log(`Merged ${appended} coming-soon placeholder(s) from coming-soon.json`);
  }
}

await writeFile(
  path.join(OUTPUT_DIR, "index.json"),
  JSON.stringify(index, null, 2) + "\n",
  "utf-8",
);

// ---------------------------------------------------------------------------
// Roadmap: a single source of truth for ideas across the whole portfolio
// (skills, agents, routines, features, plugins, etc.). Every paperclip
// instance pointed at this repo fetches dist-pcplugins/roadmap.json and
// renders it on /roadmap.
//
// The output is the union of:
//   - one item per built plugin            (type=plugin, status=shipped)
//   - one item per coming-soon.json stub   (type=plugin, status=planned)
//   - every item in roadmap.json verbatim  (skills/agents/routines/etc.)
//
// Schema (see roadmap.json $comment for the full cheatsheet):
//   { schemaVersion, generatedAt, items: [
//       { id, type, title, description, status,
//         addedAt?, linkedPluginId?, notes? }
//     ] }
// ---------------------------------------------------------------------------
const VALID_ROADMAP_TYPES = new Set([
  "skill",
  "agent",
  "routine",
  "feature",
  "plugin",
  "other",
]);
const VALID_ROADMAP_STATUSES = new Set([
  "idea",
  "planned",
  "in-progress",
  "shipped",
  "wont-do",
]);

const roadmapItems = [];

// 1. Built plugins → shipped items.
for (const r of results) {
  roadmapItems.push({
    id: `plugin-${r.id}`,
    type: "plugin",
    title: r.displayName,
    description: r.description,
    status: "shipped",
    linkedPluginId: r.id,
  });
}

// 2. Coming-soon plugins → planned items. (We re-read `coming-soon.json`
// rather than introspecting `index.json` so the keys we use here match the
// raw source-of-truth, not the index's enriched shape.)
if (existsSync(comingSoonPath)) {
  const comingSoonData = JSON.parse(await readFile(comingSoonPath, "utf-8"));
  const stubs = Array.isArray(comingSoonData.plugins) ? comingSoonData.plugins : [];
  const builtIds = new Set(results.map((r) => r.id));
  for (const stub of stubs) {
    if (!stub?.id || builtIds.has(stub.id)) continue;
    roadmapItems.push({
      id: `plugin-${stub.id}`,
      type: "plugin",
      title: stub.displayName ?? stub.id,
      description: stub.description ?? "",
      status: "planned",
      linkedPluginId: stub.id,
    });
  }
}

// 3. Curated roadmap.json entries (skills, agents, routines, features…)
const roadmapPath = path.join(REPO_ROOT, "roadmap.json");
if (existsSync(roadmapPath)) {
  const roadmapData = JSON.parse(await readFile(roadmapPath, "utf-8"));
  const items = Array.isArray(roadmapData.items) ? roadmapData.items : [];
  for (const item of items) {
    if (!item?.id || !item?.title) {
      console.warn("Skipping roadmap entry missing id or title:", item);
      continue;
    }
    if (item.type && !VALID_ROADMAP_TYPES.has(item.type)) {
      console.warn(`Roadmap "${item.id}" has unknown type "${item.type}"`);
    }
    if (item.status && !VALID_ROADMAP_STATUSES.has(item.status)) {
      console.warn(`Roadmap "${item.id}" has unknown status "${item.status}"`);
    }
    roadmapItems.push({
      id: item.id,
      type: item.type ?? "other",
      title: item.title,
      description: item.description ?? "",
      status: item.status ?? "idea",
      ...(item.addedAt ? { addedAt: item.addedAt } : {}),
      ...(item.linkedPluginId ? { linkedPluginId: item.linkedPluginId } : {}),
      ...(item.notes ? { notes: item.notes } : {}),
    });
  }
}

const roadmap = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  items: roadmapItems,
};
await writeFile(
  path.join(OUTPUT_DIR, "roadmap.json"),
  JSON.stringify(roadmap, null, 2) + "\n",
  "utf-8",
);

console.log(`\nPacked ${results.length} plugin(s) to ${OUTPUT_DIR}/`);
console.log(`Wrote ${path.join(OUTPUT_DIR, "index.json")}`);
console.log(`Wrote ${path.join(OUTPUT_DIR, "roadmap.json")} (${roadmapItems.length} items)`);
