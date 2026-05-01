import {
  definePlugin,
  runWorker,
  type PluginContext,
} from "@paperclipai/plugin-sdk";
import type { InstanceConfig } from "./googleAuth.js";
import { registerAuthTools } from "./tools/auth.js";
import { registerCalendarTools } from "./tools/calendar.js";
import { registerTasksTools } from "./tools/tasks.js";
import { registerSheetsTools } from "./tools/sheets.js";
import { registerDriveTools } from "./tools/drive.js";
import { registerOAuthFlow } from "./oauthFlow.js";

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    ctx.logger.info("google-workspace plugin setup");

    const rawConfig = (await ctx.config.get()) as InstanceConfig;
    const allowMutations = !!rawConfig.allowMutations;
    const accounts = rawConfig.accounts ?? [];

    if (accounts.length === 0) {
      ctx.logger.warn(
        "google-workspace: no accounts configured. Add them on /instance/settings/plugins/google-workspace.",
      );
    } else {
      const summary = accounts
        .map((a) => {
          const k = a.key ?? "(no-key)";
          const allowed = a.allowedCompanies;
          const access =
            !allowed || allowed.length === 0
              ? "no companies — UNUSABLE"
              : allowed.includes("*")
                ? "portfolio-wide"
                : `${allowed.length} company(s)`;
          return `${k} [${access}]`;
        })
        .join(", ");
      ctx.logger.info(
        `google-workspace: ready (mutations ${allowMutations ? "ENABLED" : "disabled"}). Accounts — ${summary}`,
      );

      const orphans = accounts.filter(
        (a) => !a.allowedCompanies || a.allowedCompanies.length === 0,
      );
      if (orphans.length > 0) {
        ctx.logger.warn(
          `google-workspace: ${orphans.length} account(s) have no allowedCompanies and will reject every call. ` +
            `Backfill on the plugin settings page: ${orphans
              .map((a) => a.key ?? "(no-key)")
              .join(", ")}`,
        );
      }
    }

    registerAuthTools(ctx);
    registerCalendarTools(ctx);
    registerTasksTools(ctx);
    registerSheetsTools(ctx);
    registerDriveTools(ctx);
    registerOAuthFlow(ctx);
  },

  async onHealth() {
    return { status: "ok", message: "google-workspace ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
