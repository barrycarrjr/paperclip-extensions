/**
 * Build the plugin into self-contained dist/ artifacts.
 *
 * - dist/worker.js  — bundled (all runtime deps inlined). Spawned by paperclip
 *   as a worker process; must run without the plugin folder's node_modules.
 * - dist/manifest.js — transpiled only (small file, type-only imports erased).
 *
 * The createRequire banner on the worker bundle is required because googleapis
 * (and its transitive deps) are CJS and use dynamic require() calls that don't
 * resolve in plain ESM. The banner polyfills require against the worker's
 * import.meta.url so the bundled CJS code works at runtime.
 */
import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const { esbuild: presets } = createPluginBundlerPresets();

const REQUIRE_BANNER =
  "import { createRequire as __pcCreateRequire } from 'node:module';" +
  "const require = __pcCreateRequire(import.meta.url);";

await Promise.all([
  esbuild.build({
    ...presets.worker,
    banner: { ...(presets.worker.banner ?? {}), js: REQUIRE_BANNER },
  }),
  // Bundle the manifest so its `./schemas.js` value-import is inlined.
  // (The default preset uses bundle: false; we override because we share
  // tool schemas between manifest.ts and worker tool modules.)
  esbuild.build({
    ...presets.manifest,
    bundle: true,
    external: ["@paperclipai/plugin-sdk"],
  }),
]);
