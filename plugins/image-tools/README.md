# Image Tools (paperclip plugin)

Local image composition + provider-pluggable generation. Multi-provider,
per-provider `allowedCompanies`, generation gated by a cost switch.

> **When to use this plugin vs. Canva MCP:** Canva MCP is the right answer
> for templated brand work. This plugin is for one-off generative work,
> programmatic composition (resize/overlay/text), and zero-cost local
> rendering. The two complement each other rather than overlap.

> **Install + setup walkthrough** lives in-app: open the plugin's settings page in Paperclip and follow the **Setup** tab. This README is an overview of capabilities and a reference for tool/event shapes.

## Recent changes

- **v0.2.6** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.2.5** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.2.4** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.2.3** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.2.2** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

## Tools registered

| Tool | Kind | External cost? |
|---|---|---|
| `image_compose` | local | none |
| `image_resize` | local | none |
| `image_upscale` | local (bicubic) | none |
| `image_generate` | gen — gated | yes (Replicate / OpenAI per call) |
| `image_edit` | gen — gated | yes |

All five enforce the per-provider `allowedCompanies` allow-list — even
the local tools, so usage is attributable.

## Install

```bash
cd %USERPROFILE%\paperclip-extensions\plugins\image-tools
pnpm install      # installs jimp's native binary
pnpm build

# From paperclip:
pnpm --filter paperclipai exec tsx src/index.ts plugin install --local %USERPROFILE%\paperclip-extensions\plugins\image-tools
```

> **jimp note:** jimp is a native binding (libvips). pnpm fetches the
> Windows prebuilt automatically. If install fails, try
> `npm rebuild jimp` inside the plugin folder.

## Configure

Even if you only use local tools, configure at least one provider so the
company-isolation gate can resolve. Use `kind: "local"` (no API key) if
you'll never generate.

### 1. (Optional) Get a Replicate or OpenAI API key

For generation:

- **Replicate** (recommended): replicate.com/account/api-tokens →
  generate a token. Pay-per-second; budget-friendly for SDXL-Lightning
  / Flux Schnell.
- **OpenAI**: platform.openai.com/api-keys. Higher per-image cost but
  fewer moving parts.

### 2. Store the key as a paperclip secret

`<COMPANY-PREFIX>/company/settings/secrets` → **+ Create secret**, paste
the API token, save. Copy the secret's UUID.

### 3. Bind the provider in the plugin config

`/instance/settings/plugins/image-tools` → **+ Add item**:

| Field | Example | Notes |
|---|---|---|
| `Identifier` | `replicate-main` | Stable ID agents pass. |
| `Provider kind` | `replicate` | or `openai` / `stability` / `local` |
| `API key` | (secret UUID) | Required for replicate / openai. |
| `Default model` | `black-forest-labs/flux-schnell` (Replicate) or `gpt-image-1` (OpenAI) | Override per call. |
| `Default model params` | `{}` | e.g. `{ "guidance_scale": 3.5 }` for Flux. |
| `Allowed companies` | `["*"]` for shared key, or specific company UUIDs | Empty = unusable. |

Set **Default provider key** so agents can omit `provider`.

To enable generation, flip **Allow generative tools (cost gate)** on. This
is intentionally separate from `allowMutations` because the cost profile
is different — generative calls cost real money per call.

## Tool usage examples

### Compose a YouTube thumbnail (1280×720)

```ts
await tools.invoke("image_compose", {
  width: 1280,
  height: 720,
  background: "#0d1117",
  layers: [
    {
      type: "image",
      path: "/path/to/thumbnail-bg.jpg",
      x: 0,
      y: 0,
      w: 1280,
      h: 720,
    },
    {
      type: "text",
      text: "How I Built\\nan AI OS",
      x: 60,
      y: 200,
      w: 1100,
      font: "Bebas Neue",
      size: 144,
      weight: 800,
      color: "#ffffff",
      align: "left",
    },
    {
      type: "text",
      text: "with paperclip",
      x: 60,
      y: 480,
      font: "Inter",
      size: 60,
      weight: 400,
      color: "#7d8590",
    },
  ],
});
// → { outputPath: "<run-storage>/compose-abc123.png", width: 1280, height: 720 }
```

