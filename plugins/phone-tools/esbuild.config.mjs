import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const { esbuild: presets } = createPluginBundlerPresets();

await Promise.all([
  esbuild.build(presets.worker),
  esbuild.build(presets.manifest),
  // UI bundle for the in-Paperclip Assistants feature (sidebar + agent
  // detail tab). React, react-dom, and the SDK ui module are externalised —
  // Paperclip provides them at runtime via the bridge registry.
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
