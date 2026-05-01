/**
 * Provider integrations for image_generate / image_edit.
 *
 * v0.1.0 ships:
 *   - Replicate (recommended): predictions API, polling for completion.
 *   - OpenAI: images.generate / images.edit.
 *
 * Other kinds (stability, local) accept the call but throw [EPROVIDER_KIND_UNSUPPORTED]
 * — implement when a skill needs them.
 */
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { ResolvedProvider } from "./providers.js";

export interface GenerateOptions {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  model?: string;
  seed?: number;
  count?: number;
  extraParams?: Record<string, unknown>;
}

export interface GeneratedImage {
  path: string;
  width: number;
  height: number;
  seed: number | null;
  modelUsed: string;
}

export async function generateImages(
  resolved: ResolvedProvider,
  outputDir: string,
  options: GenerateOptions,
): Promise<GeneratedImage[]> {
  const kind = resolved.provider.kind ?? "replicate";
  if (kind === "replicate") return generateReplicate(resolved, outputDir, options);
  if (kind === "openai") return generateOpenAI(resolved, outputDir, options);
  throw new Error(
    `[EPROVIDER_KIND_UNSUPPORTED] image_generate is not implemented for kind="${kind}" in v0.1.0.`,
  );
}

async function generateReplicate(
  resolved: ResolvedProvider,
  outputDir: string,
  opts: GenerateOptions,
): Promise<GeneratedImage[]> {
  if (!resolved.apiKey) {
    throw new Error(`[ECONFIG] Replicate provider has no apiKey resolved.`);
  }
  const model = opts.model ?? resolved.provider.defaultModel ?? "black-forest-labs/flux-schnell";
  const width = opts.width ?? 1024;
  const height = opts.height ?? 1024;
  const count = Math.max(1, Math.min(4, opts.count ?? 1));

  const input: Record<string, unknown> = {
    ...(resolved.provider.defaultParams ?? {}),
    ...(opts.extraParams ?? {}),
    prompt: opts.prompt,
    width,
    height,
    num_outputs: count,
  };
  if (opts.negativePrompt) input.negative_prompt = opts.negativePrompt;
  if (opts.seed !== undefined) input.seed = opts.seed;

  // Replicate API: model versions expose a `version` hash; the public endpoint
  // accepts either { version: "<hash>" } or, for owner-named models, posting
  // to /v1/models/<owner>/<name>/predictions.
  const [owner, name] = model.split("/");
  const endpoint =
    owner && name
      ? `https://api.replicate.com/v1/models/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/predictions`
      : `https://api.replicate.com/v1/predictions`;

  const create = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resolved.apiKey}`,
      "Content-Type": "application/json",
      Prefer: "wait", // ask Replicate to keep the connection open up to ~60s
    },
    body: JSON.stringify(owner && name ? { input } : { version: model, input }),
  });
  if (!create.ok) {
    const t = await create.text().catch(() => "");
    throw new Error(`[EREPLICATE_${create.status}] ${t || create.statusText}`);
  }
  let pred = (await create.json()) as {
    id?: string;
    status?: string;
    output?: string | string[];
    urls?: { get?: string };
    error?: string;
  };

  // Poll until terminal if not already finished
  const start = Date.now();
  while (
    pred.status &&
    !["succeeded", "failed", "canceled"].includes(pred.status) &&
    Date.now() - start < 5 * 60 * 1000
  ) {
    await new Promise((r) => setTimeout(r, 2000));
    if (!pred.urls?.get) break;
    const poll = await fetch(pred.urls.get, {
      headers: { Authorization: `Bearer ${resolved.apiKey}` },
    });
    if (!poll.ok) {
      const t = await poll.text().catch(() => "");
      throw new Error(`[EREPLICATE_POLL_${poll.status}] ${t || poll.statusText}`);
    }
    pred = (await poll.json()) as typeof pred;
  }

  if (pred.status === "failed" || pred.status === "canceled") {
    throw new Error(`[EREPLICATE_${pred.status?.toUpperCase()}] ${pred.error ?? "no detail"}`);
  }

  const outputs = Array.isArray(pred.output) ? pred.output : pred.output ? [pred.output] : [];
  if (outputs.length === 0) {
    throw new Error("[EREPLICATE_EMPTY] prediction returned no images");
  }

  const results: GeneratedImage[] = [];
  for (let i = 0; i < outputs.length; i++) {
    const url = outputs[i];
    const buf = await downloadToBuffer(url);
    const filePath = path.join(outputDir, `replicate-${pred.id ?? "out"}-${i}.png`);
    await writeFile(filePath, buf);
    results.push({
      path: filePath,
      width,
      height,
      seed: opts.seed ?? null,
      modelUsed: model,
    });
  }
  return results;
}

async function generateOpenAI(
  resolved: ResolvedProvider,
  outputDir: string,
  opts: GenerateOptions,
): Promise<GeneratedImage[]> {
  if (!resolved.apiKey) {
    throw new Error(`[ECONFIG] OpenAI provider has no apiKey resolved.`);
  }
  const model = opts.model ?? resolved.provider.defaultModel ?? "gpt-image-1";
  const width = opts.width ?? 1024;
  const height = opts.height ?? 1024;
  const count = Math.max(1, Math.min(4, opts.count ?? 1));
  const size = `${width}x${height}`;

  const body: Record<string, unknown> = {
    model,
    prompt: opts.prompt,
    n: count,
    size,
    response_format: "b64_json",
    ...(resolved.provider.defaultParams ?? {}),
    ...(opts.extraParams ?? {}),
  };

  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resolved.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`[EOPENAI_${res.status}] ${t || res.statusText}`);
  }
  const data = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
  const items = data.data ?? [];
  if (items.length === 0) throw new Error("[EOPENAI_EMPTY] no images returned");

  const results: GeneratedImage[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let buf: Buffer;
    if (item.b64_json) {
      buf = Buffer.from(item.b64_json, "base64");
    } else if (item.url) {
      buf = await downloadToBuffer(item.url);
    } else {
      throw new Error("[EOPENAI_FORMAT] item lacks both b64_json and url");
    }
    const filePath = path.join(outputDir, `openai-${Date.now()}-${i}.png`);
    await writeFile(filePath, buf);
    results.push({ path: filePath, width, height, seed: null, modelUsed: model });
  }
  return results;
}

async function downloadToBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`[EDOWNLOAD_${res.status}] failed to fetch ${url}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

