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
  // UI bundle — React and SDK ui module are provided by Paperclip at runtime.
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