### Generate an SDXL background

```ts
await tools.invoke("image_generate", {
  // provider omitted → defaultProvider
  prompt: "modern minimalist desk setup, soft natural light, 4k photo, depth of field",
  width: 1280,
  height: 720,
  count: 2,
});
// → { images: [{ path, width, height, seed, modelUsed }] }
```

(Requires `allowGeneration=true`.)

### Resize for Instagram square (1080×1080)

```ts
await tools.invoke("image_resize", {
  inputPath: "/path/to/source.png",
  width: 1080,
  height: 1080,
  fit: "cover",
});
```

### 2× upscale via bicubic resize

```ts
await tools.invoke("image_upscale", {
  inputPath: "/path/to/small.png",
  scale: 2,
});
```

For higher quality upscale, use `image_generate` with a model like
`nightmareai/real-esrgan` and pass the source via `extraParams.image`.

## Storage

Generated and composed images land in:

```
~/.paperclip/instances/default/data/storage/image-tools/<run-id>/<name>.png
```

(or `…/shared/` if no run-id is available). Pass `outputPath` to
override.

The directory is per-run, so heartbeats can clean up by deleting the
run folder. The plugin doesn't auto-clean.

## Fonts

v0.1.0 uses **jimp's bundled bitmap fonts** for text rendering. This
means:

- Available sizes are **16, 32, 64, 128 px** — the plugin rounds your
  requested `size` to the nearest of these.
- Available colors are **black or white** — the plugin picks based on
  your CSS color (`#fff` / `white` / any RGB > 128 average → white,
  everything else → black).
- The `font` and `weight` parameters are **informational only** in
  v0.1.0 — bitmap fonts don't honor a custom font family or weight.

For arbitrary sizes/colors and true font families, swap in a vector
text renderer (canvaskit-wasm or pure-JS node-canvas) — tracked as
v0.2 work.

Practical workaround for high-fidelity text today: render the text in
your design tool of choice, export a transparent PNG, and drop it in
as an `image` layer.

## Error codes

| Code | Meaning |
|---|---|
| `[EPROVIDER_REQUIRED]` | No provider param and no default. |
| `[EPROVIDER_NOT_FOUND]` | Provider identifier not in plugin config. |
| `[ECOMPANY_NOT_ALLOWED]` | Calling company isn't in this provider's `allowedCompanies`. |
| `[ECONFIG]` | Provider lacks apiKeyRef where required, or secret didn't resolve. |
| `[EDISABLED]` | Generative tool called while `allowGeneration=false`. |
| `[EINVALID_INPUT]` | Required param missing. |
| `[ECOMPOSE]` / `[ERESIZE]` / `[EUPSCALE]` | Local jimp pipeline error. |
| `[EREPLICATE_<status>]` | Replicate API error (with status code). |
| `[EOPENAI_<status>]` | OpenAI API error. |
| `[EPROVIDER_KIND_UNSUPPORTED]` | Used a provider kind not yet wired (stability / local). |
| `[EDOWNLOAD_<status>]` | Failed to download a generated image's binary. |

## Cost tracking

Every generative call emits `ctx.telemetry.track("image-tools.image_generate",
{ provider, kind, model, count, companyId, runId })`. Aggregate via the
cost-events service. The plugin doesn't enforce a budget — that's a
host-side concern.

## `allowedCompanies` cheatsheet

A shared API key can use `["*"]` to keep config simple, with
attribution coming through telemetry. For cost-sensitive setups, scope
each provider to a specific company.

## Out of scope (this version)

- `image_describe` (vision / captioning) — the calling agent already
  has vision via its adapter. Re-implementing here would lock the
  plugin to one vision provider, against the LLM-agnostic rule.
- Background removal.
- Animation / video — separate `video-tools` plugin.
- Style-transfer / brand-template enforcement — Canva MCP territory.
- 3D / depth.

## Versioning

`0.1.0` — initial release. 5 tools across local composition / generation.
Replicate + OpenAI providers wired. Stability / local stubs return
`[EPROVIDER_KIND_UNSUPPORTED]`.
