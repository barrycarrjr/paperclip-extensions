import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "image-tools";
const PLUGIN_VERSION = "0.2.2";

const providerItemSchema = {
  type: "object",
  required: ["key", "kind", "allowedCompanies"],
  propertyOrder: [
    "key",
    "displayName",
    "kind",
    "apiKeyRef",
    "endpointUrl",
    "defaultModel",
    "defaultParams",
    "allowedCompanies",
  ],
  properties: {
    key: {
      type: "string",
      title: "Identifier",
      description:
        "Short stable ID agents pass when calling generative tools (e.g. 'replicate-main', 'openai-images'). Lowercase, no spaces. Must be unique. Local tools (compose/resize/upscale) also resolve through a provider entry for company-isolation, so configure at least one provider even if you don't plan to generate.",
    },
    displayName: {
      type: "string",
      title: "Display name",
      description: "Free-form label.",
    },
    kind: {
      type: "string",
      enum: ["replicate", "openai", "stability", "local"],
      title: "Provider kind",
      description:
        "What the API endpoint speaks. v0.1.0 ships full support for Replicate (recommended) and OpenAI (DALL-E 3 / gpt-image-1). 'stability' and 'local' are stubs — code paths land in v0.2+.",
    },
    apiKeyRef: {
      type: "string",
      format: "secret-ref",
      title: "API key (UUID of paperclip secret)",
      description:
        "Required for replicate/openai/stability. Get a Replicate token at replicate.com/account/api-tokens, or an OpenAI key at platform.openai.com/api-keys. Create a paperclip secret first; never paste the raw key here. Leave blank for kind=local.",
    },
    endpointUrl: {
      type: "string",
      title: "Endpoint URL (kind=local only)",
      description:
        "When kind=local, the URL of a self-hosted image API (e.g. ComfyUI's /api/prompt or Automatic1111's /sdapi/v1/txt2img). Ignored for the other kinds.",
    },
    defaultModel: {
      type: "string",
      title: "Default model",
      description:
        "Replicate: a model slug like 'stability-ai/sdxl' or 'black-forest-labs/flux-schnell'. OpenAI: 'dall-e-3' or 'gpt-image-1'. Override per call via the `model` parameter on image_generate.",
    },
    defaultParams: {
      type: "object",
      title: "Default model params",
      description:
        "Provider-specific defaults applied to every image_generate call (e.g. { steps: 25, guidance: 7.5 }). Per-call params override these.",
      additionalProperties: true,
    },
    allowedCompanies: {
      type: "array",
      items: { type: "string", format: "company-id" },
      title: "Allowed companies",
      description:
        "Companies whose agents may call image-tools against this provider. Local tools also enforce this — `image_compose` requires a configured provider with the calling company allow-listed. Use [\"*\"] for shared keys (cost is attributed per call via telemetry). Empty = unusable.",
    },
  },
} as const;

