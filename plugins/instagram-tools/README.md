# instagram-tools

Paperclip plugin that exposes Instagram posting operations as agent tools via the Instagram Graph API. Supports photos, carousels, reels, and stories with multi-account company isolation.

## Tools

| Tool | Description |
|---|---|
| `instagram_post_photo` | Post a single photo |
| `instagram_post_carousel` | Post a carousel (2–10 items) |
| `instagram_post_reel` | Post a reel (short video) |
| `instagram_post_story` | Post a story (24h expiry) |
| `instagram_get_media` | Get metadata for a published post |
| `instagram_list_media` | List recent posts from the account |

## Important: Media hosting

The Instagram Graph API **cannot accept local file uploads**. Media must be at a public URL. Use the companion `s3-tools` plugin:

1. `s3-tools:s3_upload` — upload image/video to S3
2. `s3-tools:s3_presign` — generate a presigned URL
3. Pass the URL to any `instagram_post_*` tool

## Setup

1. Create a Facebook App with Instagram Graph API product
2. Instagram account must be Business or Creator (not Personal)
3. Generate a long-lived access token (60 day expiry)
4. Store as Paperclip secret: `INSTAGRAM_ACCESS_TOKEN`
5. Configure on `/instance/settings/plugins/instagram-tools`

## Build

```bash
pnpm install
pnpm build
```

## Companion skill

`instagram-poster` — teaches agents the posting workflow with S3 integration.
