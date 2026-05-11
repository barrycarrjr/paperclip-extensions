---
name: landing-page-creator
description: Generate a complete, styled landing page that mimics the design of an existing website. Accepts a reference URL to extract the brand's color palette, typography, spacing, and layout patterns, then produces a self-contained HTML/CSS file (or React/Next.js component) for the requested page goal. Use when an operator says "build a landing page for X", "create a signup page that matches our site", or "make a landing page like <url>".
---

# Landing Page Creator

Produces a complete landing page by extracting the design system of a
reference website and applying it to a new page layout. The output is
a self-contained, production-ready HTML file with embedded CSS (default),
or a React component if specified.

Two flows depending on inputs:

1. **Reference-URL flow** — fetch the existing site, extract the design
   system (colors, fonts, spacing, component patterns), then generate
   the new page in that visual language.
2. **Brand-spec flow** — caller provides explicit brand colors, fonts,
   and style notes when no reference URL is available.

If the `ui-ux-pro-max` Claude Code skill is available, invoke it for
design structure advice before generating code. If it is not available,
apply the built-in UX guidelines in the **Design Defaults** section below.

---

## When to invoke

- Operator says "create a landing page for [product/offer]".
- Operator says "build a page that looks like our main site".
- A marketing or content workflow needs a new conversion-focused page
  (signup, product launch, event registration, waitlist, etc.).
- Operator provides a reference URL and asks for a page that matches its
  visual style.

---

## Pre-conditions

- Agent has `WebFetch` (or `curl`) access to retrieve the reference URL.
- Agent has `Write` tool access to save output files.
- No external plugin is required for the core HTML/CSS output path.
- For React/Next.js output: the target project must be available to write
  files into.
- For hero image generation: `image-tools` plugin installed + `ready`
  (optional; skip if not present).

---

## Inputs the calling agent collects

Required:

| Field | Description |
|-------|-------------|
| `pageGoal` | What the page should accomplish. E.g. `"SaaS free trial signup"`, `"product launch"`, `"event registration"`, `"waitlist"`. |
| `outputPath` | Absolute or relative path where the file should be written. E.g. `/output/landing.html` or `pages/landing/index.tsx`. |

Optional:

| Field | Default | Description |
|-------|---------|-------------|
| `referenceUrl` | — | URL of the existing website to mimic. Fetched to extract design system. |
| `brand` | extracted or defaults | Object: `{ primaryColor, secondaryColor, accentColor, fontHeading, fontBody, tone }`. Overrides or supplements extraction. |
| `sections` | see defaults | Array of section names to include. See **Section Catalogue** below. |
| `ctaText` | `"Get Started"` | Primary call-to-action button label. |
| `ctaHref` | `"#"` | Primary CTA link target. |
| `headline` | agent-generated | Hero section H1 text. |
| `subheadline` | agent-generated | Hero section supporting copy. |
| `outputFormat` | `"html"` | `"html"` (single self-contained file) or `"react"` (TSX component using Tailwind). |
| `heroImagePath` | — | Path to an existing image for the hero background. If omitted and `image-tools` is installed, generate one. |

---

## Section Catalogue

Default sections (used when `sections` is not specified):
`["hero", "features", "social-proof", "cta-banner", "footer"]`

Available sections:

| Section | Description |
|---------|-------------|
| `hero` | Full-width opening section with headline, subheadline, and primary CTA. |
| `features` | 3-column or 2-column card grid highlighting key features/benefits. |
| `how-it-works` | Numbered step flow (2–4 steps). |
| `social-proof` | Testimonial cards or logo strip ("trusted by …"). |
| `pricing` | 2–3 tier pricing table. |
| `faq` | Accordion-style frequently asked questions. |
| `cta-banner` | Bold full-width conversion banner (repeat CTA near page bottom). |
| `footer` | Links, copyright, and optional newsletter signup. |

---

## Flow

### Step 1 — Extract design system from reference URL

If `referenceUrl` is provided:

```bash
# Fetch HTML of the reference site
HTML=$(curl -s --max-time 15 -A "Mozilla/5.0" "<referenceUrl>")

# Fetch linked CSS (if the agent can follow <link rel="stylesheet"> hrefs)
# Use WebFetch for each stylesheet URL found in <head>
```

From the fetched content, extract and record:

