/**
 * Build the plugin into self-contained dist/ artifacts.
 *
 * - dist/worker.js  — bundled (all runtime deps inlined). Spawned by paperclip
 *   as a worker process; must run without the plugin folder's node_modules.
 * - dist/manifest.js — transpiled only (small file, type-only imports erased).
 *
 * The `createRequire` banner on the worker bundle is required because some
 * runtime deps (stripe, etc.) are CJS and use dynamic `require()` calls that
 * don't resolve in plain ESM. The banner polyfills `require` against the
 * worker's import.meta.url so the bundled CJS code works at runtime.
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
  esbuild.build(presets.manifest),
]);
