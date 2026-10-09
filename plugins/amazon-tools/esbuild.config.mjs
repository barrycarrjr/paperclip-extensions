import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const { esbuild: presets } = createPluginBundlerPresets();

await Promise.all([
  esbuild.build(presets.worker),
  // The manifest shares tool declarations with the worker. Include local
  // imports so installed dist/ can load without the source tree.
  esbuild.build({ ...presets.manifest, bundle: true }),
]);
