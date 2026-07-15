import {
  definePlugin,
  runWorker,
  type PluginContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { promises as fs } from "node:fs";
import path from "node:path";

type AccountConfig = {
  key: string;
  displayName?: string;
  clientIdRef: string;
  clientSecretRef: string;
  refreshTokenRef: string;
  videoSourceFolder?: string;
  maxUploadsPerRun?: number;
  channelId?: string;
  defaultPrivacy?: string;
  allowedCompanies: string[];
};

type InstanceConfig = {
  defaultAccount?: string;
  accounts?: AccountConfig[];
};

type ResolvedAccount = {
  config: AccountConfig;
  accessToken: string;
  accountKey: string;
};

async function resolveAccount(
  ctx: PluginContext,
  runCtx: ToolRunContext,
  accountKey: string | undefined,
): Promise<{ ok: true; resolved: ResolvedAccount } | { ok: false; error: string }> {
  const rawConfig = (await ctx.config.get()) as InstanceConfig;
  const accounts = rawConfig.accounts ?? [];
  const key = accountKey ?? rawConfig.defaultAccount;
  if (!key) return { ok: false, error: "[ECONFIG] No account specified and no defaultAccount configured." };

  const config = accounts.find((a) => a.key === key);
  if (!config) return { ok: false, error: `[ECONFIG] Account "${key}" not found.` };

  const allowed = config.allowedCompanies ?? [];
  if (allowed.length > 0 && !allowed.includes("*") && !allowed.includes(runCtx.companyId)) {
    return { ok: false, error: `[ECOMPANY_NOT_ALLOWED] Company not allowed for account "${key}".` };
  }

  const clientId = await ctx.secrets.resolve(config.clientIdRef);
  const clientSecret = await ctx.secrets.resolve(config.clientSecretRef);
  const refreshToken = await ctx.secrets.resolve(config.refreshTokenRef);
  if (!clientId || !clientSecret || !refreshToken) return { ok: false, error: `[ECONFIG] Missing OAuth2 credentials for account "${key}".` };

  // Exchange refresh token for access token
  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  if (!tokenResp.ok) return { ok: false, error: `[EAUTH] OAuth2 token refresh failed: ${tokenResp.status}` };
  const tokenData = await tokenResp.json() as { access_token?: string };
  if (!tokenData.access_token) return { ok: false, error: "[EAUTH] No access_token in OAuth2 response." };

  return { ok: true, resolved: { config, accessToken: tokenData.access_token, accountKey: key } };
}

// Resolve a (possibly relative) file path against the account's configured
// video source folder. Absolute paths are returned unchanged.
function resolveFilePath(filePath: string, sourceFolder?: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  if (sourceFolder) return path.resolve(sourceFolder, filePath);
  return path.resolve(filePath);
}

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv", ".mpg", ".mpeg"]);

// Turn a bare filename into a human subject hint the agent can reason about:
// strip the extension, drop a trailing date/timestamp run, and normalize
// separators to spaces. "BookZeta.ai_ad_accessibility_202605251627.mp4"
// -> "BookZeta ai ad accessibility".
function deriveSubject(fileName: string): string {
  let name = fileName.replace(/\.[^.]+$/, "");
  name = name.replace(/[._-]?\d{6,}$/, ""); // trailing timestamp/date block
  name = name.replace(/[._-]+/g, " ").trim();
  return name.replace(/\s+/g, " ");
}

// Read small context docs the agent uses to write titles/descriptions:
// every *.md/*.txt in the base folder, plus any *_post.txt inside each
// category subfolder. Project-agnostic — discovers whatever is there.
async function readContextDocs(folder: string): Promise<Record<string, string>> {
  const MAX = 20_000;
  const docs: Record<string, string> = {};
  const sources: Array<[string, string]> = [];
  let baseEntries: import("node:fs").Dirent[] = [];
  try {
    baseEntries = await fs.readdir(folder, { withFileTypes: true });
  } catch { return docs; /* base unreadable */ }

  for (const e of baseEntries) {
    if (e.isFile() && /\.(md|txt)$/i.test(e.name)) sources.push([e.name, path.join(folder, e.name)]);
  }
  for (const sub of baseEntries) {
    if (!sub.isDirectory()) continue;
    try {
      for (const e of await fs.readdir(path.join(folder, sub.name), { withFileTypes: true })) {
        if (e.isFile() && /_post\.txt$/i.test(e.name)) sources.push([`${sub.name}/${e.name}`, path.join(folder, sub.name, e.name)]);
      }
    } catch { /* skip */ }
  }
  for (const [key, fp] of sources) {
    try { docs[key] = (await fs.readFile(fp, "utf-8")).slice(0, MAX); } catch { /* skip unreadable */ }
  }
  return docs;
}

async function ytApi(accessToken: string, endpoint: string, method = "GET", body?: unknown) {
  const resp = await fetch(`https://www.googleapis.com/youtube/v3${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`YouTube API ${resp.status}: ${JSON.stringify(data)}`);
  return data;
}

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    ctx.logger.info("youtube-tools plugin setup");

    ctx.tools.register("youtube_list_pending", {
      displayName: "List unposted YouTube videos",
      description: "List bare video files in stories/not_posted (videos) and shorts/not_posted (Shorts), plus context docs.",
      parametersSchema: { type: "object", properties: { account: { type: "string" } } },
    }, async (params, runCtx): Promise<ToolResult> => {
      const p = params as { account?: string };
      const r = await resolveAccount(ctx, runCtx, p.account);
      if (!r.ok) return { error: r.error };
      const folder = r.resolved.config.videoSourceFolder;
      if (!folder) return { error: "[ECONFIG] No videoSourceFolder configured for this account." };

      try {
        // Auto-discover categories: any immediate subfolder that contains a
        // not_posted/ folder is a publishing category. Type is inferred from
        // the folder name (anything matching /short/i → Short, else video).
        let categoryDirs: import("node:fs").Dirent[];
        try {
          categoryDirs = await fs.readdir(folder, { withFileTypes: true });
        } catch {
          return { error: `[ENOTFOUND] Video source folder not found: ${folder}.` };
        }
        const videos: unknown[] = [];
        const categories: string[] = [];
        for (const cat of categoryDirs) {
          if (!cat.isDirectory()) continue;
          const notPostedDir = path.join(folder, cat.name, "not_posted");
          let entries: import("node:fs").Dirent[];
          try {
            entries = await fs.readdir(notPostedDir, { withFileTypes: true });
          } catch {
            continue; // no not_posted/ → not a publishing category
          }
          categories.push(cat.name);
          const type = /short/i.test(cat.name) ? "short" : "video";
          for (const e of entries) {
            if (!e.isFile() || !VIDEO_EXTENSIONS.has(path.extname(e.name).toLowerCase())) continue;
            videos.push({
              type,
              category: cat.name,
              fileName: e.name,
              filePath: path.join(notPostedDir, e.name),
              subjectHint: deriveSubject(e.name),
            });
          }
        }
        const contextDocs = await readContextDocs(folder);
        const shorts = videos.filter((v) => (v as { type: string }).type === "short").length;
        const maxUploadsPerRun = r.resolved.config.maxUploadsPerRun ?? 5;
        return {
          content: `Found ${videos.length} unposted file(s) across ${categories.length} categor${categories.length === 1 ? "y" : "ies"} [${categories.join(", ")}]: ${shorts} short(s), ${videos.length - shorts} video(s). Upload at most ${maxUploadsPerRun} this run.`,
          data: { folder, categories, videos, contextDocs, maxUploadsPerRun },
        };
      } catch (err) { return { error: `[EFS] ${(err as Error).message}` }; }
    });

    ctx.tools.register("youtube_mark_posted", {
      displayName: "Move a posted video to posted/",
      description: "Move a video file from its not_posted/ folder to the sibling posted/ folder.",
      parametersSchema: { type: "object", properties: { account: { type: "string" }, filePath: { type: "string" } }, required: ["filePath"] },
    }, async (params, runCtx): Promise<ToolResult> => {
      const p = params as { account?: string; filePath: string };
      const r = await resolveAccount(ctx, runCtx, p.account);
      if (!r.ok) return { error: r.error };
      const folder = r.resolved.config.videoSourceFolder;
      if (!folder) return { error: "[ECONFIG] No videoSourceFolder configured for this account." };

      try {
        const abs = resolveFilePath(p.filePath, folder);
        const base = path.resolve(folder);
        if (!abs.startsWith(base + path.sep)) {
          return { error: "[EINVALID_INPUT] filePath must be inside the configured video source folder." };
        }
        const parts = abs.split(path.sep);
        const idx = parts.lastIndexOf("not_posted");
        if (idx === -1) return { error: "[EINVALID_INPUT] filePath is not under a not_posted/ folder." };
        parts[idx] = "posted";
        const dest = parts.join(path.sep);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.rename(abs, dest);
        return { content: `Moved ${path.basename(abs)} to posted/.`, data: { from: abs, to: dest } };
      } catch (err) { return { error: `[EFS] ${(err as Error).message}` }; }
    });

    ctx.tools.register("youtube_upload", {
      displayName: "Upload YouTube video",
      description: "Upload a video file to YouTube with metadata.",
      parametersSchema: { type: "object", properties: { account: { type: "string" }, filePath: { type: "string" }, short: { type: "boolean" }, title: { type: "string" }, description: { type: "string" }, tags: { type: "array", items: { type: "string" } }, categoryId: { type: "string" }, privacy: { type: "string" }, publishAt: { type: "string" }, madeForKids: { type: "boolean" }, language: { type: "string" }, notifySubscribers: { type: "boolean" } }, required: ["filePath", "title", "description"] },
    }, async (params, runCtx): Promise<ToolResult> => {
      const p = params as { account?: string; filePath: string; short?: boolean; title: string; description: string; tags?: string[]; categoryId?: string; privacy?: string; publishAt?: string; madeForKids?: boolean; language?: string; notifySubscribers?: boolean };
      const r = await resolveAccount(ctx, runCtx, p.account);
      if (!r.ok) return { error: r.error };

      try {
        const resolvedPath = resolveFilePath(p.filePath, r.resolved.config.videoSourceFolder);
        const fileStat = await fs.stat(resolvedPath);
        const fileData = await fs.readFile(resolvedPath);
        const privacy = p.privacy ?? r.resolved.config.defaultPrivacy ?? "private";
        // Shorts are ordinary uploads — ensure #Shorts is in the description.
        let description = p.description;
        if (p.short && !/#shorts\b/i.test(description)) {
          description = `${description}\n\n#Shorts`.trim();
        }

        // Step 1: Initiate resumable upload
        const initResp = await fetch(
          `https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${r.resolved.accessToken}`,
              "Content-Type": "application/json",
              "X-Upload-Content-Length": String(fileStat.size),
              "X-Upload-Content-Type": "video/*",
            },
            body: JSON.stringify({
              snippet: {
                title: p.title.slice(0, 100),
                description: description.slice(0, 5000),
                tags: p.tags,
                categoryId: p.categoryId ?? "22",
                defaultLanguage: p.language ?? "en",
              },
              status: {
                privacyStatus: privacy,
                selfDeclaredMadeForKids: p.madeForKids ?? false,
                ...(p.publishAt ? { publishAt: p.publishAt } : {}),
              },
            }),
          },
        );
        if (!initResp.ok) return { error: `[EYOUTUBE] Upload init failed: ${initResp.status}` };
        const uploadUrl = initResp.headers.get("location");
        if (!uploadUrl) return { error: "[EYOUTUBE] No upload URL returned." };

        // Step 2: Upload the file
        const uploadResp = await fetch(uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": "video/*", "Content-Length": String(fileStat.size) },
          body: fileData,
        });
        if (!uploadResp.ok) return { error: `[EYOUTUBE] Upload failed: ${uploadResp.status}` };
        const video = await uploadResp.json() as { id?: string };
        const videoId = video.id ?? "unknown";

        return {
          content: `Uploaded video "${p.title}" → ${videoId} (${privacy}).`,
          data: { videoId, videoUrl: `https://www.youtube.com/watch?v=${videoId}`, studioUrl: `https://studio.youtube.com/video/${videoId}/edit`, privacy },
        };
      } catch (err) { return { error: `[EYOUTUBE] ${(err as Error).message}` }; }
    });

    ctx.tools.register("youtube_post_comment", {
      displayName: "Post a comment on a YouTube video",
      description: "Post a top-level comment on a video as the channel. Cannot pin (API limitation).",
      parametersSchema: { type: "object", properties: { account: { type: "string" }, videoId: { type: "string" }, text: { type: "string" } }, required: ["videoId", "text"] },
    }, async (params, runCtx): Promise<ToolResult> => {
      const p = params as { account?: string; videoId: string; text: string };
      const r = await resolveAccount(ctx, runCtx, p.account);
      if (!r.ok) return { error: r.error };

      try {
        const data = await ytApi(r.resolved.accessToken, "/commentThreads?part=snippet", "POST", {
          snippet: { videoId: p.videoId, topLevelComment: { snippet: { textOriginal: p.text } } },
        }) as { id?: string; snippet?: { topLevelComment?: { id?: string } } };
        const commentId = data.snippet?.topLevelComment?.id ?? data.id;
        return {
          content: `Posted comment on ${p.videoId}. NOTE: pin it manually in Studio (API can't pin).`,
          data: { commentId, videoId: p.videoId, pinned: false, studioUrl: `https://studio.youtube.com/video/${p.videoId}/comments`, note: "YouTube API cannot pin comments — pin manually in Studio (one tap)." },
        };
      } catch (err) { return { error: `[EYOUTUBE] ${(err as Error).message}` }; }
    });

    ctx.tools.register("youtube_set_thumbnail", {
      displayName: "Set YouTube thumbnail",
      description: "Upload a custom thumbnail for a video.",
      parametersSchema: { type: "object", properties: { account: { type: "string" }, videoId: { type: "string" }, filePath: { type: "string" } }, required: ["videoId", "filePath"] },
    }, async (params, runCtx): Promise<ToolResult> => {
      const p = params as { account?: string; videoId: string; filePath: string };
      const r = await resolveAccount(ctx, runCtx, p.account);
      if (!r.ok) return { error: r.error };

      try {
        const fileData = await fs.readFile(p.filePath);
        const ext = path.extname(p.filePath).toLowerCase();
        const mime = ext === ".png" ? "image/png" : "image/jpeg";
        const resp = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${p.videoId}`, {
          method: "POST", headers: { Authorization: `Bearer ${r.resolved.accessToken}`, "Content-Type": mime }, body: fileData,
        });
        if (!resp.ok) return { error: `[EYOUTUBE] Thumbnail upload failed: ${resp.status}` };
        return { content: `Thumbnail set for video ${p.videoId}.`, data: { ok: true } };
      } catch (err) { return { error: `[EYOUTUBE] ${(err as Error).message}` }; }
    });

    ctx.tools.register("youtube_add_to_playlist", {
      displayName: "Add to YouTube playlist",
      description: "Add a video to a playlist.",
      parametersSchema: { type: "object", properties: { account: { type: "string" }, videoId: { type: "string" }, playlistId: { type: "string" }, position: { type: "number" } }, required: ["videoId", "playlistId"] },
    }, async (params, runCtx): Promise<ToolResult> => {
      const p = params as { account?: string; videoId: string; playlistId: string; position?: number };
      const r = await resolveAccount(ctx, runCtx, p.account);
      if (!r.ok) return { error: r.error };

      try {
        const body: Record<string, unknown> = { snippet: { playlistId: p.playlistId, resourceId: { kind: "youtube#video", videoId: p.videoId } } };
        if (p.position !== undefined) (body.snippet as Record<string, unknown>).position = p.position;
        const data = await ytApi(r.resolved.accessToken, "/playlistItems?part=snippet", "POST", body);
        return { content: `Added ${p.videoId} to playlist ${p.playlistId}.`, data: { playlistItemId: (data as { id?: string }).id } };
      } catch (err) { return { error: `[EYOUTUBE] ${(err as Error).message}` }; }
    });

    ctx.tools.register("youtube_update_metadata", {
      displayName: "Update YouTube video metadata",
      description: "Update title, description, tags, or privacy.",
      parametersSchema: { type: "object", properties: { account: { type: "string" }, videoId: { type: "string" }, title: { type: "string" }, description: { type: "string" }, tags: { type: "array", items: { type: "string" } }, categoryId: { type: "string" }, privacy: { type: "string" } }, required: ["videoId"] },
    }, async (params, runCtx): Promise<ToolResult> => {
      const p = params as { account?: string; videoId: string; title?: string; description?: string; tags?: string[]; categoryId?: string; privacy?: string };
      const r = await resolveAccount(ctx, runCtx, p.account);
      if (!r.ok) return { error: r.error };

      try {
        const parts: string[] = [];
        const body: Record<string, unknown> = { id: p.videoId };
        if (p.title || p.description || p.tags || p.categoryId) {
          parts.push("snippet");
          body.snippet = { ...(p.title ? { title: p.title } : {}), ...(p.description ? { description: p.description } : {}), ...(p.tags ? { tags: p.tags } : {}), ...(p.categoryId ? { categoryId: p.categoryId } : {}) };
        }
        if (p.privacy) { parts.push("status"); body.status = { privacyStatus: p.privacy }; }
        if (parts.length === 0) return { error: "[EINVALID_INPUT] Nothing to update." };

        const data = await ytApi(r.resolved.accessToken, `/videos?part=${parts.join(",")}`, "PUT", body);
        return { content: `Updated metadata for ${p.videoId}.`, data };
      } catch (err) { return { error: `[EYOUTUBE] ${(err as Error).message}` }; }
    });

    ctx.tools.register("youtube_get_video", {
      displayName: "Get YouTube video info",
      description: "Retrieve metadata and processing status of a video.",
      parametersSchema: { type: "object", properties: { account: { type: "string" }, videoId: { type: "string" } }, required: ["videoId"] },
    }, async (params, runCtx): Promise<ToolResult> => {
      const p = params as { account?: string; videoId: string };
      const r = await resolveAccount(ctx, runCtx, p.account);
      if (!r.ok) return { error: r.error };

      try {
        const data = await ytApi(r.resolved.accessToken, `/videos?part=snippet,status,statistics,processingDetails&id=${p.videoId}`);
        const items = (data as { items?: unknown[] }).items ?? [];
        if (items.length === 0) return { error: `[EYOUTUBE] Video ${p.videoId} not found.` };
        return { content: `Retrieved info for ${p.videoId}.`, data: items[0] };
      } catch (err) { return { error: `[EYOUTUBE] ${(err as Error).message}` }; }
    });
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
