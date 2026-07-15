import {
  definePlugin,
  runWorker,
  type PluginContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Upload } from "@aws-sdk/lib-storage";
import { createReadStream, createWriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";

type BucketConfig = {
  key: string;
  displayName?: string;
  bucketName: string;
  region?: string;
  endpoint?: string;
  accessKeyRef: string;
  secretKeyRef: string;
  allowedCompanies: string[];
};

type InstanceConfig = {
  defaultBucket?: string;
  buckets?: BucketConfig[];
};

type ResolvedBucket = {
  config: BucketConfig;
  client: S3Client;
  bucketKey: string;
};

async function resolveBucket(
  ctx: PluginContext,
  runCtx: ToolRunContext,
  toolName: string,
  bucketKey: string | undefined,
): Promise<{ ok: true; resolved: ResolvedBucket } | { ok: false; error: string }> {
  const rawConfig = (await ctx.config.get()) as InstanceConfig;
  const buckets = rawConfig.buckets ?? [];

  const key = bucketKey ?? rawConfig.defaultBucket;
  if (!key) return { ok: false, error: `[ECONFIG] No bucket specified and no defaultBucket configured.` };

  const config = buckets.find((b) => b.key === key);
  if (!config) return { ok: false, error: `[ECONFIG] Bucket "${key}" not configured. Available: ${buckets.map((b) => b.key).join(", ") || "(none)"}` };

  const allowed = config.allowedCompanies ?? [];
  if (allowed.length > 0 && !allowed.includes("*") && !allowed.includes(runCtx.companyId)) {
    return { ok: false, error: `[ECOMPANY_NOT_ALLOWED] Company ${runCtx.companyId} is not in the allowed list for bucket "${key}".` };
  }

  const accessKeyId = await ctx.secrets.resolve(config.accessKeyRef);
  const secretAccessKey = await ctx.secrets.resolve(config.secretKeyRef);
  if (!accessKeyId || !secretAccessKey) return { ok: false, error: `[ECONFIG] Could not resolve AWS credentials for bucket "${key}".` };

  const client = new S3Client({
    region: config.region || "us-east-1",
    ...(config.endpoint ? { endpoint: config.endpoint, forcePathStyle: true } : {}),
    credentials: { accessKeyId, secretAccessKey },
  });

  return { ok: true, resolved: { config, client, bucketKey: key } };
}

function mimeFromExt(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".json": "application/json", ".pdf": "application/pdf", ".epub": "application/epub+zip",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif",
    ".webp": "image/webp", ".svg": "image/svg+xml", ".mp3": "audio/mpeg", ".mp4": "video/mp4",
    ".csv": "text/csv", ".txt": "text/plain", ".html": "text/html", ".xml": "application/xml",
    ".zip": "application/zip", ".gz": "application/gzip",
  };
  return map[ext] ?? "application/octet-stream";
}

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    ctx.logger.info("s3-tools plugin setup");

    ctx.tools.register("s3_list", {
      displayName: "List S3 objects",
      description: "List objects in an S3 bucket path.",
      parametersSchema: { type: "object", properties: { bucket: { type: "string" }, prefix: { type: "string" }, maxKeys: { type: "number" }, recursive: { type: "boolean" } } },
    }, async (params, runCtx): Promise<ToolResult> => {
      const p = params as { bucket?: string; prefix?: string; maxKeys?: number; recursive?: boolean };
      const r = await resolveBucket(ctx, runCtx, "s3_list", p.bucket);
      if (!r.ok) return { error: r.error };

      const maxKeys = Math.min(Math.max(p.maxKeys ?? 100, 1), 1000);
      const prefix = p.prefix ?? "";
      const delimiter = p.recursive === false ? "/" : undefined;

      try {
        const resp = await r.resolved.client.send(new ListObjectsV2Command({
          Bucket: r.resolved.config.bucketName, Prefix: prefix, MaxKeys: maxKeys, Delimiter: delimiter,
        }));
        const objects = (resp.Contents ?? []).map((o) => ({
          key: o.Key, size: o.Size, lastModified: o.LastModified?.toISOString(), etag: o.ETag,
        }));
        return { content: `Listed ${objects.length} object(s) in ${r.resolved.bucketKey}/${prefix}`, data: { objects, truncated: !!resp.IsTruncated } };
      } catch (err) { return { error: `[ES3] ${(err as Error).message}` }; }
    });

    ctx.tools.register("s3_download", {
      displayName: "Download from S3",
      description: "Download files from S3 to a local directory.",
      parametersSchema: { type: "object", properties: { bucket: { type: "string" }, s3Key: { type: "string" }, s3Prefix: { type: "string" }, localPath: { type: "string" }, overwrite: { type: "boolean" }, fileTypes: { type: "string" }, maxFiles: { type: "number" } }, required: ["localPath"] },
    }, async (params, runCtx): Promise<ToolResult> => {
      const p = params as { bucket?: string; s3Key?: string; s3Prefix?: string; localPath: string; overwrite?: boolean; fileTypes?: string; maxFiles?: number };
      const r = await resolveBucket(ctx, runCtx, "s3_download", p.bucket);
      if (!r.ok) return { error: r.error };

      const maxFiles = Math.min(p.maxFiles ?? 50, 500);
      const allowedExts = p.fileTypes ? p.fileTypes.split(",").map((e) => `.${e.trim().toLowerCase()}`) : null;
      const results: Array<{ key: string; localFile: string; status: string }> = [];

      try {
        let keys: string[] = [];
        if (p.s3Key) {
          keys = [p.s3Key];
        } else {
          const resp = await r.resolved.client.send(new ListObjectsV2Command({ Bucket: r.resolved.config.bucketName, Prefix: p.s3Prefix ?? "", MaxKeys: maxFiles }));
          keys = (resp.Contents ?? []).map((o) => o.Key!).filter(Boolean);
        }

        for (const key of keys.slice(0, maxFiles)) {
          if (allowedExts && !allowedExts.some((ext) => key.toLowerCase().endsWith(ext))) continue;
          const relativePath = p.s3Prefix ? key.slice(p.s3Prefix.length) : key;
          const localFile = path.join(p.localPath, relativePath);

          if (!p.overwrite) {
            try { await fs.access(localFile); results.push({ key, localFile, status: "skipped" }); continue; } catch { /* does not exist */ }
          }

          await fs.mkdir(path.dirname(localFile), { recursive: true });
          const resp = await r.resolved.client.send(new GetObjectCommand({ Bucket: r.resolved.config.bucketName, Key: key }));
          const ws = createWriteStream(localFile);
          await pipeline(resp.Body as Readable, ws);
          results.push({ key, localFile, status: "downloaded" });
        }
        const downloaded = results.filter((r) => r.status === "downloaded").length;
        return { content: `Downloaded ${downloaded} file(s) from ${r.resolved.bucketKey}.`, data: { results } };
      } catch (err) { return { error: `[ES3] ${(err as Error).message}` }; }
    });

    ctx.tools.register("s3_upload", {
      displayName: "Upload to S3",
      description: "Upload local files to S3.",
      parametersSchema: { type: "object", properties: { bucket: { type: "string" }, localPath: { type: "string" }, s3Prefix: { type: "string" }, overwrite: { type: "boolean" }, storageClass: { type: "string" }, contentType: { type: "string" }, maxFiles: { type: "number" } }, required: ["localPath"] },
    }, async (params, runCtx): Promise<ToolResult> => {
      const p = params as { bucket?: string; localPath: string; s3Prefix?: string; overwrite?: boolean; storageClass?: string; contentType?: string; maxFiles?: number };
      const r = await resolveBucket(ctx, runCtx, "s3_upload", p.bucket);
      if (!r.ok) return { error: r.error };

      const maxFiles = Math.min(p.maxFiles ?? 50, 500);
      const results: Array<{ localFile: string; s3Key: string; status: string }> = [];

      try {
        const stat = await fs.stat(p.localPath);
        let files: string[] = [];
        if (stat.isFile()) {
          files = [p.localPath];
        } else {
          const walk = async (dir: string): Promise<string[]> => {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            const out: string[] = [];
            for (const e of entries) {
              const full = path.join(dir, e.name);
              if (e.isDirectory()) out.push(...await walk(full));
              else out.push(full);
            }
            return out;
          };
          files = await walk(p.localPath);
        }

        for (const file of files.slice(0, maxFiles)) {
          const relative = stat.isFile() ? path.basename(file) : path.relative(p.localPath, file);
          const s3Key = (p.s3Prefix ?? "") + relative.replace(/\\/g, "/");

          if (!p.overwrite) {
            try {
              await r.resolved.client.send(new HeadObjectCommand({ Bucket: r.resolved.config.bucketName, Key: s3Key }));
              results.push({ localFile: file, s3Key, status: "skipped" }); continue;
            } catch { /* does not exist */ }
          }

          const upload = new Upload({
            client: r.resolved.client,
            params: {
              Bucket: r.resolved.config.bucketName, Key: s3Key,
              Body: createReadStream(file),
              ContentType: p.contentType ?? mimeFromExt(file),
              StorageClass: p.storageClass ?? "STANDARD",
            },
          });
          await upload.done();
          results.push({ localFile: file, s3Key, status: "uploaded" });
        }
        const uploaded = results.filter((r) => r.status === "uploaded").length;
        return { content: `Uploaded ${uploaded} file(s) to ${r.resolved.bucketKey}.`, data: { results } };
      } catch (err) { return { error: `[ES3] ${(err as Error).message}` }; }
    });

    ctx.tools.register("s3_delete", {
      displayName: "Delete S3 object",
      description: "Delete objects from S3.",
      parametersSchema: { type: "object", properties: { bucket: { type: "string" }, s3Key: { type: "string" }, s3Keys: { type: "array", items: { type: "string" } } } },
    }, async (params, runCtx): Promise<ToolResult> => {
      const p = params as { bucket?: string; s3Key?: string; s3Keys?: string[] };
      const r = await resolveBucket(ctx, runCtx, "s3_delete", p.bucket);
      if (!r.ok) return { error: r.error };

      const keys = p.s3Keys ?? (p.s3Key ? [p.s3Key] : []);
      if (keys.length === 0) return { error: "[EINVALID_INPUT] Provide s3Key or s3Keys." };

      try {
        if (keys.length === 1) {
          await r.resolved.client.send(new DeleteObjectCommand({ Bucket: r.resolved.config.bucketName, Key: keys[0] }));
        } else {
          await r.resolved.client.send(new DeleteObjectsCommand({
            Bucket: r.resolved.config.bucketName,
            Delete: { Objects: keys.map((k) => ({ Key: k })) },
          }));
        }
        return { content: `Deleted ${keys.length} object(s) from ${r.resolved.bucketKey}.`, data: { deleted: keys } };
      } catch (err) { return { error: `[ES3] ${(err as Error).message}` }; }
    });

    ctx.tools.register("s3_presign", {
      displayName: "Generate S3 presigned URL",
      description: "Generate a temporary presigned URL for an S3 object.",
      parametersSchema: { type: "object", properties: { bucket: { type: "string" }, s3Key: { type: "string" }, operation: { type: "string" }, expiresIn: { type: "number" } }, required: ["s3Key"] },
    }, async (params, runCtx): Promise<ToolResult> => {
      const p = params as { bucket?: string; s3Key: string; operation?: string; expiresIn?: number };
      const r = await resolveBucket(ctx, runCtx, "s3_presign", p.bucket);
      if (!r.ok) return { error: r.error };

      const expiresIn = Math.min(Math.max(p.expiresIn ?? 3600, 60), 604800);
      try {
        const command = p.operation === "putObject"
          ? new PutObjectCommand({ Bucket: r.resolved.config.bucketName, Key: p.s3Key })
          : new GetObjectCommand({ Bucket: r.resolved.config.bucketName, Key: p.s3Key });
        const url = await getSignedUrl(r.resolved.client, command, { expiresIn });
        return { content: `Presigned URL generated for ${p.s3Key} (${expiresIn}s).`, data: { url, expiresIn } };
      } catch (err) { return { error: `[ES3] ${(err as Error).message}` }; }
    });
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