```
DESIGN_SYSTEM = {
  primaryColor:    # dominant brand color from CSS vars, buttons, or links (e.g. "#1a56db")
  secondaryColor:  # background or accent tone
  accentColor:     # CTA / highlight color
  fontHeading:     # from font-family on h1/h2, or Google Fonts @import
  fontBody:        # from body font-family
  borderRadius:    # from button/card styling (none / sm=4px / md=8px / lg=16px / pill)
  shadowStyle:     # none / soft / hard
  layoutWidth:     # max-width of content container (e.g. "1200px")
  navStyle:        # transparent / solid / bordered
  heroStyle:       # centered / split / full-bleed
  buttonStyle:     # filled / outlined / ghost
}
```

If CSS variables are present (e.g. `--color-primary`), prefer those.
If the site uses Tailwind, read the class names on key elements to infer
the scale.

When `referenceUrl` is absent, use the `brand` input directly, filling
any missing fields from the **Design Defaults** below.

### Step 2 — Apply ui-ux-pro-max (if available)

If the `ui-ux-pro-max` skill is installed, invoke it at this point:

```
/ui-ux-pro-max
Goal: landing page for <pageGoal>
Style: match extracted DESIGN_SYSTEM
Sections: <sections list>
Stack: <outputFormat>
```

Use its output to refine section structure, copy tone, and component
layout choices before generating code. If the skill is not available,
proceed directly to Step 3 using the built-in guidelines.

### Step 3 — Generate page copy (if not provided)

For any section included in `sections`, generate placeholder copy that
fits `pageGoal` and the brand `tone`. Rules:

- Headlines: concise, action-oriented, ≤ 10 words.
- Body copy: benefit-driven, ≤ 30 words per block.
- Do NOT include filler like "Lorem ipsum" — generate real, plausible
  content for the goal (e.g. for a SaaS free-trial page, write actual
  feature names and benefit statements).
- Match the tone extracted from the reference site if available (formal,
  conversational, technical, friendly, etc.).

### Step 4 — Build the hero image (optional)

If `heroImagePath` is not provided AND `image-tools` is installed:

```bash
curl -s -X POST "$PAPERCLIP_API_URL/api/plugins/tools/execute" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "tool": "image-tools:image_generate",
    "parameters": {
      "prompt": "Modern professional hero background for <pageGoal>, <primaryColor> tones, abstract, wide aspect ratio",
      "width": 1440,
      "height": 720,
      "count": 1
    },
    "runContext": { "companyId": "'$PAPERCLIP_COMPANY_ID'", "agentId": "'$PAPERCLIP_AGENT_ID'" }
  }'
```

If `image-tools` is not installed or returns `[EDISABLED]`, use a CSS
gradient hero instead (see **Design Defaults** for the gradient formula).

### Step 5 — Generate the landing page

#### HTML output (`outputFormat: "html"`)

Write a single `.html` file. Requirements:

- `<!DOCTYPE html>` with full `<head>` (meta charset, viewport, title,
  Open Graph tags).
- All CSS embedded in a `<style>` block — no external CDN dependencies
  except Google Fonts (one `@import` for heading + body fonts is fine).
- JavaScript only for interactive elements (accordion FAQ, smooth scroll,
  sticky nav). Inline `<script>` at end of `<body>`.
- Responsive: mobile-first, `min-width` breakpoints at 640 px and 1024 px.
- Accessible: semantic HTML5 elements (`<header>`, `<main>`, `<section>`,
  `<footer>`), `alt` text on all images, sufficient color contrast.
- No build step required — file must open correctly in a browser from disk.

Starter template skeleton:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>[Page Title]</title>
  <meta property="og:title" content="[Page Title]">
  <meta property="og:description" content="[Subheadline]">
  <style>
    /* CSS custom properties derived from DESIGN_SYSTEM */
    :root {
      --color-primary: [primaryColor];
      --color-secondary: [secondaryColor];
      --color-accent: [accentColor];
      --font-heading: '[fontHeading]', system-ui, sans-serif;
      --font-body: '[fontBody]', system-ui, sans-serif;
      --radius: [borderRadius];
      --max-width: [layoutWidth];
    }
    /* ... section styles ... */
  </style>
</head>
<body>
  <header>...</header>
  <main>
    <!-- sections in order -->
  </main>
  <footer>...</footer>
  <script>/* interactions */</script>
