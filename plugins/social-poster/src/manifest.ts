import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "social-poster";
const PLUGIN_VERSION = "0.1.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Social Poster",
  description:
    "Posts to Facebook Pages, Instagram Business accounts, and X (Twitter) via their official APIs. Brand-variant aware; optional scheduling.",
  author: "Barry Carr",
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
    properties: {
      facebookPages: {
        type: "array",
        title: "Facebook Pages",
        description:
          "Each Facebook Page the plugin can post to. Page Access Tokens should be long-lived; rotate via the secret store.",
        items: {
          type: "object",
          required: ["key", "pageId", "accessToken"],
          properties: {
            key: {
              type: "string",
              title: "Key",
              description:
                "Identifier agents reference (e.g. 'main', 'kids'). Must be unique across Facebook entries.",
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
          "Each Instagram Business account the plugin can post to. Requires a connected Facebook Page; the access token is the linked Page's token.",
        items: {
          type: "object",
          required: ["key", "igUserId", "accessToken"],
          properties: {
            key: {
              type: "string",
              title: "Key",
              description: "Identifier agents reference (e.g. 'main_ig').",
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
          "Each X account the plugin can post to. Posting via X API v2 requires OAuth 1.0a User Context (all four credentials).",
        items: {
          type: "object",
          required: ["key", "apiKey", "apiSecret", "accessToken", "accessTokenSecret"],
          properties: {
            key: {
              type: "string",
              title: "Key",
              description: "Identifier agents reference (e.g. 'main_x').",
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
            description: "Page key as configured on the plugin settings page.",
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
            description: "IG account key as configured.",
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
            description: "X account key as configured.",
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
