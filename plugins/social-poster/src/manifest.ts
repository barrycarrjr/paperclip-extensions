import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "social-poster";
const PLUGIN_VERSION = "0.3.9";

const SETUP_INSTRUCTIONS = `# Setup — Social Poster

Connect Facebook Pages, Instagram Business accounts, and/or X (Twitter) accounts so agents can post content. Each platform has its own credential setup. Reckon on **15–30 minutes** total depending on which platforms you connect.

**Important**: set **Allow publishing** to OFF (default) until you've verified everything works. When OFF, tool calls simulate posting and return the would-be payload without hitting any network.

---

## Facebook Pages

### 1. Create a Facebook App (if you don't have one)

- Go to [https://developers.facebook.com/apps](https://developers.facebook.com/apps) → **Create App**
- **Use case**: Business (allows Pages API)
- Add the **Facebook Login** and **Pages API** products

### 2. Get a long-lived Page Access Token

The easiest path is the Graph API Explorer:

- Go to [https://developers.facebook.com/tools/explorer](https://developers.facebook.com/tools/explorer)
- Select your app
- Click **Generate Access Token** → grant permissions: \`pages_manage_posts\`, \`pages_read_engagement\`, \`pages_show_list\`
- Exchange the short-lived token for a long-lived one:
  \`\`\`
  GET /oauth/access_token?grant_type=fb_exchange_token&client_id=<APP_ID>&client_secret=<APP_SECRET>&fb_exchange_token=<SHORT_LIVED_TOKEN>
  \`\`\`
- Then get the permanent Page token:
  \`\`\`
  GET /me/accounts?access_token=<LONG_LIVED_USER_TOKEN>
  \`\`\`
  Each entry in the response has a \`access_token\` — that's your Page Access Token. Page tokens don't expire as long as the user doesn't revoke them.

### 3. Find your Page ID

In the same \`/me/accounts\` response, each entry has an \`id\` — that's your Page ID. Or find it in Facebook page → **About → Page transparency**.

### 4. Create Paperclip secrets and configure

- Create a Paperclip secret with the Page Access Token; copy the UUID
- In the Configuration tab under **Facebook Pages**, add an entry:

| Field | Value |
|---|---|
| **Identifier** | e.g. \`brand-a-fb\` |
| **Page ID** | numeric Facebook Page ID |
| **Page Access Token** | UUID of the secret |
| **Brand variant** | \`standard\` or \`kids\` |
| **Allowed companies** | tick the owning company |

---

## Instagram Business accounts

Instagram Business requires a Facebook Page connected to the IG Business account. The access token is the same Page Access Token from above.

### 1. Get your Instagram Business Account ID

Call the Graph API:
\`\`\`
GET /<PAGE_ID>?fields=instagram_business_account&access_token=<PAGE_TOKEN>
\`\`\`
The response contains \`instagram_business_account.id\` — that's the numeric IG User ID.

### 2. Configure

In the Configuration tab under **Instagram Business accounts**, add an entry:

| Field | Value |
|---|---|
| **Identifier** | e.g. \`brand-a-ig\` |
| **Instagram User ID** | numeric IG Business Account ID |
| **Access Token** | UUID of the Facebook Page secret (same one as above) |
| **Brand variant** | \`standard\` or \`kids\` |
| **Allowed companies** | tick the owning company |

---

## X (Twitter) accounts

X posting requires OAuth 1.0a User Context — four credentials total.

### 1. Create an X Developer App

- Go to [https://developer.x.com/en/portal/projects-and-apps](https://developer.x.com/en/portal/projects-and-apps)
- Create a Project and an App inside it
- Under **App settings → User authentication settings**: enable OAuth 1.0a with **Read and Write** permissions

### 2. Get the four credentials

Under **Keys and Tokens**:

| Credential | Where |
|---|---|
| API Key (Consumer Key) | Keys and Tokens → Consumer Keys |
| API Secret (Consumer Secret) | Keys and Tokens → Consumer Keys |
| Access Token | Keys and Tokens → Authentication Tokens → Access Token and Secret |
| Access Token Secret | Keys and Tokens → Authentication Tokens → Access Token and Secret |

Generate the Access Token and Secret via **"Generate"** — this creates them as the app owner's user context.

### 3. Create Paperclip secrets and configure

Create four Paperclip secrets (one per credential) and copy their UUIDs. In the Configuration tab under **X (Twitter) accounts**, add an entry filling in each secret UUID.

---

## Troubleshooting

- **Facebook token expired** — Page tokens don't normally expire, but long-lived user tokens expire after 60 days if unused. Re-exchange via the Graph API and update the Paperclip secret.
- **Instagram \`[IG_MEDIA_UNPUBLISHED]\`** — the media container was created but publish timed out (>24 h). The next call recreates the container automatically.
- **X 403 / Forbidden** — the app's OAuth 1.0a permissions are set to Read Only. Change to Read and Write in the developer portal and regenerate the Access Token.
- **kids brand variant rejecting content** — the worker checks for adult-content patterns in the post body. Remove the flagged phrase or switch to \`standard\` variant for that page.
`;