</body>
</html>
```

#### React/TSX output (`outputFormat: "react"`)

Write a single `.tsx` file as a default-exported page component using
Tailwind CSS utility classes. Requirements:

- Next.js 13+ App Router convention (no `getStaticProps`).
- Tailwind classes only — no inline `style` props except for truly
  dynamic values (e.g. a CSS custom property from a brand color).
- TypeScript: typed props interface at the top of the file.
- Import font via `next/font/google` at the top.

### Step 6 — Write the output file

```bash
# Write the generated content to outputPath using the Write tool
```

Confirm the file was written by reading the first 10 lines back.

### Step 7 — Report completion

Post a summary comment on the active Paperclip issue (if running in a
heartbeat context):

```
## Landing page created

- **Goal:** <pageGoal>
- **Design source:** <referenceUrl | "brand spec">
- **Sections:** <sections list>
- **Output:** `<outputPath>`
- **Format:** <html | react>
- **Hero:** <image path | CSS gradient>
```

---

## Design Defaults

Apply these when no reference URL and no `brand` input is available, or
to fill gaps in the extracted design system.

```
primaryColor:   #1a56db      (trust blue — good SaaS/B2B default)
secondaryColor: #f9fafb      (near-white background)
accentColor:    #ff6b35      (warm orange CTA)
fontHeading:    "Inter"
fontBody:       "Inter"
borderRadius:   8px
shadowStyle:    soft          → box-shadow: 0 4px 24px rgba(0,0,0,0.08)
layoutWidth:    1200px
navStyle:       solid
heroStyle:      centered
buttonStyle:    filled
```

CSS gradient fallback for hero (when no hero image):

```css
background: linear-gradient(135deg, var(--color-primary) 0%, color-mix(in srgb, var(--color-primary) 70%, #000) 100%);
```

---

## UX Guidelines (when ui-ux-pro-max is not available)

Apply these rules to every generated page:

1. **Single primary CTA per screen** — don't put two competing CTAs in
   the hero. Repeat the same CTA at the page bottom.
2. **Above-the-fold value prop** — headline + subheadline + CTA must be
   visible without scrolling on a 1024 px viewport.
3. **Visual hierarchy via size + weight** — H1 ≥ 48 px, H2 ≥ 32 px,
   body ≥ 16 px. Never rely on color alone.
4. **Whitespace over decoration** — generous padding (section padding ≥
   80 px top/bottom) is more professional than background patterns.
5. **Social proof placement** — testimonials or logos immediately after
   the hero reduce abandonment on first scroll.
6. **Contrast** — CTA button background must have ≥ 4.5:1 contrast with
   button text. Use a contrast checker formula or a known-safe pairing.
7. **Mobile nav** — desktop nav items collapse to a hamburger at < 768 px.
   Never hide the CTA button in mobile view.
8. **Loading speed** — no external JS frameworks (jQuery, Bootstrap) in
   the HTML output. Vanilla JS only.

---

## Errors

| Code | Cause | Action |
|------|-------|--------|
| `[EFETCH_FAILED]` | Reference URL unreachable or returns non-200. | Switch to brand-spec flow. Surface URL to operator. |
| `[EFETCH_TIMEOUT]` | Reference URL took > 15 s. | Retry once with a 30 s timeout. If it fails again, switch to brand-spec flow. |
| `[EDESIGN_SPARSE]` | Fetched HTML contains no usable CSS (heavy JS-rendered site). | Attempt to fetch `/static/css/`, `/assets/css/`, or `/_next/static/css/` paths. If still empty, ask operator for brand colors. |
| `[EIMAGE_DISABLED]` | `image-tools` present but generation is gated off. | Fall back to CSS gradient hero. Log the fallback in the completion comment. |
| `[EOUTPUT_PATH]` | `outputPath` parent directory does not exist. | Create the directory with `mkdir -p`, then write. |
| `[EFORMAT_UNKNOWN]` | `outputFormat` is not `html` or `react`. | Default to `html` and note the fallback. |

---

## Out of scope

- Multi-page websites — this skill creates a single landing page. For
  a full site, call this skill once per page.
- CMS integration (WordPress, Webflow, Contentful) — output is static
  code only; CMS wiring is out of scope.
- A/B testing setup — call this skill twice with different `headline`
  and `ctaText` values; wire A/B logic at the deployment layer.
- Analytics/tracking scripts — add pixel/GTM snippet after file is
  generated; don't build it into this skill.
- Deployment — this skill writes files only. Use a deployment workflow
  after calling this skill.

---

## See also

- [`../youtube-thumbnail-generator/SKILL.md`](../youtube-thumbnail-generator/SKILL.md) — for generating hero images via image-tools.
- `ui-ux-pro-max` Claude Code skill — richer design system guidance,
  50+ styles, 161 palettes, 57 font pairings.