const SETUP_INSTRUCTIONS = `# Setup — Image Tools

Connect an image generation provider so agents can generate, edit, compose, and resize images. Local composition tools (compose, resize, upscale) work without an API key; generation tools require a provider. Reckon on **about 5 minutes** for provider setup.

---

## Choosing a provider

| Provider | Best for | Cost | Models |
|---|---|---|---|
| **Replicate** (recommended) | Wide model selection, pay-per-run | ~$0.003–0.05/image | FLUX, SDXL, Stable Diffusion, etc. |
| **OpenAI** | DALL-E 3 / gpt-image-1, familiar billing | ~$0.04–0.12/image | dall-e-3, gpt-image-1 |

---

## Replicate setup

### 1. Get a Replicate API token

- Sign up / log in at [https://replicate.com](https://replicate.com)
- Go to [https://replicate.com/account/api-tokens](https://replicate.com/account/api-tokens)
- Click **Create token** — name it "Paperclip"
- **Copy the token**

### 2. Create a Paperclip secret

In Paperclip, switch to the company that should use this provider.

- Go to **Secrets → Add**
- Name it \`replicate-api-token\`
- Paste the token as the value
- Save, then **copy the secret's UUID**

### 3. Configure the provider (this page, **Configuration** tab)

Click the **Configuration** tab above. Under **Image providers**, click **+ Add item** and fill in:

| Field | Value |
|---|---|
| **Identifier** | e.g. \`replicate-main\` |
| **Provider kind** | \`replicate\` |
| **API key** | UUID of the secret from step 2 |
| **Default model** | e.g. \`black-forest-labs/flux-schnell\` (fast) or \`stability-ai/sdxl\` |
| **Allowed companies** | tick the companies whose agents may use this provider |

Set **Default provider key** at the top.

---

## OpenAI setup

### 1. Get an OpenAI API key

- Go to [https://platform.openai.com/api-keys](https://platform.openai.com/api-keys)
- Click **+ Create new secret key** — name it "Paperclip"
- **Copy the key**

### 2. Create a Paperclip secret and configure

Same steps as Replicate above — name the secret \`openai-api-key\`, set **Provider kind** to \`openai\`, and set **Default model** to \`dall-e-3\` or \`gpt-image-1\`.

---

## Local tools (no provider needed)

\`image_compose\`, \`image_resize\`, and \`image_upscale\` run locally using sharp. They still require at least one provider entry to exist for company-isolation enforcement — create a provider entry with any company-appropriate \`allowedCompanies\` list, even if you're not using generation.

---

## Enabling generation

**Allow generative tools** defaults to OFF (cost gate). Flip it ON only after you've reviewed which agents/skills will call \`image_generate\` or \`image_edit\` and are comfortable with the per-image API cost.

---

## Troubleshooting

- **\`[EALLOWED_COMPANIES]\`** — the calling company isn't in the provider's Allowed companies list.
- **Replicate model not found** — model slugs must be exact (e.g. \`black-forest-labs/flux-schnell\`, not \`flux-schnell\`). Check the model page on replicate.com for the correct slug.
- **OpenAI content policy refusal** — DALL-E 3 / gpt-image-1 enforce content policies. Revise the prompt.
- **Generation disabled** — the \`allowGeneration\` switch is OFF. Flip it on in the Configuration tab.
`;