const manifest: PaperclipPluginManifestV1 & { setupInstructions?: string } = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Social Poster",
  setupInstructions: SETUP_INSTRUCTIONS,
  description:
    "Posts to Facebook Pages, Instagram Business accounts, and X (Twitter) via their official APIs. Brand-variant aware; optional scheduling.",
  author: "Barry Carr & Tony Allard",
  categories: ["automation", "connector"],
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
    additionalProperties: false,
    properties: {
      facebookPages: {
        type: "array",
        title: "Facebook Pages",
        description:
          "Each Facebook Page the plugin can post to. Page Access Tokens should be long-lived; rotate via the secret store. Every page must list the company UUIDs allowed to use it under 'Allowed companies' — empty list = unusable (fail-safe default deny).",
        items: {
          type: "object",
          required: ["key", "pageId", "accessToken", "allowedCompanies"],
          properties: {
            name: {
              type: "string",
              title: "Display name",
              description:
                "Human-readable label shown in this settings form (e.g. 'Brand A FB', 'Brand B FB'). Free-form; only affects the UI.",
            },
            key: {
              type: "string",
              title: "Identifier",
              description:
                "Short stable ID agents pass when posting to this page (e.g. 'main', 'kids'). Lowercase, no spaces. Once skills reference it, don't change it. Must be unique across Facebook entries.",
            },
            allowedCompanies: {
              type: "array",
              items: { type: "string", format: "company-id" },
              title: "Allowed companies",
              description:
                "Companies allowed to post to this page. Tick 'Portfolio-wide' or specific companies. Empty = unusable.",
            },
            pageId: {
              type: "string",
              title: "Page ID",
              description:
                "Numeric Facebook Page ID. Find it under Page Settings → About.",
            },
            accessToken: {
              type: "string",
              format: "secret-ref",
              title: "Page Access Token",
              description:
                "Long-lived Page Access Token (UUID of the secret holding it). Generate at developers.facebook.com → Tools → Graph API Explorer.",
            },
            brandVariant: {
              type: "string",
              title: "Brand variant",
              description:
                "Lets the worker enforce variant-specific guardrails. 'kids' rejects adult content patterns; 'standard' allows everything the page permits.",
              enum: ["standard", "kids"],
              default: "standard",
            },
          },
        },
      },
      instagramAccounts: {
        type: "array",
        title: "Instagram Business accounts",
        description:
          "Each Instagram Business account the plugin can post to. Requires a connected Facebook Page; the access token is the linked Page's token. Every account must list the company UUIDs allowed to use it.",
        items: {
          type: "object",
          required: ["key", "igUserId", "accessToken", "allowedCompanies"],
          properties: {
            name: {
              type: "string",
              title: "Display name",
              description:
                "Human-readable label shown in this settings form (e.g. 'Brand A IG'). Free-form.",
            },
            key: {
              type: "string",
              title: "Identifier",
              description:
                "Short stable ID agents pass when posting to this account (e.g. 'main_ig'). Lowercase, no spaces. Once skills reference it, don't change it.",
            },
            allowedCompanies: {
              type: "array",
              items: { type: "string", format: "company-id" },
              title: "Allowed companies",
              description:
                "Companies allowed to post to this IG account. Tick 'Portfolio-wide' or specific companies. Empty = unusable.",
            },
            igUserId: {
              type: "string",
              title: "Instagram User ID",
              description:
                "Instagram Business Account ID (a numeric ID, NOT the @handle). Get it via Graph API: GET /<page-id>?fields=instagram_business_account.",
            },
            accessToken: {
              type: "string",
              format: "secret-ref",
              title: "Access Token",
              description:
                "Page Access Token of the Facebook Page connected to this IG Business account.",
            },
            brandVariant: {
              type: "string",
              title: "Brand variant",
              enum: ["standard", "kids"],
              default: "standard",
            },
          },
        },
      },
      xAccounts: {
        type: "array",
        title: "X (Twitter) accounts",
        description:
          "Each X account the plugin can post to. Posting via X API v2 requires OAuth 1.0a User Context (all four credentials). Every account must list the company UUIDs allowed to use it.",
        items: {
          type: "object",
          required: ["key", "apiKey", "apiSecret", "accessToken", "accessTokenSecret", "allowedCompanies"],
          properties: {
            name: {
              type: "string",
              title: "Display name",
              description:
                "Human-readable label shown in this settings form (e.g. 'Brand A X'). Free-form.",
            },
            key: {
              type: "string",
              title: "Identifier",
              description:
                "Short stable ID agents pass when posting from this account (e.g. 'main_x'). Lowercase, no spaces. Once skills reference it, don't change it.",
            },
            allowedCompanies: {
              type: "array",
              items: { type: "string", format: "company-id" },
              title: "Allowed companies",
              description:
                "Companies allowed to post from this X account. Tick 'Portfolio-wide' or specific companies. Empty = unusable.",
            },
            apiKey: {
              type: "string",
              format: "secret-ref",
              title: "API Key (Consumer Key)",
              description: "App-level consumer key, from developer.x.com.",
            },
            apiSecret: {
              type: "string",
              format: "secret-ref",
              title: "API Secret (Consumer Secret)",
            },
            accessToken: {
              type: "string",
              format: "secret-ref",
              title: "Access Token",
              description:
                "User-context access token. Generate via the developer portal under your project → Keys and tokens.",
            },
            accessTokenSecret: {
              type: "string",
              format: "secret-ref",
              title: "Access Token Secret",
            },
            brandVariant: {
              type: "string",
              title: "Brand variant",
              enum: ["standard", "kids"],
              default: "standard",
            },
          },
        },
      },
      allowPublish: {
        type: "boolean",
        title: "Allow publishing",
        description:
          "Master kill switch. Set false to put the plugin into draft-only mode (tools return the would-be payload without hitting the network).",
        default: false,
      },
    },
  },
  tools: [
    {
      name: "post_to_facebook",
      displayName: "Post to Facebook Page",
      description:
        "Publish a text or text-with-image post to a configured Facebook Page. Supports scheduled publishing via scheduled_publish_time (Unix seconds, must be 10 min – 6 months in future). Returns the post ID.",
      parametersSchema: {
        type: "object",
        properties: {
          page: {
            type: "string",
            description: "Page identifier as configured on the plugin settings page.",
          },
          message: {
            type: "string",
            description:
              "Post body. Required even when image_url is present (Facebook captions).",
          },
          image_url: {
            type: "string",
            description:
              "Optional public URL of an image. Facebook downloads and attaches it.",
          },
          link: {
            type: "string",
            description:
              "Optional URL Facebook should fetch a link preview for. Mutually informative with image_url.",
          },
          scheduled_publish_time: {
            type: "number",
            description:
              "Unix timestamp (seconds) for scheduled publish. Must be 10 min – 6 months in future. Omit for immediate publish.",
          },
        },
        required: ["page", "message"],
      },
    },
    {
      name: "post_to_instagram",
      displayName: "Post to Instagram",
      description:
        "Publish a single-image post to an Instagram Business account. Two-step: create a media container, then publish. image_url must be a publicly reachable JPEG/PNG URL.",
      parametersSchema: {
        type: "object",
        properties: {
          account: {
            type: "string",
            description: "IG account identifier as configured.",
          },
          image_url: {
            type: "string",
            description: "Public HTTPS URL to the image. JPEG or PNG.",
          },
          caption: {
            type: "string",
            description: "Caption text. Hashtags inline.",
          },
        },
        required: ["account", "image_url", "caption"],
      },
    },
    {
      name: "post_to_x",
      displayName: "Post to X (Twitter)",
      description:
        "Publish a single tweet via X API v2. For threads, call this tool repeatedly passing in_reply_to_tweet_id from the previous response. Returns the tweet ID.",
      parametersSchema: {
        type: "object",
        properties: {
          account: {
            type: "string",
            description: "X account identifier as configured.",
          },
          text: {
            type: "string",
            description: "Tweet text. Max 280 characters.",
          },
          in_reply_to_tweet_id: {
            type: "string",
            description:
              "Optional. ID of the tweet this reply continues (for threading).",
          },
        },
        required: ["account", "text"],
      },
    },
  ],
};

export default manifest;
