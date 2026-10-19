import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });
const watch = process.argv.includes("--watch");
const contexts = await Promise.all([
  esbuild.context(presets.esbuild.worker),
  esbuild.context(presets.esbuild.manifest),
  esbuild.context(presets.esbuild.ui),
]);

if (watch) {
  await Promise.all(contexts.map((context) => context.watch()));
  console.log("agent-roster esbuild watch mode enabled (worker, manifest, ui)");
} else {
  try {
    await Promise.all(contexts.map((context) => context.rebuild()));
  } finally {
    await Promise.all(contexts.map((context) => context.dispose()));
  }
}
