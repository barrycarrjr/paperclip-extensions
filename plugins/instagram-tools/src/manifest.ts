import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "instagram-tools";
const PLUGIN_VERSION = "0.1.0";

const accountItemSchema = {
  type: "object",
  required: ["key", "accessTokenRef", "igUserId", "allowedCompanies"],
  propertyOrder: ["key", "displayName", "accessTokenRef", "igUserId", "fbPageId", "allowedCompanies"],
  properties: {
    key: {
      type: "string",
      title: "Identifier",
      description: "Short stable ID agents pass when calling Instagram tools (e.g. 'main', 'bookzeta'). Lowercase, no spaces.",
    },
    displayName: { type: "string", title: "Display name", description: "Human-readable label (e.g. 'BookZeta Instagram')." },
    accessTokenRef: {
      type: "string",
      format: "secret-ref",
      title: "Long-lived access token",
      description: "UUID of the secret holding the long-lived Instagram Graph API access token. Obtain via Facebook Developer portal: App → Instagram Basic Display or Instagram Graph API → generate long-lived token. Store as a secret and paste the UUID here.",
    },
    igUserId: {
      type: "string",
      title: "Instagram user ID",
      description: "Numeric Instagram Business/Creator account ID. Found in the Graph API Explorer: GET /me?fields=id,username.",
    },
    fbPageId: {
      type: "string",
      title: "Facebook Page ID (optional)",
      description: "The Facebook Page linked to this Instagram account. Required only for certain API features.",
    },
    allowedCompanies: {
      type: "array",
      items: { type: "string", format: "company-id" },
      title: "Allowed companies",
      description: "Companies whose agents may post to this Instagram account.",
    },
  },
} as const;

const SETUP_INSTRUCTIONS = `# Setup — Instagram Tools

Post photos, carousels, reels, and stories to Instagram via the Instagram Graph API. Multi-account with per-account company isolation.

---

## 1. Set up a Facebook App with Instagram Graph API

1. Go to [developers.facebook.com](https://developers.facebook.com/) → **My Apps** → **Create App**.
2. Select **Business** type.
3. Add the **Instagram Graph API** product.
4. Your Instagram account must be a **Business** or **Creator** account (not Personal).
5. Link your Instagram account to a Facebook Page.

---

## 2. Generate a long-lived access token

1. In the Facebook App Dashboard, go to **Instagram Graph API** → **Generate Token**.
2. Select your Instagram account and approve permissions.
3. The short-lived token (1 hour) can be exchanged for a long-lived token (60 days):

\`\`\`
GET https://graph.facebook.com/v21.0/oauth/access_token
  ?grant_type=fb_exchange_token
  &client_id=YOUR_APP_ID
  &client_secret=YOUR_APP_SECRET
  &fb_exchange_token=SHORT_LIVED_TOKEN
\`\`\`

4. **Important:** Long-lived tokens expire after 60 days. Set a routine to refresh them before expiry.

---

## 3. Find your Instagram User ID

\`\`\`
GET https://graph.facebook.com/v21.0/me?fields=id,username&access_token=TOKEN
\`\`\`

The \`id\` field is your Instagram User ID.

---

## 4. Store credentials as Paperclip secrets

- \`INSTAGRAM_ACCESS_TOKEN\` — the long-lived access token

Copy the secret UUID.

---

## 5. Configure the plugin (Configuration tab)

Add one entry per Instagram account under **Accounts**:

| Field | Value |
|---|---|
| **Identifier** | \`main\` |
| **Display name** | e.g. "BookZeta Instagram" |
| **Access token** | paste the secret UUID |
| **Instagram user ID** | numeric ID from step 3 |
| **Allowed companies** | tick the relevant company |

---

## Content requirements

- **Photos:** JPEG, min 320px, max 1440px wide. Square (1:1), landscape (1.91:1), or portrait (4:5).
- **Carousels:** 2–10 images or videos.
- **Reels:** MP4, H.264, AAC audio, 3–90 seconds, max 1GB.
- **Stories:** Photo or video, 9:16 aspect ratio recommended.

## Media hosting requirement

The Instagram Graph API requires media to be hosted at a **public URL** — it cannot accept local file uploads directly. Use the companion \`s3-tools\` plugin to upload media to S3 first, generate a presigned URL, then pass that URL to the Instagram posting tools.
`;

