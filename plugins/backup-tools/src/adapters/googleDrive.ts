/**
 * Google Drive destination adapter.
 *
 * Uses the `googleapis` npm package (pure JS). Scopes: drive.file (the plugin
 * can only see/modify files it created — narrowest possible).
 *
 * Resumable uploads are used for >5 MB bodies so a transient network failure
 * doesn't waste the whole upload.
 */

import { google, drive_v3 } from "googleapis";
import { Readable } from "node:stream";

import type {
  BackupDestinationAdapter,
  DestinationObject,
  HealthCheckResult,
  ListOptions,
} from "./types.js";
import { adapterError } from "./types.js";

export type GoogleDriveAdapterConfig = {
  oauthClientId: string;
  oauthClientSecret: string;
  oauthRefreshToken: string;
  folderId: string;
  sharedDriveId?: string;
};

export class GoogleDriveAdapter implements BackupDestinationAdapter {
  readonly kind = "google-drive" as const;
  readonly destinationId: string;
  readonly label: string;
  private readonly oauth2: InstanceType<typeof google.auth.OAuth2>;
  private readonly drive: drive_v3.Drive;
  private readonly cfg: GoogleDriveAdapterConfig;

  constructor(input: { destinationId: string; label: string; config: GoogleDriveAdapterConfig }) {
    this.destinationId = input.destinationId;
    this.label = input.label;
    this.cfg = input.config;
    this.oauth2 = new google.auth.OAuth2(input.config.oauthClientId, input.config.oauthClientSecret);
    this.oauth2.setCredentials({ refresh_token: input.config.oauthRefreshToken });
    this.drive = google.drive({ version: "v3", auth: this.oauth2 });
  }

  private supportsAllDrives() {
    return Boolean(this.cfg.sharedDriveId);
  }

  async healthCheck(): Promise<HealthCheckResult> {
    try {
      // Verify we can list the configured folder. Cheap and credential-validating.
      await this.drive.files.list({
        q: `'${this.cfg.folderId.replaceAll("'", "\\'")}' in parents and trashed = false`,
        pageSize: 1,
        fields: "files(id, name)",
        supportsAllDrives: this.supportsAllDrives(),
        includeItemsFromAllDrives: this.supportsAllDrives(),
        driveId: this.cfg.sharedDriveId,
        corpora: this.cfg.sharedDriveId ? "drive" : undefined,
      });
      return { ok: true, details: { folderId: this.cfg.folderId } };
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
        details: { folderId: this.cfg.folderId },
      };
    }
  }

  async list(options?: ListOptions): Promise<DestinationObject[]> {
    try {
      const out: DestinationObject[] = [];
      let pageToken: string | undefined;
      const folderClause = `'${this.cfg.folderId.replaceAll("'", "\\'")}' in parents and trashed = false`;
      const prefixClause = options?.prefix ? ` and name contains '${options.prefix.replaceAll("'", "\\'")}'` : "";
      do {
        const resp = await this.drive.files.list({
          q: folderClause + prefixClause,
          fields: "nextPageToken, files(id, name, size, modifiedTime)",
          pageSize: 1000,
          pageToken,
          supportsAllDrives: this.supportsAllDrives(),
          includeItemsFromAllDrives: this.supportsAllDrives(),
          driveId: this.cfg.sharedDriveId,
          corpora: this.cfg.sharedDriveId ? "drive" : undefined,
        });
        for (const f of resp.data.files ?? []) {
          if (!f.id || !f.name) continue;
          // We use file id as the "key" since Drive uses opaque ids, not paths.
          out.push({
            key: f.id,
            sizeBytes: f.size ? Number(f.size) : undefined,
            lastModified: f.modifiedTime ?? undefined,
          });
          if (options?.limit && out.length >= options.limit) return out;
        }
        pageToken = resp.data.nextPageToken ?? undefined;
      } while (pageToken);
      return out;
    } catch (err) {
      throw adapterError(this.kind, "EBACKUP_DEST_UNREACHABLE", err);
    }
  }

  async upload(key: string, body: NodeJS.ReadableStream, sizeHint?: number): Promise<void> {
    try {
      // For Drive, `key` from our perspective is a fresh filename to use.
      // The actual stored "key" returned by .list() is the Drive file id.
      // Caller should round-trip name → id via list() if needed.
      await this.drive.files.create({
        requestBody: {
          name: key,
          parents: [this.cfg.folderId],
        },
        media: {
          mimeType: "application/octet-stream",
          body: body as unknown as NodeJS.ReadableStream,
        },
        supportsAllDrives: this.supportsAllDrives(),
        fields: "id",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("storageQuotaExceeded") || msg.includes("quotaExceeded")) {
        throw adapterError(this.kind, "EBACKUP_DEST_QUOTA", err);
      }
      throw adapterError(this.kind, "EBACKUP_UPLOAD_FAILED", err);
    }
  }

  async download(key: string): Promise<NodeJS.ReadableStream> {
    try {
      const resp = await this.drive.files.get(
        {
          fileId: key,
          alt: "media",
          supportsAllDrives: this.supportsAllDrives(),
        },
        { responseType: "stream" },
      );
      return resp.data as unknown as NodeJS.ReadableStream;
    } catch (err) {
      throw adapterError(this.kind, "EBACKUP_DOWNLOAD_FAILED", err);
    }
  }

  async downloadHead(key: string, bytes = 64 * 1024): Promise<Uint8Array> {
    try {
      const resp = await this.drive.files.get(
        {
          fileId: key,
          alt: "media",
          supportsAllDrives: this.supportsAllDrives(),
        },
        {
          responseType: "stream",
          headers: { Range: `bytes=0-${bytes - 1}` },
        },
      );
      const stream = resp.data as unknown as Readable;
      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
        chunks.push(chunk);
        total += chunk.byteLength;
        if (total >= bytes) break;
      }
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.byteLength;
      }
      return out;
    } catch (err) {
      throw adapterError(this.kind, "EBACKUP_DOWNLOAD_FAILED", err);
    }
  }

  async delete(keys: string[]): Promise<void> {
    for (const key of keys) {
      try {
        await this.drive.files.delete({
          fileId: key,
          supportsAllDrives: this.supportsAllDrives(),
        });
      } catch (err) {
        throw adapterError(this.kind, "EBACKUP_DELETE_FAILED", err);
      }
    }
  }
}