export interface EditOptions {
  inputPath: string;
  prompt: string;
  maskPath?: string;
  width?: number;
  height?: number;
  model?: string;
}

export async function editImage(
  resolved: ResolvedProvider,
  outputDir: string,
  opts: EditOptions,
): Promise<GeneratedImage> {
  const kind = resolved.provider.kind ?? "replicate";
  if (kind === "openai") return editOpenAI(resolved, outputDir, opts);
  if (kind === "replicate") return editReplicate(resolved, outputDir, opts);
  throw new Error(
    `[EPROVIDER_KIND_UNSUPPORTED] image_edit is not implemented for kind="${kind}" in v0.1.0.`,
  );
}

async function editOpenAI(
  resolved: ResolvedProvider,
  outputDir: string,
  opts: EditOptions,
): Promise<GeneratedImage> {
  if (!resolved.apiKey) throw new Error(`[ECONFIG] OpenAI provider has no apiKey resolved.`);
  const model = opts.model ?? resolved.provider.defaultModel ?? "gpt-image-1";

  const inputBuf = await readFile(opts.inputPath);
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", opts.prompt);
  // The Web FormData API takes Blob; in Node 20 we can construct from a Uint8Array.
  form.append(
    "image",
    new Blob([new Uint8Array(inputBuf)], { type: "image/png" }),
    path.basename(opts.inputPath),
  );
  if (opts.maskPath) {
    const maskBuf = await readFile(opts.maskPath);
    form.append(
      "mask",
      new Blob([new Uint8Array(maskBuf)], { type: "image/png" }),
      path.basename(opts.maskPath),
    );
  }
  if (opts.width && opts.height) form.append("size", `${opts.width}x${opts.height}`);

  const res = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${resolved.apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`[EOPENAI_${res.status}] ${t || res.statusText}`);
  }
  const data = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
  const item = data.data?.[0];
  if (!item) throw new Error("[EOPENAI_EMPTY] no image returned");
  const buf = item.b64_json
    ? Buffer.from(item.b64_json, "base64")
    : await downloadToBuffer(item.url!);
  const filePath = path.join(outputDir, `openai-edit-${Date.now()}.png`);
  await writeFile(filePath, buf);
  return {
    path: filePath,
    width: opts.width ?? 1024,
    height: opts.height ?? 1024,
    seed: null,
    modelUsed: model,
  };
}

async function editReplicate(
  resolved: ResolvedProvider,
  outputDir: string,
  opts: EditOptions,
): Promise<GeneratedImage> {
  // Replicate's "edit" surface depends on the model. For SDXL inpainting the
  // inputs are { image, mask, prompt }. For img2img variation: { image, prompt,
  // strength }. We pass through `extraParams` semantics by routing through
  // generateReplicate with image + mask Base64 inlined into input.
  if (!resolved.apiKey) throw new Error(`[ECONFIG] Replicate provider has no apiKey resolved.`);
  const inputBuf = await readFile(opts.inputPath);
  const imageDataUrl = `data:image/png;base64,${inputBuf.toString("base64")}`;
  let maskDataUrl: string | undefined;
  if (opts.maskPath) {
    const maskBuf = await readFile(opts.maskPath);
    maskDataUrl = `data:image/png;base64,${maskBuf.toString("base64")}`;
  }

  const results = await generateReplicate(resolved, outputDir, {
    prompt: opts.prompt,
    width: opts.width,
    height: opts.height,
    model: opts.model,
    extraParams: {
      image: imageDataUrl,
      ...(maskDataUrl ? { mask: maskDataUrl } : {}),
    },
  });
  if (results.length === 0) throw new Error("[EREPLICATE_EMPTY] edit returned no image");
  return results[0];
}
