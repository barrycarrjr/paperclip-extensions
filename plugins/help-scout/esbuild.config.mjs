/**
 * Build the plugin into self-contained dist/ artifacts.
 *
 * - dist/worker.js  — bundled (all runtime deps inlined). Spawned by paperclip
 *   as a worker process; must run without the plugin folder's node_modules.
 * - dist/manifest.js — transpiled only (small file, type-only imports erased).
 *
 * The Help Scout client uses native fetch — no CJS require shimming needed.
 */
import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const { esbuild: presets } = createPluginBundlerPresets();

await Promise.all([
  esbuild.build(presets.worker),
  esbuild.build(presets.manifest),
]);
