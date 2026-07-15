import { definePlugin, runWorker, type PluginContext, type ToolResult, type ToolRunContext } from "@paperclipai/plugin-sdk";

type AccountConfig = { key: string; displayName?: string; accessTokenRef: string; igUserId: string; fbPageId?: string; allowedCompanies: string[] };
type InstanceConfig = { defaultAccount?: string; accounts?: AccountConfig[] };
type ResolvedAccount = { config: AccountConfig; accessToken: string; accountKey: string };

async function resolveAccount(
  ctx: PluginContext, runCtx: ToolRunContext, accountKey: string | undefined,
): Promise<{ ok: true; resolved: ResolvedAccount } | { ok: false; error: string }> {
  const rawConfig = (await ctx.config.get()) as InstanceConfig;
  const accounts = rawConfig.accounts ?? [];
  const key = accountKey ?? rawConfig.defaultAccount;
  if (!key) return { ok: false, error: "[ECONFIG] No account specified and no defaultAccount configured." };

  const config = accounts.find((a) => a.key === key);
  if (!config) return { ok: false, error: `[ECONFIG] Account "${key}" not found. Available: ${accounts.map((a) => a.key).join(", ") || "(none)"}` };

  const allowed = config.allowedCompanies ?? [];
  if (allowed.length > 0 && !allowed.includes("*") && !allowed.includes(runCtx.companyId)) {
    return { ok: false, error: `[ECOMPANY_NOT_ALLOWED] Company ${runCtx.companyId} not allowed for account "${key}".` };
  }

  const accessToken = await ctx.secrets.resolve(config.accessTokenRef);
  if (!accessToken) return { ok: false, error: `[ECONFIG] Could not resolve access token for account "${key}".` };

  return { ok: true, resolved: { config, accessToken, accountKey: key } };
}

const GRAPH_API = "https://graph.facebook.com/v21.0";

