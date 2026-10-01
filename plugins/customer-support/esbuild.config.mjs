import esbuild from "esbuild";
import { cpSync } from "node:fs";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });
const contexts = await Promise.all([
  esbuild.context(presets.esbuild.worker),
  // The manifest shares tool declarations with the worker. Include local
  // imports so installed dist/ can load without the source tree.
  esbuild.context({ ...presets.esbuild.manifest, bundle: true }),
  esbuild.context(presets.esbuild.ui),
]);
try {
  await Promise.all(contexts.map((context) => context.rebuild()));
  cpSync("scripts", "dist/scripts", { recursive: true, force: true });
} finally {
  await Promise.all(contexts.map((context) => context.dispose()));
}
