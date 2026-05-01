/**
 * Build the plugin into self-contained dist/ artifacts.
 *
 * The Octokit SDK is partly CJS so we ship the worker with a createRequire
 * banner like email-tools and stripe-tools.
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
