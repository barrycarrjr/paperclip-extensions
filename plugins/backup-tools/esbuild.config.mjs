/**
 * Build the backup-tools plugin into self-contained dist/ artifacts.
 *
 * - dist/worker.js  — bundled (all runtime deps inlined). The S3, Google Drive,
 *   and noble crypto libraries are pure-JS so they bundle cleanly. The AWS
 *   SDK's @smithy/* helpers do `require("buffer")` for Node built-ins, which
 *   doesn't work in esbuild's ESM output without a createRequire banner —
 *   we install one below so bundled CJS can resolve Node built-ins via
 *   import.meta.url.
 * - dist/manifest.js — transpiled only.
 * - dist/ui/index.js — UI bundle (sidebar + page + dashboard widget).
 */
import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const { esbuild: presets } = createPluginBundlerPresets();

// Inject a working `require` into the ESM worker bundle so bundled CJS
// dependencies (AWS SDK uses @smithy/util-buffer-from which calls
// require("buffer")) can resolve Node built-ins. Without this, esbuild's
// own `__require` shim throws `Dynamic require of "buffer" is not supported`
// at first use of the SDK.
const cjsShimBanner = {
  js:
    "import { createRequire as __pcCreateRequire } from 'node:module';" +
    "const require = __pcCreateRequire(import.meta.url);",
};

await Promise.all([
  esbuild.build({ ...presets.worker, banner: cjsShimBanner }),
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
