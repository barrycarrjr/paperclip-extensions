# youtube-tools

Paperclip plugin that exposes YouTube upload, thumbnail, playlist, and metadata operations as agent tools via the YouTube Data API v3.

## Tools

| Tool | Description |
|---|---|
| `youtube_upload` | Upload a video with metadata (resumable) |
| `youtube_set_thumbnail` | Set a custom video thumbnail |
| `youtube_add_to_playlist` | Add a video to a playlist |
| `youtube_update_metadata` | Update title, description, tags, privacy |
| `youtube_get_video` | Get video info and processing status |

## Setup

1. Create OAuth2 credentials in Google Cloud Console
2. Enable YouTube Data API v3
3. Obtain a refresh token via OAuth2 consent flow
4. Store as Paperclip secrets: `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN`
5. Configure on `/instance/settings/plugins/youtube-tools`

## Build

```bash
pnpm install
pnpm build
```

## Companion skill

`youtube-publisher` — teaches agents the video publishing workflow.