async function igApi(accessToken: string, endpoint: string, method = "GET", body?: Record<string, unknown>) {
  const url = endpoint.startsWith("http") ? endpoint : `${GRAPH_API}${endpoint}`;
  const opts: RequestInit = { method, headers: { Authorization: `Bearer ${accessToken}` } };
  if (body && method === "POST") {
    opts.headers = { ...opts.headers, "Content-Type": "application/json" } as Record<string, string>;
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(url, opts);
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Instagram API ${resp.status}: ${JSON.stringify(data)}`);
  return data as Record<string, unknown>;
}

async function waitForContainer(accessToken: string, containerId: string, maxWaitMs = 60000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const status = await igApi(accessToken, `/${containerId}?fields=status_code`);
    if (status.status_code === "FINISHED") return "FINISHED";
    if (status.status_code === "ERROR") throw new Error(`Container processing failed: ${JSON.stringify(status)}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("Container processing timed out.");
}

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    ctx.logger.info("instagram-tools plugin setup");

    const rawConfig = (await ctx.config.get()) as InstanceConfig;
    const accounts = rawConfig.accounts ?? [];
    if (accounts.length === 0) {
      ctx.logger.warn("instagram-tools: no accounts configured. Add them on /instance/settings/plugins/instagram-tools.");
    } else {
      ctx.logger.info(`instagram-tools: ready. Accounts — ${accounts.map((a) => a.key).join(", ")}`);
    }

    ctx.tools.register("instagram_post_photo", {
      displayName: "Post Instagram photo",
      description: "Publish a single photo to Instagram. Image must be at a public URL.",
      parametersSchema: { type: "object", properties: { account: { type: "string" }, imageUrl: { type: "string" }, caption: { type: "string" }, locationId: { type: "string" }, userTags: { type: "array", items: { type: "object" } } }, required: ["imageUrl"] },
    }, async (params, runCtx): Promise<ToolResult> => {
      const p = params as { account?: string; imageUrl: string; caption?: string; locationId?: string; userTags?: Array<{ username: string; x: number; y: number }> };
      const r = await resolveAccount(ctx, runCtx, p.account);
      if (!r.ok) return { error: r.error };

      try {
        // Step 1: Create media container
        const containerBody: Record<string, unknown> = { image_url: p.imageUrl, caption: p.caption ?? "" };
        if (p.locationId) containerBody.location_id = p.locationId;
        if (p.userTags?.length) containerBody.user_tags = JSON.stringify(p.userTags.map((t) => ({ username: t.username, x: t.x, y: t.y })));

        const container = await igApi(r.resolved.accessToken, `/${r.resolved.config.igUserId}/media`, "POST", containerBody);
        const containerId = container.id as string;

        // Step 2: Wait for processing
        await waitForContainer(r.resolved.accessToken, containerId);

        // Step 3: Publish
        const published = await igApi(r.resolved.accessToken, `/${r.resolved.config.igUserId}/media_publish`, "POST", { creation_id: containerId });
        const mediaId = published.id as string;

        // Step 4: Get permalink
        const media = await igApi(r.resolved.accessToken, `/${mediaId}?fields=id,permalink,timestamp`);

        await ctx.telemetry.track("instagram-tools.post_photo", { account: r.resolved.accountKey, companyId: runCtx.companyId }).catch(() => {});
        return { content: `Photo posted to Instagram.`, data: { mediaId, permalink: media.permalink, timestamp: media.timestamp } };
      } catch (err) { return { error: `[EINSTAGRAM] ${(err as Error).message}` }; }
    });

    ctx.tools.register("instagram_post_carousel", {
      displayName: "Post Instagram carousel",
      description: "Publish a carousel (2–10 items) to Instagram.",
      parametersSchema: { type: "object", properties: { account: { type: "string" }, items: { type: "array", items: { type: "object", properties: { mediaUrl: { type: "string" }, mediaType: { type: "string" } }, required: ["mediaUrl"] } }, caption: { type: "string" }, locationId: { type: "string" } }, required: ["items"] },
    }, async (params, runCtx): Promise<ToolResult> => {
      const p = params as { account?: string; items: Array<{ mediaUrl: string; mediaType?: string }>; caption?: string; locationId?: string };
      const r = await resolveAccount(ctx, runCtx, p.account);
      if (!r.ok) return { error: r.error };

      if (p.items.length < 2 || p.items.length > 10) return { error: "[EINVALID_INPUT] Carousel requires 2–10 items." };

      try {
        // Create child containers
        const childIds: string[] = [];
        for (const item of p.items) {
          const body: Record<string, unknown> = item.mediaType === "VIDEO"
            ? { media_type: "VIDEO", video_url: item.mediaUrl, is_carousel_item: true }
            : { image_url: item.mediaUrl, is_carousel_item: true };
          const child = await igApi(r.resolved.accessToken, `/${r.resolved.config.igUserId}/media`, "POST", body);
          childIds.push(child.id as string);
        }

        // Wait for all children
        for (const childId of childIds) await waitForContainer(r.resolved.accessToken, childId);

        // Create carousel container
        const carouselBody: Record<string, unknown> = { media_type: "CAROUSEL", children: childIds.join(","), caption: p.caption ?? "" };
        if (p.locationId) carouselBody.location_id = p.locationId;
        const carousel = await igApi(r.resolved.accessToken, `/${r.resolved.config.igUserId}/media`, "POST", carouselBody);
        const carouselId = carousel.id as string;

        // Publish
        const published = await igApi(r.resolved.accessToken, `/${r.resolved.config.igUserId}/media_publish`, "POST", { creation_id: carouselId });
        const media = await igApi(r.resolved.accessToken, `/${published.id}?fields=id,permalink,timestamp`);

        return { content: `Carousel (${p.items.length} items) posted to Instagram.`, data: { mediaId: published.id, permalink: media.permalink, timestamp: media.timestamp } };
      } catch (err) { return { error: `[EINSTAGRAM] ${(err as Error).message}` }; }
    });

    ctx.tools.register("instagram_post_reel", {
      displayName: "Post Instagram reel",
      description: "Publish a reel (short video) to Instagram.",
      parametersSchema: { type: "object", properties: { account: { type: "string" }, videoUrl: { type: "string" }, caption: { type: "string" }, coverUrl: { type: "string" }, shareToFeed: { type: "boolean" }, locationId: { type: "string" } }, required: ["videoUrl"] },
    }, async (params, runCtx): Promise<ToolResult> => {
      const p = params as { account?: string; videoUrl: string; caption?: string; coverUrl?: string; shareToFeed?: boolean; locationId?: string };
      const r = await resolveAccount(ctx, runCtx, p.account);
      if (!r.ok) return { error: r.error };

      try {
        const body: Record<string, unknown> = { media_type: "REELS", video_url: p.videoUrl, caption: p.caption ?? "", share_to_feed: p.shareToFeed ?? true };
        if (p.coverUrl) body.cover_url = p.coverUrl;
        if (p.locationId) body.location_id = p.locationId;

        const container = await igApi(r.resolved.accessToken, `/${r.resolved.config.igUserId}/media`, "POST", body);
        await waitForContainer(r.resolved.accessToken, container.id as string, 120000);
        const published = await igApi(r.resolved.accessToken, `/${r.resolved.config.igUserId}/media_publish`, "POST", { creation_id: container.id });
        const media = await igApi(r.resolved.accessToken, `/${published.id}?fields=id,permalink,timestamp`);

        return { content: `Reel posted to Instagram.`, data: { mediaId: published.id, permalink: media.permalink, timestamp: media.timestamp } };
      } catch (err) { return { error: `[EINSTAGRAM] ${(err as Error).message}` }; }
    });

    ctx.tools.register("instagram_post_story", {
      displayName: "Post Instagram story",
      description: "Publish a story (photo or video). Stories disappear after 24h.",
      parametersSchema: { type: "object", properties: { account: { type: "string" }, mediaUrl: { type: "string" }, mediaType: { type: "string" } }, required: ["mediaUrl"] },
    }, async (params, runCtx): Promise<ToolResult> => {
      const p = params as { account?: string; mediaUrl: string; mediaType?: string };
      const r = await resolveAccount(ctx, runCtx, p.account);
      if (!r.ok) return { error: r.error };

      try {
        const isVideo = p.mediaType === "VIDEO";
        const body: Record<string, unknown> = isVideo
          ? { media_type: "STORIES", video_url: p.mediaUrl }
          : { media_type: "STORIES", image_url: p.mediaUrl };

        const container = await igApi(r.resolved.accessToken, `/${r.resolved.config.igUserId}/media`, "POST", body);
        if (isVideo) await waitForContainer(r.resolved.accessToken, container.id as string);
        const published = await igApi(r.resolved.accessToken, `/${r.resolved.config.igUserId}/media_publish`, "POST", { creation_id: container.id });

        return { content: `Story posted to Instagram.`, data: { mediaId: published.id } };
      } catch (err) { return { error: `[EINSTAGRAM] ${(err as Error).message}` }; }
    });

    ctx.tools.register("instagram_get_media", {
      displayName: "Get Instagram media info", description: "Retrieve metadata for a published media item.",
      parametersSchema: { type: "object", properties: { account: { type: "string" }, mediaId: { type: "string" } }, required: ["mediaId"] },
    }, async (params, runCtx): Promise<ToolResult> => {
      const p = params as { account?: string; mediaId: string };
      const r = await resolveAccount(ctx, runCtx, p.account);
      if (!r.ok) return { error: r.error };

      try {
        const media = await igApi(r.resolved.accessToken, `/${p.mediaId}?fields=id,media_type,media_url,permalink,caption,timestamp,like_count,comments_count`);
        return { content: `Retrieved media ${p.mediaId}.`, data: media };
      } catch (err) { return { error: `[EINSTAGRAM] ${(err as Error).message}` }; }
    });

    ctx.tools.register("instagram_list_media", {
      displayName: "List recent Instagram posts", description: "List recent media from the account.",
      parametersSchema: { type: "object", properties: { account: { type: "string" }, limit: { type: "number" } } },
    }, async (params, runCtx): Promise<ToolResult> => {
      const p = params as { account?: string; limit?: number };
      const r = await resolveAccount(ctx, runCtx, p.account);
      if (!r.ok) return { error: r.error };

      const limit = Math.min(Math.max(p.limit ?? 25, 1), 100);
      try {
        const data = await igApi(r.resolved.accessToken, `/${r.resolved.config.igUserId}/media?fields=id,media_type,caption,permalink,timestamp&limit=${limit}`);
        const media = (data.data ?? []) as unknown[];
        return { content: `Listed ${media.length} recent post(s).`, data: { media } };
      } catch (err) { return { error: `[EINSTAGRAM] ${(err as Error).message}` }; }
    });
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
