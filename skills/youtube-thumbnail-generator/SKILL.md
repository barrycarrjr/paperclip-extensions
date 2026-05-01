---
name: youtube-thumbnail-generator
description: Compose a YouTube thumbnail (1280×720) from a brief — typically a video title, an image-gen prompt for the background, and the channel's brand bar. Anchor use case for image-tools. Use when a video-prep skill needs a thumbnail, or when an operator says "make me a thumbnail for this video."
---

# YouTube Thumbnail Generator

Builds a 1280×720 PNG via `image-tools` and returns the file path.
Two flows depending on whether a brand template fits:

1. **Generative** — agent makes up a background via `image_generate`
   (Replicate/OpenAI), then composes it with a title overlay.
2. **Template** — caller provides a static background path; skill
   only does composition.

## When to invoke

- A video-prep skill (`video-publisher`, `short-publisher`, etc.)
  needs a thumbnail before upload.
- Operator says "make me a thumbnail" with a title and optional
  prompt for the background.

## Pre-conditions

- `image-tools` plugin installed + `ready`.
- At least one provider configured.
- For the generative flow: `allowGeneration=true` and a working
  Replicate or OpenAI provider.
- For the template flow: a path to an existing background image.
- Calling company in the provider's `allowedCompanies`.

## Inputs the calling agent collects

Required:
- `title` — short, max 5 words. Will be rendered at large size.

Optional:
- `subtitle` — secondary line.
- `bgPrompt` — text-to-image prompt if going generative.
- `bgPath` — local path if using a template.
- `accentColor` — CSS hex for the title text. Default `#ffffff`.
- `outputPath` — where to save. Default: run storage.

If both `bgPrompt` and `bgPath` are provided, prefer `bgPath` (cheap,
deterministic).

## Flow

### Generative flow

```bash
GEN=$(curl ... '{ tool: "image-tools:image_generate", parameters: {
  prompt: "<bgPrompt>",
  width: 1280, height: 720, count: 1
}, runContext: {...} }')

BG_PATH=$(jq -r '.result.data.images[0].path' <<< "$GEN")
```

If `image_generate` returns `[EDISABLED]` because cost-gate is off,
either fall back to the template flow OR surface to the operator and
stop. Don't retry.

### Composition (both flows)

```bash
THUMB=$(curl ... '{ tool: "image-tools:image_compose", parameters: {
  width: 1280,
  height: 720,
  background: "<BG_PATH>",
  layers: [
    {
      "type": "text",
      "text": "<title>",
      "x": 60,
      "y": 200,
      "w": 1100,
      "size": 128,
      "color": "<accentColor or #ffffff>",
      "align": "left"
    },
    {
      "type": "text",
      "text": "<subtitle>",
      "x": 60,
      "y": 460,
      "w": 1100,
      "size": 64,
      "color": "#cccccc"
    }
  ],
  outputPath: "<outputPath optional>"
}, runContext: {...} }')

OUT=$(jq -r '.result.data.outputPath' <<< "$THUMB")
echo "Thumbnail: $OUT"
```

### v0.1.0 font caveat

`image_compose` in image-tools v0.1.0 uses jimp's bitmap fonts —
sizes round to **16/32/64/128 px** and only black/white render
correctly. For high-fidelity branded text, render the title as a PNG
in your design tool and pass it as an `image` layer instead of a
`text` layer. (v0.2 will add a vector text renderer.)

## After composing

If the calling skill is going to upload to YouTube next, it has the
file path. Otherwise, attach the thumbnail to a paperclip issue and
surface the path in a comment:

```
Thumbnail composed.
- Title: <title>
- Source: <generative | template>
- Output: <path>
- Size: 1280×720
```

## Errors

- `[ECOMPANY_NOT_ALLOWED]` — provider's allow-list doesn't include
  this company. Surface.
- `[EDISABLED]` on `image_generate` — cost-gate off. Fall back to
  template flow OR surface.
- `[EREPLICATE_*]` / `[EOPENAI_*]` — provider failure. Read the message;
  often a quota/key issue. Surface.
- `[ECOMPOSE]` — sharp/jimp pipeline failed. Most common cause: bad
  hex color or missing background path.

## Pre-requisites

- `image-tools` installed + `ready`.
- At least one provider configured with the calling company in
  `allowedCompanies`.
- `allowGeneration=true` for the generative flow.

## Out of scope

- A/B testing multiple thumbnails — call this skill multiple times.
- Bulk thumbnail generation across a channel backlog — wrap this
  skill in a higher-level workflow skill.
- Animated thumbnails (GIFs) — needs a future video-tools plugin.
