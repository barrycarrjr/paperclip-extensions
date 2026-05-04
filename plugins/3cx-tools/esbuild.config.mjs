import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const { esbuild: presets } = createPluginBundlerPresets();

await Promise.all([
  esbuild.build(presets.worker),
  esbuild.build(presets.manifest),
]);
