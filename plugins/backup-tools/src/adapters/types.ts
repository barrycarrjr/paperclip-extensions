/**
 * BackupDestinationAdapter — common interface every destination kind implements.
 *
 * The plugin worker holds one adapter instance per configured destination,
 * keyed by destination.id. All adapters share this shape so the run-backup
 * fan-out code is destination-agnostic.
 */

export type DestinationObject = {
  /** Object key (e.g. an S3 key, a Drive file id, a local relative path). */
  key: string;
  /** Object size in bytes if known. */
  sizeBytes?: number;
  /** Last-modified timestamp if available (ISO 8601). */
  lastModified?: string;
};

export type HealthCheckResult = {
  ok: boolean;
  reason?: string;
  /** Arbitrary diagnostic info shown on the dashboard. */
  details?: Record<string, string | number | boolean>;
};

export type ListOptions = {
  /** Optional remote-side prefix filter (in addition to whatever the adapter is rooted at). */
  prefix?: string;
  /** Cap how many entries are returned. Adapters may ignore. */
  limit?: number;
};

export type RangedReadOptions = {
  start: number;
  end: number; // inclusive
};

export interface BackupDestinationAdapter {
  /** What kind this adapter implements. Used for dashboard icon + error labelling. */
  readonly kind: "s3" | "google-drive" | "local" | "nas-smb";
  /** The configured destination's id. */
  readonly destinationId: string;
  /** Human-readable label from instance config. */
  readonly label: string;

  /**
   * Validate credentials/config by writing a small probe object then deleting it.
   * Used by the dashboard "Run health check" button and on-demand before
   * scheduling a fan-out so we don't queue uploads to a dead destination.
   */
  healthCheck(): Promise<HealthCheckResult>;

  /** List archives at this destination. */
  list(options?: ListOptions): Promise<DestinationObject[]>;

  /**
   * Upload bytes under the given key. The body is a Node Readable; adapter
   * pumps it through to the destination using the provider-native streaming
   * upload API. `sizeHint` is used by adapters that need Content-Length up
   * front; if not known, they fall back to multipart/chunked uploads.
   */
  upload(key: string, body: NodeJS.ReadableStream, sizeHint?: number): Promise<void>;

  /**
   * Download an object by key. Returns a stream the caller pipes into the
   * decryption pipeline.
   */
  download(key: string): Promise<NodeJS.ReadableStream>;

  /**
   * Read just the first `bytes` of an object — used for `archive_describe`
   * to fetch the manifest envelope without pulling the body.
   * Defaults to 64 KiB.
   */
  downloadHead(key: string, bytes?: number): Promise<Uint8Array>;

  /** Delete one or more objects by key. */
  delete(keys: string[]): Promise<void>;
}

/** Common error shape that every adapter throws via Error.message wrapping. */
export function adapterError(adapterKind: string, code: string, cause: unknown): Error {
  const message =
    cause instanceof Error ? cause.message : typeof cause === "string" ? cause : JSON.stringify(cause);
  return new Error(`[${code}] (${adapterKind}) ${message}`);
}
