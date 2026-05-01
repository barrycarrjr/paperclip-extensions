import {
  definePlugin,
  runWorker,
  type PluginContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { Jimp, ResizeStrategy } from "jimp";
import path from "node:path";
import {
  type ConfigProvider,
  type InstanceConfig,
  type ResolvedProvider,
  getProvider,
} from "./providers.js";
import { ensureStorageDir, resolveOutputPath } from "./storage.js";
import { compose, type Layer } from "./compose.js";
import { editImage, generateImages } from "./generate.js";
import { isCompanyAllowed } from "./companyAccess.js";

type ResolveResult =
  | { ok: true; resolved: ResolvedProvider }
  | { ok: false; error: string };

async function resolveOrError(
  ctx: PluginContext,
  runCtx: ToolRunContext,
  toolName: string,
  providerKey: string | undefined,
): Promise<ResolveResult> {
  try {
    const resolved = await getProvider(ctx, runCtx, toolName, providerKey);
    return { ok: true, resolved };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function track(
  ctx: PluginContext,
  runCtx: ToolRunContext,
  tool: string,
  providerKey: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  try {
    await ctx.telemetry.track(`image-tools.${tool}`, {
      provider: providerKey,
      companyId: runCtx.companyId,
      runId: runCtx.runId,
      ...extra,
    });
  } catch {
    // no-op
  }
}

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    ctx.logger.info("image-tools plugin setup");

    const rawConfig = (await ctx.config.get()) as InstanceConfig;
    const allowGeneration = !!rawConfig.allowGeneration;
    const providers: ConfigProvider[] = rawConfig.providers ?? [];

    if (providers.length === 0) {
      ctx.logger.warn(
        "image-tools: no providers configured. Add at least one on /instance/settings/plugins/image-tools — even local-only tools route through providers for company-isolation.",
      );
    } else {
      const summary = providers
        .map((p) => {
          const k = p.key ?? "(no-key)";
          const allowed = p.allowedCompanies;
          const access =
            !allowed || allowed.length === 0
              ? "no companies — UNUSABLE"
              : allowed.includes("*")
                ? "portfolio-wide"
                : `${allowed.length} company(s)`;
          return `${k} [${p.kind ?? "?"}, ${access}]`;
        })
        .join(", ");
      ctx.logger.info(
        `image-tools: ready (generation ${allowGeneration ? "ENABLED" : "disabled"}). Providers — ${summary}`,
      );
    }

    function gateGeneration(tool: string): { error: string } | null {
      if (allowGeneration) return null;
      return {
        error: `[EDISABLED] ${tool} is disabled. Enable 'Allow generative tools (cost gate)' on /instance/settings/plugins/image-tools after reviewing provider costs.`,
      };
    }

    // ─── Local: compose / resize / upscale ───────────────────────────────

    ctx.tools.register(
      "image_compose",
      {
        displayName: "Compose image",
        description:
          "Compose an image from background + image/text layers. Local sharp-based.",
        parametersSchema: {
          type: "object",
          properties: {
            provider: { type: "string" },
            outputPath: { type: "string" },
            width: { type: "number" },
            height: { type: "number" },
            background: { type: "string" },
            layers: { type: "array", items: { type: "object" } },
          },
          required: ["width", "height", "layers"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as {
          provider?: string;
          outputPath?: string;
          width?: number;
          height?: number;
          background?: string;
          layers?: Layer[];
        };
        if (!p.width || !p.height)
          return { error: "[EINVALID_INPUT] `width` and `height` are required" };
        if (!p.layers || !Array.isArray(p.layers))
          return { error: "[EINVALID_INPUT] `layers` must be an array (may be empty)" };

        const r = await resolveOrError(ctx, runCtx, "image_compose", p.provider);
        if (!r.ok) return { error: r.error };

        try {
          const outputPath = await resolveOutputPath(
            runCtx.runId,
            p.outputPath,
            ".png",
            "compose",
          );
          const result = await compose({
            width: Math.round(p.width),
            height: Math.round(p.height),
            background: p.background,
            layers: p.layers,
            outputPath,
          });
          await track(ctx, runCtx, "image_compose", r.resolved.providerKey, {
            width: result.width,
            height: result.height,
            layerCount: p.layers.length,
          });
          return {
            content: `Composed ${result.width}×${result.height} → ${result.outputPath}.`,
            data: result,
          };
        } catch (err) {
          return { error: `[ECOMPOSE] ${(err as Error).message}` };
        }
      },
    );

    ctx.tools.register(
      "image_resize",
      {
        displayName: "Resize image",
        description: "Resize / fit-crop with sharp.",
        parametersSchema: {
          type: "object",
          properties: {
            provider: { type: "string" },
            inputPath: { type: "string" },
            width: { type: "number" },
            height: { type: "number" },
            fit: { type: "string" },
            outputPath: { type: "string" },
          },
          required: ["inputPath"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as {
          provider?: string;
          inputPath?: string;
          width?: number;
          height?: number;
          fit?: "cover" | "contain" | "fill" | "inside" | "outside";
          outputPath?: string;
        };
        if (!p.inputPath) return { error: "[EINVALID_INPUT] `inputPath` is required" };

        const r = await resolveOrError(ctx, runCtx, "image_resize", p.provider);
        if (!r.ok) return { error: r.error };

        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const img: any = await Jimp.read(p.inputPath);
          const fit = p.fit ?? "cover";
          const w = p.width;
          const h = p.height;
          if (fit === "fill" && w !== undefined && h !== undefined) {
            img.resize({ w, h, mode: ResizeStrategy.BILINEAR });
          } else if (fit === "contain" && w !== undefined && h !== undefined) {
            img.contain({ w, h });
          } else if (fit === "cover" && w !== undefined && h !== undefined) {
            img.cover({ w, h });
          } else if (w !== undefined && h !== undefined) {
            img.resize({ w, h, mode: ResizeStrategy.BILINEAR });
          } else if (w !== undefined) {
            const ratio = w / img.bitmap.width;
            img.resize({
              w,
              h: Math.round(img.bitmap.height * ratio),
              mode: ResizeStrategy.BILINEAR,
            });
          } else if (h !== undefined) {
            const ratio = h / img.bitmap.height;
            img.resize({
              w: Math.round(img.bitmap.width * ratio),
              h,
              mode: ResizeStrategy.BILINEAR,
            });
          } else {
            return { error: "[EINVALID_INPUT] Provide at least one of `width` or `height`." };
          }
          const outputPath = await resolveOutputPath(runCtx.runId, p.outputPath, ".png", "resize");
          await img.write(outputPath);
          await track(ctx, runCtx, "image_resize", r.resolved.providerKey, {
            width: img.bitmap.width,
            height: img.bitmap.height,
          });
          return {
            content: `Resized to ${img.bitmap.width}×${img.bitmap.height} → ${outputPath}.`,
            data: { outputPath, width: img.bitmap.width, height: img.bitmap.height },
          };
        } catch (err) {
          return { error: `[ERESIZE] ${(err as Error).message}` };
        }
      },
    );

    ctx.tools.register(
      "image_upscale",
      {
        displayName: "Upscale image",
        description: "Lanczos upscale via sharp. 2× / 3× / 4×.",
        parametersSchema: {
          type: "object",
          properties: {
            provider: { type: "string" },
            inputPath: { type: "string" },
            scale: { type: "number" },
            outputPath: { type: "string" },
          },
          required: ["inputPath"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as {
          provider?: string;
          inputPath?: string;
          scale?: number;
          outputPath?: string;
        };
        if (!p.inputPath) return { error: "[EINVALID_INPUT] `inputPath` is required" };
        const scale = p.scale ?? 2;
        if (![2, 3, 4].includes(scale)) {
          return { error: "[EINVALID_INPUT] `scale` must be 2, 3, or 4" };
        }

        const r = await resolveOrError(ctx, runCtx, "image_upscale", p.provider);
        if (!r.ok) return { error: r.error };

        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const img: any = await Jimp.read(p.inputPath);
          const inW = img.bitmap.width;
          const inH = img.bitmap.height;
          const newW = Math.round(inW * scale);
          const newH = Math.round(inH * scale);
          img.resize({ w: newW, h: newH, mode: ResizeStrategy.BICUBIC });
          const ext = path.extname(p.inputPath) || ".png";
          const defaultName = `${path.basename(p.inputPath, ext)}-${scale}x.png`;
          const outputPath =
            p.outputPath ?? path.join(await ensureStorageDir(runCtx.runId), defaultName);
          await img.write(outputPath);

          await track(ctx, runCtx, "image_upscale", r.resolved.providerKey, {
            scale,
            inWidth: inW,
            outWidth: img.bitmap.width,
          });
          return {
            content: `Upscaled ${inW}×${inH} → ${img.bitmap.width}×${img.bitmap.height} (×${scale}).`,
            data: { outputPath, width: img.bitmap.width, height: img.bitmap.height, scale },
          };
        } catch (err) {
          return { error: `[EUPSCALE] ${(err as Error).message}` };
        }
      },
    );

    // ─── Generation (gated) ──────────────────────────────────────────────

    ctx.tools.register(
      "image_generate",
      {
        displayName: "Generate image",
        description: "Generate images from a text prompt.",
        parametersSchema: {
          type: "object",
          properties: {
            provider: { type: "string" },
            prompt: { type: "string" },
            negativePrompt: { type: "string" },
            width: { type: "number" },
            height: { type: "number" },
            model: { type: "string" },
            seed: { type: "number" },
            count: { type: "number" },
            extraParams: { type: "object", additionalProperties: true },
          },
          required: ["prompt"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const gate = gateGeneration("image_generate");
        if (gate) return gate;

        const p = params as {
          provider?: string;
          prompt?: string;
          negativePrompt?: string;
          width?: number;
          height?: number;
          model?: string;
          seed?: number;
          count?: number;
          extraParams?: Record<string, unknown>;
        };
        if (!p.prompt) return { error: "[EINVALID_INPUT] `prompt` is required" };

        const r = await resolveOrError(ctx, runCtx, "image_generate", p.provider);
        if (!r.ok) return { error: r.error };

        try {
          const outputDir = await ensureStorageDir(runCtx.runId);
          const images = await generateImages(r.resolved, outputDir, {
            prompt: p.prompt,
            negativePrompt: p.negativePrompt,
            width: p.width,
            height: p.height,
            model: p.model,
            seed: p.seed,
            count: p.count,
            extraParams: p.extraParams,
          });
          await track(ctx, runCtx, "image_generate", r.resolved.providerKey, {
            count: images.length,
            model: images[0]?.modelUsed,
            kind: r.resolved.provider.kind,
          });
          return {
            content: `Generated ${images.length} image(s) via ${r.resolved.provider.kind ?? "?"} / ${images[0]?.modelUsed}.`,
            data: { images },
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    ctx.tools.register(
      "image_edit",
      {
        displayName: "Edit / vary image",
        description: "Edit an existing image (inpaint / outpaint / variation).",
        parametersSchema: {
          type: "object",
          properties: {
            provider: { type: "string" },
            inputPath: { type: "string" },
            prompt: { type: "string" },
            maskPath: { type: "string" },
            width: { type: "number" },
            height: { type: "number" },
            model: { type: "string" },
          },
          required: ["inputPath", "prompt"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const gate = gateGeneration("image_edit");
        if (gate) return gate;

        const p = params as {
          provider?: string;
          inputPath?: string;
          prompt?: string;
          maskPath?: string;
          width?: number;
          height?: number;
          model?: string;
        };
        if (!p.inputPath) return { error: "[EINVALID_INPUT] `inputPath` is required" };
        if (!p.prompt) return { error: "[EINVALID_INPUT] `prompt` is required" };

        const r = await resolveOrError(ctx, runCtx, "image_edit", p.provider);
        if (!r.ok) return { error: r.error };

        try {
          const outputDir = await ensureStorageDir(runCtx.runId);
          const result = await editImage(r.resolved, outputDir, {
            inputPath: p.inputPath,
            prompt: p.prompt,
            maskPath: p.maskPath,
            width: p.width,
            height: p.height,
            model: p.model,
          });
          await track(ctx, runCtx, "image_edit", r.resolved.providerKey, {
            kind: r.resolved.provider.kind,
            model: result.modelUsed,
          });
          return {
            content: `Edited image → ${result.path}.`,
            data: result,
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );
  },

  async onHealth() {
    return { status: "ok", message: "image-tools ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);

void isCompanyAllowed;
