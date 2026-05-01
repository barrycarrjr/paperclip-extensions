import {
  type PluginContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { oauth2 as oauth2Api } from "@googleapis/oauth2";
import { getGoogleAccount, wrapGoogleError } from "../googleAuth.js";
import { AUTH_TOOLS } from "../schemas.js";
import { track } from "../telemetry.js";

export function registerAuthTools(ctx: PluginContext): void {
  const schema = AUTH_TOOLS.find((t) => t.name === "google_test_auth");
  if (!schema) throw new Error("google_test_auth schema missing");

  ctx.tools.register(
    schema.name,
    {
      displayName: schema.displayName,
      description: schema.description,
      parametersSchema: schema.parametersSchema,
    },
    async (params, runCtx: ToolRunContext): Promise<ToolResult> => {
      const p = (params ?? {}) as { account?: string };
      let resolved;
      try {
        resolved = await getGoogleAccount(ctx, runCtx, "google_test_auth", p.account);
      } catch (err) {
        return { error: (err as Error).message };
      }

      try {
        const oauth2 = oauth2Api({ version: "v2", auth: resolved.oauth2Client });
        const info = await oauth2.userinfo.get();
        await track(ctx, runCtx, "google_test_auth", resolved.accountKey);
        return {
          content: `Authenticated as ${info.data.email ?? "(unknown)"} (account: ${resolved.accountKey}).`,
          data: {
            ok: true,
            account: resolved.accountKey,
            email: info.data.email ?? null,
            name: info.data.name ?? null,
            scopes: resolved.scopes,
          },
        };
      } catch (err) {
        return { error: wrapGoogleError(err) };
      }
    },
  );
}
