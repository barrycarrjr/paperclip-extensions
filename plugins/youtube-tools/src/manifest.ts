import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 & { setupInstructions?: string } = {
  id: "youtube-tools",
  apiVersion: 1,
  version: "0.6.0",
  displayName: "YouTube Tools",
  setupInstructions: `# Setup — YouTube Tools

Upload videos, set thumbnails, manage playlists, and update metadata via the YouTube Data API v3.

---

## 1. Create OAuth2 credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Create a project (or use an existing one).
3. Enable **YouTube Data API v3**.
4. Go to **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**.
5. Application type: **Desktop app**.
6. Note the **Client ID** and **Client Secret**.

---

## 2. Obtain a refresh token

Run a one-time OAuth2 consent flow with these scopes:
- \`https://www.googleapis.com/auth/youtube.upload\`
- \`https://www.googleapis.com/auth/youtube\`
- \`https://www.googleapis.com/auth/youtube.force-ssl\`

Store the resulting **refresh token**.

---

## 3. Store credentials as Paperclip secrets

- \`YOUTUBE_CLIENT_ID\` — OAuth2 client ID
- \`YOUTUBE_CLIENT_SECRET\` — OAuth2 client secret
- \`YOUTUBE_REFRESH_TOKEN\` — Long-lived refresh token

---

## 4. Configure the plugin (Configuration tab)

Add one entry per YouTube channel/account under **Accounts**:
- **Client ID / Client secret / Refresh token** — pick the secrets from step 3.
- **Video source folder** — absolute path to the base videos folder (e.g.
  \`H:\\projects\\bookzeta\\videos\`). The plugin auto-discovers categories:
  **any subfolder containing a \`not_posted/\` folder** is treated as a
  publishing category. The category name decides the type — a name matching
  \`short\` becomes a YouTube Short, anything else a regular video.
  \`\`\`
  videos/
  ├── What_is_BookZeta.md         ← context doc (any *.md/*.txt in base)
  ├── stories/not_posted/*.mp4    ← regular videos
  ├── shorts/not_posted/*.mp4     ← Shorts (name matches /short/i)
  ├── howtoguides/not_posted/*.mp4← regular videos (auto-picked-up)
  ├── <category>/posted/          ← (auto-created) files move here after upload
  └── <category>/<cat>_post.txt   ← optional per-category caption template
  \`\`\`
  Just drop bare video files into any \`not_posted/\` folder. Agents use
  \`youtube_list_pending\` to discover them (filename → subject + context
  docs) and \`youtube_mark_posted\` to move each one to \`posted/\` after a
  successful upload. Drop the same folder onto any other project — no config
  beyond this path.
- **Allowed companies** — restrict which companies may use this account.

**Shorts:** a Short is just a regular upload of a vertical video ≤3 min — set
\`short: true\` (or add \`"short": true\` to metadata.json) to ensure #Shorts is
in the description. No separate API.

**Daily quota:** YouTube Data API allows ~10,000 units/day. Each upload costs 1,600 units (~6 uploads/day).
`,
  description:
    "Upload videos, set thumbnails, manage playlists, and update metadata on YouTube. Uses YouTube Data API v3 with OAuth2.",
  author: "BookZeta",
  categories: ["automation"],
  capabilities: [
    "agent.tools.register",
    "instance.settings.register",
    "secrets.read-ref",
    "http.outbound",
    "telemetry.track",
  ],
  entrypoints: { worker: "./dist/worker.js" },
  instanceConfigSchema: {
    type: "object",
    propertyOrder: ["defaultAccount", "accounts"],
    properties: {
      defaultAccount: { type: "string", title: "Default account key" },
      accounts: {
        type: "array",
        title: "YouTube accounts",
        items: {
          type: "object",
          required: ["key", "clientIdRef", "clientSecretRef", "refreshTokenRef", "allowedCompanies"],
          propertyOrder: ["key", "displayName", "clientIdRef", "clientSecretRef", "refreshTokenRef", "videoSourceFolder", "maxUploadsPerRun", "channelId", "defaultPrivacy", "allowedCompanies"],
          properties: {
            key: { type: "string", title: "Identifier" },
            displayName: { type: "string", title: "Display name" },
            clientIdRef: { type: "string", format: "secret-ref", title: "Client ID" },
            clientSecretRef: { type: "string", format: "secret-ref", title: "Client secret" },
            refreshTokenRef: { type: "string", format: "secret-ref", title: "Refresh token" },
            videoSourceFolder: { type: "string", title: "Video source folder", description: "Absolute path to the base videos folder (e.g. H:\\projects\\bookzeta\\videos). Any subfolder containing a not_posted/ folder is auto-discovered as a category; its name decides type (matches /short/i → Short, otherwise a regular video). Drop bare video files into each not_posted/. Context docs (*.md/*.txt in the base, *_post.txt per category) guide metadata. Posted files move to the sibling posted/ folder." },
            maxUploadsPerRun: { type: "number", title: "Max uploads per run", description: "How many videos the publisher uploads in a single run. Cadence (how often it runs) is controlled separately by a routine schedule, so daily volume = this × runs per day. YouTube allows ~6 uploads/day on default quota. Default: 5." },
            channelId: { type: "string", title: "Channel ID", description: "Required only if account has multiple channels." },
            defaultPrivacy: { type: "string", title: "Default privacy", description: "'private', 'unlisted', or 'public'. Default: private." },
            allowedCompanies: { type: "array", items: { type: "string", format: "company-id" }, title: "Allowed companies" },
          },
        },
      },
    },
  },
  tools: [
    {
      name: "youtube_list_pending",
      displayName: "List unposted YouTube videos",
      description: "Auto-discover every category under the account's video source folder (any subfolder with a not_posted/ folder) and list the bare video files in each. Each item is tagged type=video|short (inferred from the category name) with its category and a subjectHint derived from the filename, plus contextDocs (base *.md/*.txt and per-category *_post.txt) the agent reads to write the title/description/tags for each clip. Works for any project's folder, not just one layout.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Falls back to default." },
        },
      },
    },
    {
      name: "youtube_mark_posted",
      displayName: "Move a posted video to posted/",
      description: "After a successful upload, move the video file from its not_posted/ folder to the sibling posted/ folder so it won't be posted again. Pass the same filePath returned by youtube_list_pending.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Falls back to default." },
          filePath: { type: "string", description: "Absolute path to the video file under a not_posted/ folder (as returned by youtube_list_pending)." },
        },
        required: ["filePath"],
      },
    },
    {
      name: "youtube_upload",
      displayName: "Upload YouTube video",
      description: "Upload a video file to YouTube with metadata. Uses resumable upload. Returns videoId and URL. Set short=true for a YouTube Short (vertical, ≤3min — ensures #Shorts is in the description).",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Falls back to default." },
          filePath: { type: "string", description: "Path to the video file. Absolute, or relative to the account's videoSourceFolder." },
          short: { type: "boolean", description: "Mark as a YouTube Short — appends #Shorts to the description if missing. Default false." },
          title: { type: "string", description: "Video title (max 100 chars)." },
          description: { type: "string", description: "Video description (max 5000 chars)." },
          tags: { type: "array", items: { type: "string" }, description: "Keywords for search." },
          categoryId: { type: "string", description: "YouTube category ID. Default '22' (People & Blogs)." },
          privacy: { type: "string", description: "'private', 'unlisted', or 'public'." },
          publishAt: { type: "string", description: "ISO 8601 datetime for scheduled publish." },
          madeForKids: { type: "boolean", description: "COPPA flag. Default false." },
          language: { type: "string", description: "ISO 639-1 language code." },
          notifySubscribers: { type: "boolean", description: "Notify subscribers. Default true." },
        },
        required: ["filePath", "title", "description"],
      },
    },
    {
      name: "youtube_post_comment",
      displayName: "Post a comment on a YouTube video",
      description: "Post a top-level comment on a video AS the channel (uses the CTA/pinned-comment text from the context docs). NOTE: the YouTube API cannot PIN a comment — pinning is UI-only, so the result includes a studioUrl reminder to pin it manually (one tap in Studio).",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Falls back to default." },
          videoId: { type: "string", description: "YouTube video ID to comment on." },
          text: { type: "string", description: "Comment body (e.g. the tailored pinned-comment text)." },
        },
        required: ["videoId", "text"],
      },
    },
    {
      name: "youtube_set_thumbnail",
      displayName: "Set YouTube thumbnail",
      description: "Upload a custom thumbnail for a video. Requires verified account. Image must be 1280×720, JPEG/PNG, under 2MB.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string" },
          videoId: { type: "string", description: "YouTube video ID." },
          filePath: { type: "string", description: "Local path to thumbnail image." },
        },
        required: ["videoId", "filePath"],
      },
    },
    {
      name: "youtube_add_to_playlist",
      displayName: "Add to YouTube playlist",
      description: "Add a video to a playlist.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string" },
          videoId: { type: "string" },
          playlistId: { type: "string" },
          position: { type: "number", description: "0-indexed position. Omit to append." },
        },
        required: ["videoId", "playlistId"],
      },
    },
    {
      name: "youtube_update_metadata",
      displayName: "Update YouTube video metadata",
      description: "Update title, description, tags, category, or privacy of an existing video.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string" },
          videoId: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          categoryId: { type: "string" },
          privacy: { type: "string" },
        },
        required: ["videoId"],
      },
    },
    {
      name: "youtube_get_video",
      displayName: "Get YouTube video info",
      description: "Retrieve metadata and processing status of a video by ID.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string" },
          videoId: { type: "string" },
        },
        required: ["videoId"],
      },
    },
  ],
};

export default manifest;
