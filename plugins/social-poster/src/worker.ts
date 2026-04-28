import {
  definePlugin,
  runWorker,
  type PluginContext,
  type ToolResult,
} from "@paperclipai/plugin-sdk";
import { createHmac, randomBytes } from "node:crypto";

interface FacebookPage {
  key?: string;
  pageId?: string;
  accessToken?: string;
  brandVariant?: "standard" | "kids";
}

interface InstagramAccount {
  key?: string;
  igUserId?: string;
  accessToken?: string;
  brandVariant?: "standard" | "kids";
}

interface XAccount {
  key?: string;
  apiKey?: string;
  apiSecret?: string;
  accessToken?: string;
  accessTokenSecret?: string;
  brandVariant?: "standard" | "kids";
}

interface InstanceConfig {
  allowPublish?: boolean;
  facebookPages?: FacebookPage[];
  instagramAccounts?: InstagramAccount[];
  xAccounts?: XAccount[];
}

const FB_GRAPH = "https://graph.facebook.com/v19.0";
const X_API = "https://api.twitter.com/2";

function findByKey<T extends { key?: string }>(list: T[] | undefined, key: string): T | undefined {
  const lower = key.toLowerCase();
  return (list ?? []).find((x) => (x.key ?? "").toLowerCase() === lower);
}

function violatesKidsGuardrail(text: string): string | null {
  const banned = [
    /\b(nsfw|onlyfans|18\+)\b/i,
    /\bsex\w*/i,
    /\b(fuck|shit|bitch)\b/i,
  ];
  for (const re of banned) {
    if (re.test(text)) return `Content blocked by 'kids' brand-variant guardrail (matched: ${re}).`;
  }
  return null;
}

async function postFacebook(
  ctx: PluginContext,
  config: InstanceConfig,
  params: {
    page?: string;
    message?: string;
    image_url?: string;
    link?: string;
    scheduled_publish_time?: number;
  },
): Promise<ToolResult> {
  if (!params.page) return { error: "page is required" };
  if (!params.message) return { error: "message is required" };

  const cfg = findByKey(config.facebookPages, params.page);
  if (!cfg) {
    return {
      error: `Facebook page "${params.page}" not configured. Add it on the social-poster plugin settings page.`,
    };
  }
  if (!cfg.pageId || !cfg.accessToken) {
    return { error: `Facebook page "${params.page}": pageId and accessToken are required.` };
  }

  if ((cfg.brandVariant ?? "standard") === "kids") {
    const v = violatesKidsGuardrail(params.message);
    if (v) return { error: v };
  }

  const token = await ctx.secrets.resolve(cfg.accessToken);
  const isPhoto = !!params.image_url;
  const url = `${FB_GRAPH}/${cfg.pageId}/${isPhoto ? "photos" : "feed"}`;

  const body: Record<string, string | number> = {
    access_token: token,
  };
  if (isPhoto) {
    body.url = params.image_url!;
    body.caption = params.message;
  } else {
    body.message = params.message;
    if (params.link) body.link = params.link;
  }
  if (typeof params.scheduled_publish_time === "number") {
    body.published = "false";
    body.scheduled_publish_time = params.scheduled_publish_time;
  }

  const formBody = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) formBody.set(k, String(v));

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: formBody.toString(),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;

  if (!res.ok || !json || (json.error && typeof json.error === "object")) {
    const errMsg =
      json && typeof json.error === "object"
        ? JSON.stringify(json.error)
        : `HTTP ${res.status}`;
    return { error: `Facebook publish failed: ${errMsg}` };
  }

  const postId = (json.id as string | undefined) ?? "";
  return {
    content: `Posted to Facebook ${cfg.pageId}. Post ID ${postId}.`,
    data: {
      ok: true,
      platform: "facebook",
      page: cfg.pageId,
      post_id: postId,
      scheduled: typeof params.scheduled_publish_time === "number",
    },
  };
}