const manifest: PaperclipPluginManifestV1 & { setupInstructions?: string } = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Instagram Tools",
  setupInstructions: SETUP_INSTRUCTIONS,
  description:
    "Post photos, carousels, reels, and stories to Instagram via the Graph API. Multi-account, per-account company isolation. Media must be hosted at a public URL (use s3-tools to upload first).",
  author: "BookZeta",
  categories: ["automation"],
  capabilities: [
    "agent.tools.register",
    "instance.settings.register",
    "secrets.read-ref",
    "http.outbound",
    "telemetry.track",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    propertyOrder: ["defaultAccount", "accounts"],
    properties: {
      defaultAccount: {
        type: "string",
        title: "Default account key",
        description: "Account used when agent omits the `account` parameter.",
      },
      accounts: {
        type: "array",
        title: "Instagram accounts",
        description: "One entry per Instagram Business/Creator account.",
        items: accountItemSchema,
      },
    },
  },
  tools: [
    {
      name: "instagram_post_photo",
      displayName: "Post Instagram photo",
      description:
        "Publish a single photo to Instagram. The image must be at a public URL (use s3-tools:s3_presign to generate one). Returns the media ID and permalink.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Falls back to default." },
          imageUrl: { type: "string", description: "Public URL of the image (JPEG). Required." },
          caption: { type: "string", description: "Post caption (max 2200 chars). Hashtags and @mentions supported." },
          locationId: { type: "string", description: "Facebook Place ID for location tagging (optional)." },
          userTags: {
            type: "array",
            items: {
              type: "object",
              properties: {
                username: { type: "string" },
                x: { type: "number", description: "0.0–1.0 horizontal position" },
                y: { type: "number", description: "0.0–1.0 vertical position" },
              },
            },
            description: "Tag users in the photo at specific positions.",
          },
        },
        required: ["imageUrl"],
      },
    },
    {
      name: "instagram_post_carousel",
      displayName: "Post Instagram carousel",
      description:
        "Publish a carousel (2–10 images/videos) to Instagram. Each item must be at a public URL. Creates child containers, then publishes the carousel.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string" },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                mediaUrl: { type: "string", description: "Public URL of the image or video." },
                mediaType: { type: "string", description: "'IMAGE' or 'VIDEO'. Default 'IMAGE'." },
              },
              required: ["mediaUrl"],
            },
            description: "2–10 media items for the carousel.",
          },
          caption: { type: "string" },
          locationId: { type: "string" },
        },
        required: ["items"],
      },
    },
    {
      name: "instagram_post_reel",
      displayName: "Post Instagram reel",
      description:
        "Publish a reel (short video) to Instagram. Video must be MP4, H.264, AAC, 3–90 seconds, at a public URL.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string" },
          videoUrl: { type: "string", description: "Public URL of the video (MP4)." },
          caption: { type: "string" },
          coverUrl: { type: "string", description: "Public URL of a cover image (optional)." },
          shareToFeed: { type: "boolean", description: "Also show in the main feed. Default true." },
          locationId: { type: "string" },
        },
        required: ["videoUrl"],
      },
    },
    {
      name: "instagram_post_story",
      displayName: "Post Instagram story",
      description:
        "Publish a story (photo or video) to Instagram. Stories disappear after 24 hours.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string" },
          mediaUrl: { type: "string", description: "Public URL of the photo or video." },
          mediaType: { type: "string", description: "'IMAGE' or 'VIDEO'. Default 'IMAGE'." },
        },
        required: ["mediaUrl"],
      },
    },
    {
      name: "instagram_get_media",
      displayName: "Get Instagram media info",
      description: "Retrieve metadata for a published media item by ID.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string" },
          mediaId: { type: "string", description: "Instagram media ID." },
        },
        required: ["mediaId"],
      },
    },
    {
      name: "instagram_list_media",
      displayName: "List recent Instagram posts",
      description: "List recent media from the account. Returns ID, type, caption, permalink, timestamp.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string" },
          limit: { type: "number", description: "Max posts to return. Default 25, max 100." },
        },
      },
    },
  ],
};

export default manifest;
