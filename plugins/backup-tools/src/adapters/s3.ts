/**
 * S3-compatible destination adapter.
 *
 * Works against AWS S3, Cloudflare R2, Backblaze B2, Wasabi, MinIO — any
 * provider exposing the standard S3 API. Pure JS (`@aws-sdk/client-s3` +
 * `@aws-sdk/lib-storage` for streaming multipart uploads).
 */

import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { Readable } from "node:stream";
import type {
  BackupDestinationAdapter,
  DestinationObject,
  HealthCheckResult,
  ListOptions,
} from "./types.js";
import { adapterError } from "./types.js";

export type S3AdapterConfig = {
  endpoint?: string;
  region: string;
  bucket: string;
  prefix?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
  serverSideEncryption?: "" | "AES256" | "aws:kms";
};

export class S3Adapter implements BackupDestinationAdapter {
  readonly kind = "s3" as const;
  readonly destinationId: string;
  readonly label: string;
  private readonly client: S3Client;
  private readonly cfg: S3AdapterConfig;

  constructor(input: { destinationId: string; label: string; config: S3AdapterConfig }) {
    this.destinationId = input.destinationId;
    this.label = input.label;
    this.cfg = input.config;
    this.client = new S3Client({
      region: input.config.region,
      endpoint: input.config.endpoint || undefined,
      forcePathStyle: input.config.forcePathStyle === true,
      credentials: {
        accessKeyId: input.config.accessKeyId,
        secretAccessKey: input.config.secretAccessKey,
      },
    });
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const probeKey = `${this.cfg.prefix ?? ""}_health-check-${Date.now()}.txt`;
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.cfg.bucket,
          Key: probeKey,
          Body: "paperclip backup-tools health probe",
          ContentType: "text/plain",
        }),
      );
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.cfg.bucket,
          Delete: { Objects: [{ Key: probeKey }] },
        }),
      );
      return {
        ok: true,
        details: {
          bucket: this.cfg.bucket,
          region: this.cfg.region,
          endpoint: this.cfg.endpoint || "(default AWS)",
        },
      };
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
        details: { bucket: this.cfg.bucket, region: this.cfg.region },
      };
    }
  }

  async list(options?: ListOptions): Promise<DestinationObject[]> {
    const prefix = options?.prefix ?? this.cfg.prefix ?? "";
    try {
      const out: DestinationObject[] = [];
      let continuationToken: string | undefined;
      do {
        const resp = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.cfg.bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
            MaxKeys: options?.limit && options.limit < 1000 ? options.limit : 1000,
          }),
        );
        for (const obj of resp.Contents ?? []) {
          if (!obj.Key) continue;
          out.push({
            key: obj.Key,
            sizeBytes: obj.Size,
            lastModified: obj.LastModified?.toISOString(),
          });
          if (options?.limit && out.length >= options.limit) return out;
        }
        continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
      } while (continuationToken);
      return out;
    } catch (err) {
      throw adapterError(this.kind, "EBACKUP_DEST_UNREACHABLE", err);
    }
  }

  async upload(key: string, body: NodeJS.ReadableStream, sizeHint?: number): Promise<void> {
    try {
      const sse = this.cfg.serverSideEncryption;
      // The aws-sdk Upload helper accepts Node Readable; the caller passes
      // a NodeJS.ReadableStream which is the broader type. They're equivalent
      // at runtime — cast to satisfy the SDK's narrow type.
      const upload = new Upload({
        client: this.client,
        params: {
          Bucket: this.cfg.bucket,
          Key: key,
          Body: body as unknown as Readable,
          ContentType: "application/octet-stream",
          ServerSideEncryption: sse && sse.length > 0 ? sse : undefined,
        },
        // 8 MiB parts; 4 in flight. Reasonable for slow links + reasonable on
        // memory.
        partSize: 8 * 1024 * 1024,
        queueSize: 4,
        leavePartsOnError: false,
      });
      await upload.done();
    } catch (err) {
      // Distinguish quota / size-limit errors from generic failures.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("EntityTooLarge") || msg.includes("QuotaExceeded")) {
        throw adapterError(this.kind, "EBACKUP_DEST_QUOTA", err);
      }
      throw adapterError(this.kind, "EBACKUP_UPLOAD_FAILED", err);
    }
  }

  async download(key: string): Promise<NodeJS.ReadableStream> {
    try {
      const resp = await this.client.send(
        new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }),
      );
      const body = resp.Body;
      if (!body) throw new Error("empty response body");
      // SDK returns a web ReadableStream in some envs; coerce.
      if (body instanceof Readable) return body;
      const maybeWeb = body as unknown as { transformToWebStream?: () => unknown };
      if (typeof maybeWeb.transformToWebStream === "function") {
        return Readable.fromWeb(maybeWeb.transformToWebStream() as never);
      }
      // Fallback — assume already a Node Readable.
      return body as unknown as NodeJS.ReadableStream;
    } catch (err) {
      throw adapterError(this.kind, "EBACKUP_DOWNLOAD_FAILED", err);
    }
  }

  async downloadHead(key: string, bytes = 64 * 1024): Promise<Uint8Array> {
    try {
      const resp = await this.client.send(
        new GetObjectCommand({
          Bucket: this.cfg.bucket,
          Key: key,
          Range: `bytes=0-${bytes - 1}`,
        }),
      );
      const body = resp.Body;
      if (!body) throw new Error("empty response body");
      // Read up to `bytes` from the stream.
      const chunks: Uint8Array[] = [];
      const stream = body instanceof Readable ? body : (body as unknown as NodeJS.ReadableStream);
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
    if (keys.length === 0) return;
    try {
      // S3 accepts up to 1000 keys per DeleteObjects request.
      for (let i = 0; i < keys.length; i += 1000) {
        const slice = keys.slice(i, i + 1000);
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.cfg.bucket,
            Delete: { Objects: slice.map((Key) => ({ Key })) },
          }),
        );
      }
    } catch (err) {
      throw adapterError(this.kind, "EBACKUP_DELETE_FAILED", err);
    }
  }

  // Unused but kept for future debug tooling.
  async statHead(key: string): Promise<{ exists: boolean; sizeBytes?: number }> {
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key }),
      );
      return { exists: true, sizeBytes: head.ContentLength };
    } catch {
      return { exists: false };
    }
  }
}
