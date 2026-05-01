import {
  type PluginContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { drive as driveApi } from "@googleapis/drive";
import {
  ensureMutationsAllowed,
  getGoogleAccount,
  type InstanceConfig,
  wrapGoogleError,
} from "../googleAuth.js";
import { DRIVE_TOOLS } from "../schemas.js";
import { track } from "../telemetry.js";
import { getCached, putCached } from "../idempotency.js";
import { Readable } from "node:stream";
import { createReadStream, statSync } from "node:fs";
import { lookup as mimeLookup } from "mime-types";
import { extname } from "node:path";

function findSchema(name: string) {
  const s = DRIVE_TOOLS.find((t) => t.name === name);
  if (!s) throw new Error(`drive schema missing: ${name}`);
  return s;
}

const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";

const DEFAULT_FILE_FIELDS = "id, name, mimeType, modifiedTime, parents, webViewLink, size";

export function registerDriveTools(ctx: PluginContext): void {
  // ---- gdrive_list_folder ----
  {
    const schema = findSchema("gdrive_list_folder");
    ctx.tools.register(
      schema.name,
      {
        displayName: schema.displayName,
        description: schema.description,
        parametersSchema: schema.parametersSchema,
      },
      async (params, runCtx: ToolRunContext): Promise<ToolResult> => {
        const p = (params ?? {}) as {
          account?: string;
          folderId?: string;
          query?: string;
          pageSize?: number;
          pageToken?: string;
        };
        if (!p.folderId) return { error: "[EINVALID_INPUT] `folderId` is required" };
        try {
          const resolved = await getGoogleAccount(ctx, runCtx, "gdrive_list_folder", p.account);
          const drive = driveApi({ version: "v3", auth: resolved.oauth2Client });
          const baseQuery = `'${p.folderId.replace(/'/g, "\\'")}' in parents and trashed = false`;
          const q = p.query ? `${baseQuery} and (${p.query})` : baseQuery;
          const res = await drive.files.list({
            q,
            pageSize: p.pageSize ?? 100,
            pageToken: p.pageToken,
            fields: `nextPageToken, files(${DEFAULT_FILE_FIELDS})`,
            orderBy: "name",
          });
          const files = res.data.files ?? [];
          await track(ctx, runCtx, "gdrive_list_folder", resolved.accountKey, {
            count: files.length,
          });
          return {
            content: `Found ${files.length} item(s) in folder ${p.folderId}.`,
            data: { files, nextPageToken: res.data.nextPageToken ?? null },
          };
        } catch (err) {
          return { error: wrapGoogleError(err) };
        }
      },
    );
  }

  // ---- gdrive_search ----
  {
    const schema = findSchema("gdrive_search");
    ctx.tools.register(
      schema.name,
      {
        displayName: schema.displayName,
        description: schema.description,
        parametersSchema: schema.parametersSchema,
      },
      async (params, runCtx: ToolRunContext): Promise<ToolResult> => {
        const p = (params ?? {}) as {
          account?: string;
          query?: string;
          pageSize?: number;
          pageToken?: string;
        };
        if (!p.query) return { error: "[EINVALID_INPUT] `query` is required" };
        try {
          const resolved = await getGoogleAccount(ctx, runCtx, "gdrive_search", p.account);
          const drive = driveApi({ version: "v3", auth: resolved.oauth2Client });
          const res = await drive.files.list({
            q: p.query,
            pageSize: p.pageSize ?? 50,
            pageToken: p.pageToken,
            fields: `nextPageToken, files(${DEFAULT_FILE_FIELDS})`,
            orderBy: "modifiedTime desc",
          });
          const files = res.data.files ?? [];
          await track(ctx, runCtx, "gdrive_search", resolved.accountKey, {
            count: files.length,
          });
          return {
            content: `Found ${files.length} file(s) matching query.`,
            data: { files, nextPageToken: res.data.nextPageToken ?? null },
          };
        } catch (err) {
          return { error: wrapGoogleError(err) };
        }
      },
    );
  }

  // ---- gdrive_get_file_metadata ----
  {
    const schema = findSchema("gdrive_get_file_metadata");
    ctx.tools.register(
      schema.name,
      {
        displayName: schema.displayName,
        description: schema.description,
        parametersSchema: schema.parametersSchema,
      },
      async (params, runCtx: ToolRunContext): Promise<ToolResult> => {
        const p = (params ?? {}) as { account?: string; fileId?: string };
        if (!p.fileId) return { error: "[EINVALID_INPUT] `fileId` is required" };
        try {
          const resolved = await getGoogleAccount(
            ctx,
            runCtx,
            "gdrive_get_file_metadata",
            p.account,
          );
          const drive = driveApi({ version: "v3", auth: resolved.oauth2Client });
          const res = await drive.files.get({
            fileId: p.fileId,
            fields: DEFAULT_FILE_FIELDS,
          });
          await track(ctx, runCtx, "gdrive_get_file_metadata", resolved.accountKey);
          return {
            content: `File: ${res.data.name ?? p.fileId}.`,
            data: { file: res.data },
          };
        } catch (err) {
          return { error: wrapGoogleError(err) };
        }
      },
    );
  }

  // ---- gdrive_create_folder (mutation) ----
  {
    const schema = findSchema("gdrive_create_folder");
    ctx.tools.register(
      schema.name,
      {
        displayName: schema.displayName,
        description: schema.description,
        parametersSchema: schema.parametersSchema,
      },
      async (params, runCtx: ToolRunContext): Promise<ToolResult> => {
        const p = (params ?? {}) as {
          account?: string;
          name?: string;
          parentFolderId?: string;
          idempotencyKey?: string;
        };
        if (!p.name) return { error: "[EINVALID_INPUT] `name` is required" };

        const config = (await ctx.config.get()) as InstanceConfig;
        try {
          ensureMutationsAllowed(ctx, config, "gdrive_create_folder");
        } catch (err) {
          return { error: (err as Error).message };
        }

        try {
          const resolved = await getGoogleAccount(ctx, runCtx, "gdrive_create_folder", p.account);
          const cached = getCached(runCtx.companyId, "gdrive_create_folder", p.idempotencyKey);
          if (cached) return cached;

          const drive = driveApi({ version: "v3", auth: resolved.oauth2Client });
          const res = await drive.files.create({
            requestBody: {
              name: p.name,
              mimeType: DRIVE_FOLDER_MIME,
              parents: p.parentFolderId ? [p.parentFolderId] : undefined,
            },
            fields: DEFAULT_FILE_FIELDS,
          });
          await track(ctx, runCtx, "gdrive_create_folder", resolved.accountKey);
          const out: ToolResult = {
            content: `Folder created: ${res.data.name} (${res.data.id}).`,
            data: { folder: res.data },
          };
          putCached(runCtx.companyId, "gdrive_create_folder", p.idempotencyKey, out);
          return out;
        } catch (err) {
          return { error: wrapGoogleError(err) };
        }
      },
    );
  }

  // ---- gdrive_upload_file (mutation) ----
  {
    const schema = findSchema("gdrive_upload_file");
    ctx.tools.register(
      schema.name,
      {
        displayName: schema.displayName,
        description: schema.description,
        parametersSchema: schema.parametersSchema,
      },
      async (params, runCtx: ToolRunContext): Promise<ToolResult> => {
        const p = (params ?? {}) as {
          account?: string;
          name?: string;
          parentFolderId?: string;
          mimeType?: string;
          content?: string;
          localPath?: string;
          idempotencyKey?: string;
        };
        if (!p.name) return { error: "[EINVALID_INPUT] `name` is required" };
        if (!p.content && !p.localPath) {
          return { error: "[EINVALID_INPUT] one of `content` (base64) or `localPath` is required" };
        }
        if (p.content && p.localPath) {
          return { error: "[EINVALID_INPUT] only one of `content` and `localPath` may be set" };
        }

        const config = (await ctx.config.get()) as InstanceConfig;
        try {
          ensureMutationsAllowed(ctx, config, "gdrive_upload_file");
        } catch (err) {
          return { error: (err as Error).message };
        }

        try {
          const resolved = await getGoogleAccount(ctx, runCtx, "gdrive_upload_file", p.account);
          const cached = getCached(runCtx.companyId, "gdrive_upload_file", p.idempotencyKey);
          if (cached) return cached;

          const drive = driveApi({ version: "v3", auth: resolved.oauth2Client });

          let body: NodeJS.ReadableStream;
          let resolvedMime = p.mimeType;

          if (p.localPath) {
            try {
              statSync(p.localPath);
            } catch {
              return { error: `[EINVALID_INPUT] localPath does not exist: ${p.localPath}` };
            }
            body = createReadStream(p.localPath);
            if (!resolvedMime) {
              const ext = extname(p.localPath);
              const guessed = ext ? mimeLookup(ext) : false;
              resolvedMime = (guessed && typeof guessed === "string" ? guessed : "application/octet-stream");
            }
          } else {
            const buf = Buffer.from(p.content!, "base64");
            body = Readable.from(buf);
            if (!resolvedMime) {
              const ext = extname(p.name);
              const guessed = ext ? mimeLookup(ext) : false;
              resolvedMime = (guessed && typeof guessed === "string" ? guessed : "application/octet-stream");
            }
          }

          const res = await drive.files.create({
            requestBody: {
              name: p.name,
              mimeType: resolvedMime,
              parents: p.parentFolderId ? [p.parentFolderId] : undefined,
            },
            media: { mimeType: resolvedMime, body },
            fields: DEFAULT_FILE_FIELDS,
          });

          await track(ctx, runCtx, "gdrive_upload_file", resolved.accountKey, {
            mimeType: resolvedMime,
          });
          const out: ToolResult = {
            content: `File uploaded: ${res.data.name} (${res.data.id}).`,
            data: { file: res.data },
          };
          putCached(runCtx.companyId, "gdrive_upload_file", p.idempotencyKey, out);
          return out;
        } catch (err) {
          return { error: wrapGoogleError(err) };
        }
      },
    );
  }
}
