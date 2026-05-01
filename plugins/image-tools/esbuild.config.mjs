/**
 * Image-tools build config.
 *
 * Local image tools use jimp (pure JS) — bundles cleanly into worker.js
 * without any native binding gymnastics. The trade-off is slower
 * pixel-pushing than libvips/sharp, but for thumbnail-scale work (≤1280×720)
 * the difference is irrelevant.
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
