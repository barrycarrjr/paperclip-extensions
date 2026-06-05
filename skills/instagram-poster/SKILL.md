---
name: instagram-poster
description: >
  Post photos, carousels, reels, and stories to Instagram using the
  instagram-tools plugin. Supports multi-account posting, caption templates,
  hashtag management, and scheduled content workflows. Media must be hosted
  at a public URL — use the s3-tools plugin to upload and presign first.
  Always requires board approval before posting.
---

# Instagram Poster

Orchestrates Instagram content publishing using the `instagram-tools`
plugin. This skill teaches agents the posting workflow — the plugin
handles the Graph API calls, container creation, and media processing.

## Pre-requisites

- The `instagram-tools` plugin must be installed and `ready`.
- The Instagram account must be a **Business** or **Creator** account.
- Media must be hosted at a public URL. Use `s3-tools:s3_upload` +
  `s3-tools:s3_presign` to make local files accessible.

## Content Types

| Type | Tool | Notes |
|---|---|---|
| Single photo | `instagram_post_photo` | JPEG, min 320px, max 1440px wide |
| Carousel | `instagram_post_carousel` | 2–10 images/videos |
| Reel | `instagram_post_reel` | MP4, 3–90 sec, H.264 + AAC |
| Story | `instagram_post_story` | Photo or video, disappears after 24h |

## Workflow

### 1. Prepare media

If media is local, upload to S3 and generate a presigned URL:

```json
{ "tool": "s3-tools:s3_upload", "parameters": {
    "localPath": "./social/post-image.jpg", "bucket": "assets", "s3Prefix": "instagram/"
} }
```

```json
{ "tool": "s3-tools:s3_presign", "parameters": {
    "bucket": "assets", "s3Key": "instagram/post-image.jpg", "expiresIn": 3600
} }
```

### 2. Request board approval

```
Ready to post to Instagram (account: bookzeta):
- Type: Photo
- Caption: "Check out our latest release! 📚 #BookZeta #NewRelease"
- Image: post-image.jpg
- User tags: none
- Location: none

Approve to proceed.
```

### 3. Post

**Single photo:**
```json
{ "tool": "instagram-tools:instagram_post_photo", "parameters": {
    "imageUrl": "https://s3.amazonaws.com/...",
    "caption": "Check out our latest release! 📚 #BookZeta #NewRelease"
} }
```

**Carousel:**
```json
{ "tool": "instagram-tools:instagram_post_carousel", "parameters": {
    "items": [
      { "mediaUrl": "https://s3.amazonaws.com/.../img1.jpg" },
      { "mediaUrl": "https://s3.amazonaws.com/.../img2.jpg" },
      { "mediaUrl": "https://s3.amazonaws.com/.../img3.jpg" }
    ],
    "caption": "Swipe through our top picks! 👉"
} }
```

**Reel:**
```json
{ "tool": "instagram-tools:instagram_post_reel", "parameters": {
    "videoUrl": "https://s3.amazonaws.com/.../reel.mp4",
    "caption": "Behind the scenes 🎬",
    "shareToFeed": true
} }
```

**Story:**
```json
{ "tool": "instagram-tools:instagram_post_story", "parameters": {
    "mediaUrl": "https://s3.amazonaws.com/.../story.jpg",
    "mediaType": "IMAGE"
} }
```

### 4. Report

```
Instagram Poster — <timestamp>
- Account: bookzeta
- Posts created: 2
  ✅ Photo → https://www.instagram.com/p/xxxxx/
  ✅ Reel → https://www.instagram.com/reel/yyyyy/
```

## Caption best practices

- Max 2200 characters.
- Put hashtags at the end or in first comment.
- Use line breaks for readability.
- Include a CTA (call to action).
- @mention relevant accounts.
- Never use AI-tells or excessive enthusiasm.

## Checking past posts

```json
{ "tool": "instagram-tools:instagram_list_media", "parameters": { "limit": 10 } }
```

```json
{ "tool": "instagram-tools:instagram_get_media", "parameters": { "mediaId": "<id>" } }
```

## Errors

- **Token expired** → Long-lived tokens last 60 days. Report and ask
  the board to refresh via the Facebook Developer portal.
- **Media processing failed** → Instagram rejected the media (wrong
  format, too small, codec issue). Check requirements above.
- **Rate limit** → Instagram limits API calls. Back off and retry next run.
- **Account not Business/Creator** → Cannot use Graph API. Must convert.