async function postInstagram(
  ctx: PluginContext,
  config: InstanceConfig,
  params: { account?: string; image_url?: string; caption?: string },
): Promise<ToolResult> {
  if (!params.account) return { error: "account is required" };
  if (!params.image_url) return { error: "image_url is required" };
  if (!params.caption) return { error: "caption is required" };

  const cfg = findByKey(config.instagramAccounts, params.account);
  if (!cfg) {
    return {
      error: `Instagram account "${params.account}" not configured.`,
    };
  }
  if (!cfg.igUserId || !cfg.accessToken) {
    return { error: `Instagram "${params.account}": igUserId and accessToken are required.` };
  }
  if ((cfg.brandVariant ?? "standard") === "kids") {
    const v = violatesKidsGuardrail(params.caption);
    if (v) return { error: v };
  }

  const token = await ctx.secrets.resolve(cfg.accessToken);

  // Step 1: create the media container
  const containerForm = new URLSearchParams();
  containerForm.set("image_url", params.image_url);
  containerForm.set("caption", params.caption);
  containerForm.set("access_token", token);

  const containerRes = await fetch(`${FB_GRAPH}/${cfg.igUserId}/media`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: containerForm.toString(),
  });
  const containerJson = (await containerRes.json().catch(() => null)) as
    | Record<string, unknown>
    | null;
  if (!containerRes.ok || !containerJson?.id) {
    return {
      error: `Instagram media-container failed: ${
        containerJson && typeof containerJson.error === "object"
          ? JSON.stringify(containerJson.error)
          : `HTTP ${containerRes.status}`
      }`,
    };
  }
  const containerId = String(containerJson.id);

  // Step 2: publish the container
  const publishForm = new URLSearchParams();
  publishForm.set("creation_id", containerId);
  publishForm.set("access_token", token);

  const publishRes = await fetch(`${FB_GRAPH}/${cfg.igUserId}/media_publish`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: publishForm.toString(),
  });
  const publishJson = (await publishRes.json().catch(() => null)) as
    | Record<string, unknown>
    | null;
  if (!publishRes.ok || !publishJson?.id) {
    return {
      error: `Instagram publish failed: ${
        publishJson && typeof publishJson.error === "object"
          ? JSON.stringify(publishJson.error)
          : `HTTP ${publishRes.status}`
      }`,
    };
  }
  const mediaId = String(publishJson.id);

  return {
    content: `Posted to Instagram ${cfg.igUserId}. Media ID ${mediaId}.`,
    data: { ok: true, platform: "instagram", account: cfg.igUserId, media_id: mediaId },
  };
}

// --- OAuth 1.0a signing for X --------------------------------------------

function rfc3986(s: string): string {
  return encodeURIComponent(s)
    .replace(/!/g, "%21")
    .replace(/\*/g, "%2A")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/'/g, "%27");
}

function buildOAuth1AuthHeader(opts: {
  method: string;
  url: string;
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
  bodyParams?: Record<string, string>;
  queryParams?: Record<string, string>;
}): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: opts.consumerKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: opts.token,
    oauth_version: "1.0",
  };

  const allParams: Record<string, string> = {
    ...oauthParams,
    ...(opts.bodyParams ?? {}),
    ...(opts.queryParams ?? {}),
  };

  const sortedKeys = Object.keys(allParams).sort();
  const paramString = sortedKeys
    .map((k) => `${rfc3986(k)}=${rfc3986(allParams[k])}`)
    .join("&");

  const baseString = [
    opts.method.toUpperCase(),
    rfc3986(opts.url),
    rfc3986(paramString),
  ].join("&");

  const signingKey = `${rfc3986(opts.consumerSecret)}&${rfc3986(opts.tokenSecret)}`;
  const signature = createHmac("sha1", signingKey).update(baseString).digest("base64");

  const authParams: Record<string, string> = {
    ...oauthParams,
    oauth_signature: signature,
  };

  return (
    "OAuth " +
    Object.keys(authParams)
      .sort()
      .map((k) => `${rfc3986(k)}="${rfc3986(authParams[k])}"`)
      .join(", ")
  );
}