const manifest: PaperclipPluginManifestV1 & { setupInstructions?: string } = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Image Tools",
  setupInstructions: SETUP_INSTRUCTIONS,
  description:
    "Generate, compose, resize, and upscale images. Local jimp-based composition + provider-pluggable generation (Replicate / OpenAI). Multi-provider, per-provider allowedCompanies, generation gated by a cost switch.",
  author: "Barry Carr & Tony Allard",
  categories: ["automation", "connector"],
  capabilities: [
    "agent.tools.register",
    "instance.settings.register",
    "secrets.read-ref",
    "http.outbound",
    "telemetry.track",
    "plugin.state.read",
    "plugin.state.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    propertyOrder: ["allowGeneration", "defaultProvider", "providers"],
    properties: {
      allowGeneration: {
        type: "boolean",
        title: "Allow generative tools (cost gate)",
        description:
          "Master switch for image_generate and image_edit (which call paid APIs). Set false (default) so the plugin only does local composition until you've reviewed costs. image_compose / image_resize / image_upscale (local) are unaffected.",
        default: false,
      },
      defaultProvider: {
        type: "string",
        title: "Default provider key",
        "x-paperclip-optionsFromSibling": {
          sibling: "providers",
          valueKey: "key",
          labelKey: "displayName",
        },
        description:
          "Identifier of the provider used when an agent omits `provider`. Strict: if the calling company isn't in the default provider's Allowed companies, the call fails with [ECOMPANY_NOT_ALLOWED].",
      },
      providers: {
        type: "array",
        title: "Image providers",
        description:
          "One entry per image-generation provider. Most operators have one Replicate token they share across LLCs. Local tools use the resolved provider for company-isolation but don't hit its API.",
        items: providerItemSchema,
      },
    },
  },
  tools: [
    {
      name: "image_generate",
      displayName: "Generate image",
      description:
        "Generate an image from a text prompt via the configured provider. Saves PNG(s) under ~/.paperclip/instances/default/data/storage/image-tools/<run-id>/ and returns local file paths. Gated by allowGeneration.",
      parametersSchema: {
        type: "object",
        properties: {
          provider: { type: "string", description: "Provider identifier. Optional — falls back to defaultProvider." },
          prompt: { type: "string" },
          negativePrompt: { type: "string", description: "Things to avoid (Stable Diffusion only)." },
          width: { type: "number", description: "Output width in pixels. Default 1024." },
          height: { type: "number", description: "Output height in pixels. Default 1024." },
          model: { type: "string", description: "Override the provider's defaultModel." },
          seed: { type: "number" },
          count: { type: "number", description: "Number of images. Default 1, max 4." },
          extraParams: {
            type: "object",
            description: "Provider-specific params merged with defaultParams.",
            additionalProperties: true,
          },
        },
        required: ["prompt"],
      },
    },
    {
      name: "image_edit",
      displayName: "Edit / vary image",
      description:
        "Edit an existing image via inpaint / outpaint / variation. Provider-dependent. Gated by allowGeneration.",
      parametersSchema: {
        type: "object",
        properties: {
          provider: { type: "string" },
          inputPath: { type: "string", description: "Local file path of the source image." },
          prompt: { type: "string" },
          maskPath: {
            type: "string",
            description:
              "Optional path to a mask PNG (white = inpaint, black = keep). Provider-dependent.",
          },
          width: { type: "number" },
          height: { type: "number" },
          model: { type: "string" },
        },
        required: ["inputPath", "prompt"],
      },
    },
    {
      name: "image_upscale",
      displayName: "Upscale image",
      description:
        "Upscale an image locally via sharp's lanczos resize. Fast, free, but not as sharp as a model-based upscaler. For high-quality upscale, configure a provider model and call image_generate with that model.",
      parametersSchema: {
        type: "object",
        properties: {
          provider: { type: "string" },
          inputPath: { type: "string" },
          scale: { type: "number", enum: [2, 3, 4], default: 2 },
          outputPath: { type: "string", description: "Optional. Defaults to <input>-<scale>x.png in run storage." },
        },
        required: ["inputPath"],
      },
    },
    {
      name: "image_resize",
      displayName: "Resize image",
      description: "Resize / crop an image with sharp. Fit modes: cover / contain / fill / inside / outside.",
      parametersSchema: {
        type: "object",
        properties: {
          provider: { type: "string" },
          inputPath: { type: "string" },
          width: { type: "number" },
          height: { type: "number" },
          fit: {
            type: "string",
            enum: ["cover", "contain", "fill", "inside", "outside"],
            default: "cover",
          },
          outputPath: { type: "string" },
        },
        required: ["inputPath"],
      },
    },
    {
      name: "image_compose",
      displayName: "Compose image",
      description:
        "Compose a new image from layers — solid background OR a base image, plus image and text overlays. Workhorse for thumbnails, social posts, book covers. Pure local (sharp + SVG-rendered text). No external API.",
      parametersSchema: {
        type: "object",
        properties: {
          provider: { type: "string" },
          outputPath: { type: "string", description: "Optional output PNG path. Defaults to run storage." },
          width: { type: "number" },
          height: { type: "number" },
          background: {
            description:
              "Background — either a CSS hex color string ('#ff0000') or a path to an existing image (used as the base layer).",
            oneOf: [{ type: "string" }],
          },
          layers: {
            type: "array",
            description: "Stack of layers, drawn bottom-to-top.",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["image", "text"] },
                path: { type: "string", description: "For type=image: local file path of the layer." },
                text: { type: "string", description: "For type=text: the text to render." },
                x: { type: "number", description: "Top-left x in pixels." },
                y: { type: "number", description: "Top-left y in pixels." },
                w: { type: "number", description: "Optional width (image: resize to this; text: wrap box)." },
                h: { type: "number", description: "Optional height." },
                font: {
                  type: "string",
                  description: "Font family (e.g. 'Inter'). Bundled fonts: Inter, Bebas Neue, Montserrat, Playfair Display. Add custom fonts via OS install.",
                },
                color: { type: "string", description: "CSS color for text. Default #000." },
                size: { type: "number", description: "Text size in pixels. Default 48." },
                weight: {
                  type: "number",
                  description: "Text font-weight (100-900). Default 600.",
                },
                align: {
                  type: "string",
                  enum: ["left", "center", "right"],
                  description: "Text alignment within its box. Default left.",
                },
              },
              required: ["type"],
            },
          },
        },
        required: ["width", "height", "layers"],
      },
    },
  ],
};

export default manifest;
