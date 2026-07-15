---
name: youtube-publisher
description: >
  Upload and publish videos to YouTube using the youtube-tools plugin.
  Auto-discovers category folders (any subfolder with a not_posted/ folder) in
  the configured base, posting Shorts vs regular videos by category, writes a
  fitting title/description/tags for each clip from its filename plus the brand
  context docs, uploads via the YouTube Data API, then moves posted files to
  posted/. Project-agnostic. Always requires board approval.
---

# YouTube Publisher

Orchestrates the YouTube publishing workflow using the `youtube-tools`
plugin. The plugin handles OAuth2, the folder scan, uploads, and file moves.
This skill teaches the agent how to turn each raw clip into a good post.

## Pre-requisites

The `youtube-tools` plugin must be installed and `ready` in Paperclip, with a
configured account whose **Video source folder** points at the videos base
(e.g. `H:\projects\bookzeta\videos`).

## Folder model

The agent never hardcodes paths or category names — the plugin auto-discovers
them. Any subfolder of the base that contains a `not_posted/` folder is a
category; its name decides the type (matches `short` → Short, else a regular
video). This works for any project, not just one layout.

```
<videoSourceFolder>/
├── <context>.md / .txt        ← brand/context docs: read to write metadata
├── stories/not_posted/*.mp4   ← regular videos
├── shorts/not_posted/*.mp4    ← Shorts
├── howtoguides/not_posted/... ← auto-picked-up as regular videos
├── <category>/posted/         ← files land here after upload
└── <category>/<cat>_post.txt  ← optional caption template (may be spintax)
```

## Workflow

### 1. Scan for unposted videos

```json
{ "tool": "youtube-tools:youtube_list_pending", "parameters": {} }
```

Returns:
- `categories` — the category folders it found (e.g. `stories`, `shorts`,
  `howtoguides`).
- `videos[]` — one per file, each with `type` (`video` or `short`),
  `category`, `filePath`, `fileName`, and `subjectHint` (the filename
  cleaned into words).
- `contextDocs` — map of doc name → text (brand/context `*.md`/`*.txt` and
  any per-category `*_post.txt` template).
- `maxUploadsPerRun` — the per-run cap from plugin config.

**Respect the cap:** process at most `maxUploadsPerRun` entries from
`videos[]` this run (the rest stay in `not_posted/` for the next run). When
mixing types, spread across categories rather than draining one. How *often*
this skill runs (and thus daily volume) is set by its routine schedule.

### 2. Craft metadata for the clip

Read the context docs in `contextDocs` (whatever brand/explainer docs are
present — e.g. a `What_is_*.md`) to understand the product, voice, and what's
worth saying. Then, using the clip's `subjectHint` (which says what the video
is about — e.g. "BookZeta ai ad accessibility" → an ad about the
accessibility feature) and its `category`, write:

- **title** — ≤100 chars, specific to this clip, compelling, on-brand.
- **description** — a few lines that make sense for *this* video, grounded in
  the context doc. For Shorts, end with relevant hashtags. If a
  `shorts_post.txt` template exists, treat it as a base: spin/vary it and
  tailor it to this specific clip — never paste it verbatim across Shorts.
- **tags** — 5–12 relevant keywords.

Every title/description must be unique per video — do not reuse text.

### 3. Request board approval

```
Ready to upload to YouTube (BookZeta AI):
- [SHORT] "title…"  ← from shorts/not_posted/<file>
  desc: <first line…>
- [VIDEO] "title…"  ← from stories/not_posted/<file>
  desc: <first line…>

Approve to proceed.
```

Wait for approval before uploading.

### 4. Upload

`type: "short"` → `short: true`; `type: "video"` → `short: false`.

```json
{ "tool": "youtube-tools:youtube_upload", "parameters": {
    "filePath": "<filePath from step 1>",
    "short": true,
    "title": "<crafted title>",
    "description": "<crafted description>",
    "tags": ["bookzeta", "..."],
    "privacy": "public"
} }
```

### 5. Post the pinned-style comment

After a successful upload, post the CTA comment as the channel. Use the
**Pinned Comment** section from the context docs (`What_is_BookZeta.md`, or a
`*_post.txt` "Pinned Comment:" block) — lightly tailor it to the clip.

```json
{ "tool": "youtube-tools:youtube_post_comment", "parameters": {
    "videoId": "<id>", "text": "<pinned-comment text from context docs>"
} }
```

⚠️ The YouTube API **cannot pin** comments — the comment posts as the
channel, but it must be pinned by hand in Studio. Include the returned
`studioUrl` in your receipt so the operator can pin it in one tap.

### 6. Move the posted file

On a successful upload (you get a `videoId`), move it out of the queue:

```json
{ "tool": "youtube-tools:youtube_mark_posted", "parameters": {
    "filePath": "<same filePath>"
} }
```

If the upload failed, leave the file in `not_posted/` so the next run retries.

### 7. Report

Comment on the issue, and list comments that still need pinning:

```
YouTube Publisher — <timestamp>
- Uploaded: 2 | Failed: 1
  ✅ [short] BookZeta.ai_ad_accessibility… → dQw4w9WgXcQ (public) · comment posted, pin: studio.youtube.com/video/dQw4w9WgXcQ/comments
  ✅ [video] BookZeta_AI_story_generation… → aBcDeFgHiJk (public) · comment posted, needs pin
  ❌ [short] BookZeta_promo_comic_scene… → quota exceeded (left in not_posted/)
```

## Scheduled publishing

Set `privacy: "private"` and `publishAt` (ISO 8601) to schedule.

## Quota

~6 uploads/day on default quota (1,600 units per upload, 10,000/day). If you
hit the cap, stop and leave the rest in `not_posted/` — it resets midnight PT.

## Errors

- **OAuth2 expired** → plugin auto-refreshes; if the refresh token is revoked, report.
- **Quota exceeded** → stop, leave remaining files in `not_posted/`.
- **Upload failed/timeout** → do not move the file; next run retries.
