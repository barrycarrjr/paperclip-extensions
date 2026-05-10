/**
 * Build the backup-tools plugin into self-contained dist/ artifacts.
 *
 * - dist/worker.js  — bundled (all runtime deps inlined). The S3, Google Drive,
 *   noble crypto, and tar libraries are all pure-JS so they bundle cleanly.
 * - dist/manifest.js — transpiled only.
 * - dist/ui/index.js — UI bundle (sidebar + page + dashboard widget).
 */
import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const { esbuild: presets } = createPluginBundlerPresets();

await Promise.all([
  esbuild.build(presets.worker),
  esbuild.build(presets.manifest),
  esbuild.build({
    entryPoints: ["src/ui/index.tsx"],
    outfile: "dist/ui/index.js",
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2022"],
    sourcemap: true,
    external: [
      "react",
      "react-dom",
      "react/jsx-runtime",
      "@paperclipai/plugin-sdk/ui",
    ],
  }),
]);