async function postX(
  ctx: PluginContext,
  config: InstanceConfig,
  params: { account?: string; text?: string; in_reply_to_tweet_id?: string },
): Promise<ToolResult> {
  if (!params.account) return { error: "account is required" };
  if (!params.text) return { error: "text is required" };
  if (params.text.length > 280) {
    return { error: `text exceeds 280 chars (${params.text.length}).` };
  }

  const cfg = findByKey(config.xAccounts, params.account);
  if (!cfg) {
    return { error: `X account "${params.account}" not configured.` };
  }
  if (!cfg.apiKey || !cfg.apiSecret || !cfg.accessToken || !cfg.accessTokenSecret) {
    return {
      error: `X account "${params.account}": all four credentials (apiKey, apiSecret, accessToken, accessTokenSecret) are required.`,
    };
  }
  if ((cfg.brandVariant ?? "standard") === "kids") {
    const v = violatesKidsGuardrail(params.text);
    if (v) return { error: v };
  }

  const [consumerKey, consumerSecret, token, tokenSecret] = await Promise.all([
    ctx.secrets.resolve(cfg.apiKey),
    ctx.secrets.resolve(cfg.apiSecret),
    ctx.secrets.resolve(cfg.accessToken),
    ctx.secrets.resolve(cfg.accessTokenSecret),
  ]);

  const url = `${X_API}/tweets`;
  const jsonBody: Record<string, unknown> = { text: params.text };
  if (params.in_reply_to_tweet_id) {
    jsonBody.reply = { in_reply_to_tweet_id: params.in_reply_to_tweet_id };
  }

  // X v2 with JSON body: OAuth 1.0a base string excludes the JSON body
  // (only oauth_* params + query string go into the signature). This matches
  // X's documented behaviour for application/json POSTs.
  const authHeader = buildOAuth1AuthHeader({
    method: "POST",
    url,
    consumerKey,
    consumerSecret,
    token,
    tokenSecret,
  });

  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: authHeader,
      "content-type": "application/json",
    },
    body: JSON.stringify(jsonBody),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;

  if (!res.ok || !json) {
    return {
      error: `X publish failed: ${
        json ? JSON.stringify(json) : `HTTP ${res.status}`
      }`,
    };
  }
  const data = json.data as { id?: string; text?: string } | undefined;
  if (!data?.id) {
    return { error: `X publish: unexpected response shape: ${JSON.stringify(json)}` };
  }

  return {
    content: `Posted to X. Tweet ID ${data.id}.`,
    data: {
      ok: true,
      platform: "x",
      account: cfg.key,
      tweet_id: data.id,
      in_reply_to: params.in_reply_to_tweet_id ?? null,
    },
  };
}

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    ctx.logger.info("social-poster plugin setup");

    const config = (await ctx.config.get()) as InstanceConfig;
    const fbCount = (config.facebookPages ?? []).length;
    const igCount = (config.instagramAccounts ?? []).length;
    const xCount = (config.xAccounts ?? []).length;

    if (!config.allowPublish) {
      ctx.logger.warn(
        "social-poster: allowPublish=false. Posts will be blocked until enabled on the plugin settings page.",
      );
    }
    ctx.logger.info(
      `social-poster: ready. Configured — Facebook: ${fbCount}, Instagram: ${igCount}, X: ${xCount}.`,
    );

    function gateAllowPublish(action: string): ToolResult | null {
      if (config.allowPublish) return null;
      return {
        error: `Publishing disabled. Enable allowPublish on the social-poster plugin settings page before calling ${action}.`,
      };
    }

    ctx.tools.register(
      "post_to_facebook",
      {
        displayName: "Post to Facebook Page",
        description:
          "Publish a text or text-with-image post to a configured Facebook Page. Returns the post ID.",
        parametersSchema: {
          type: "object",
          properties: {
            page: { type: "string" },
            message: { type: "string" },
            image_url: { type: "string" },
            link: { type: "string" },
            scheduled_publish_time: { type: "number" },
          },
          required: ["page", "message"],
        },
      },
      async (params): Promise<ToolResult> => {
        const fresh = (await ctx.config.get()) as InstanceConfig;
        const blocked = !fresh.allowPublish ? gateAllowPublish("post_to_facebook") : null;
        if (blocked) return blocked;
        return postFacebook(ctx, fresh, params as Parameters<typeof postFacebook>[2]);
      },
    );

    ctx.tools.register(
      "post_to_instagram",
      {
        displayName: "Post to Instagram",
        description:
          "Publish a single-image post to an Instagram Business account. Two-step API: media container then publish.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            image_url: { type: "string" },
            caption: { type: "string" },
          },
          required: ["account", "image_url", "caption"],
        },
      },
      async (params): Promise<ToolResult> => {
        const fresh = (await ctx.config.get()) as InstanceConfig;
        const blocked = !fresh.allowPublish ? gateAllowPublish("post_to_instagram") : null;
        if (blocked) return blocked;
        return postInstagram(ctx, fresh, params as Parameters<typeof postInstagram>[2]);
      },
    );

    ctx.tools.register(
      "post_to_x",
      {
        displayName: "Post to X (Twitter)",
        description:
          "Publish a tweet via X API v2. For threads, chain calls passing in_reply_to_tweet_id from the previous response.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            text: { type: "string" },
            in_reply_to_tweet_id: { type: "string" },
          },
          required: ["account", "text"],
        },
      },
      async (params): Promise<ToolResult> => {
        const fresh = (await ctx.config.get()) as InstanceConfig;
        const blocked = !fresh.allowPublish ? gateAllowPublish("post_to_x") : null;
        if (blocked) return blocked;
        return postX(ctx, fresh, params as Parameters<typeof postX>[2]);
      },
    );
  },

  async onHealth() {
    return { status: "ok", message: "social-poster ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
