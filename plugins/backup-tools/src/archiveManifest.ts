/**
 * Plugin-layer archive manifest envelope.
 *
 * Wire format of an archive at the destination:
 *
 *   [4 bytes BE envelope-length] [envelope JSON bytes] [body chunks ...] [4 zero bytes]
 *
 * The envelope is UNENCRYPTED so tools can `archive_describe` cheaply (read
 * the first ~64 KiB) without holding the passphrase. The body chunks are
 * encrypted+authenticated. The envelope itself carries an HMAC (sealed with
 * a key derived from the passphrase) so tampering the envelope fails restore.
 */

import { DEFAULT_KDF, type KdfParams } from "./encryption.js";

export const ARCHIVE_MAGIC = "PCBACKUP1";
export const ENVELOPE_MAX_BYTES = 64 * 1024;

export type ArchiveEnvelope = {
  /** Magic / format identifier. Always "PCBACKUP1" for v0.1. */
  magic: typeof ARCHIVE_MAGIC;
  /** Plugin version that produced the archive. */
  producerPluginVersion: string;
  /** Stable instance ID this archive was produced from (from core /system/snapshot manifest). */
  instanceId: string;
  /** Snapshot UUID minted by core. */
  snapshotUuid: string;
  /** Plugin-side archive UUID (this is what's used for retention dedup). */
  archiveUuid: string;
  /** ISO 8601 timestamp at archive creation. */
  createdAt: string;
  /** Cadence that triggered this archive ("manual" | "hourly" | "daily" | ...). */
  cadence: "manual" | "hourly" | "daily" | "weekly" | "monthly";
  /** Schedule id, if applicable. */
  scheduleId?: string;
  /** Salt used to derive bodyKey + hmacKey from the passphrase. base64url. */
  salt: string;
  /** KDF params (Argon2id memKiB, t, p). */
  kdfParams: KdfParams;
  /** Plain-text body size (uncompressed estimate from core). */
  estimatedUncompressedBytes: number;
  /** Per-table counts at snapshot time (from core). */
  publicTableCounts: Record<string, number>;
  /** Plugin namespaces included in the snapshot. */
  pluginNamespaces: {
    pluginKey: string;
    pluginVersion: string;
    namespaceName: string;
    tableCounts: Record<string, number>;
  }[];
  /** Plugin namespaces excluded from the snapshot (with reason). */
  excludedPluginNamespaces: {
    pluginKey: string;
    pluginVersion: string;
    namespaceName: string;
    reason: string;
  }[];
  /** HMAC-SHA256 over the canonical JSON of this envelope (with this field omitted). base64url. */
  hmac: string;
};

/**
 * Canonicalize the envelope (deterministic JSON, hmac field stripped) before
 * computing or verifying the HMAC. Used by both producer and verifier.
 */
export function canonicalizeForHmac(envelope: ArchiveEnvelope): string {
  const { hmac: _omit, ...rest } = envelope;
  return JSON.stringify(sortKeys(rest));
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[k] = sortKeys((value as Record<string, unknown>)[k]);
  }
  return sorted;
}

/**
 * Serialize the envelope on the wire: 4-byte BE length prefix + JSON bytes.
 * Throws if envelope JSON exceeds ENVELOPE_MAX_BYTES (we don't grow envelopes).
 */
export function encodeEnvelope(envelope: ArchiveEnvelope): Uint8Array {
  const json = JSON.stringify(envelope);
  const jsonBytes = new TextEncoder().encode(json);
  if (jsonBytes.length > ENVELOPE_MAX_BYTES) {
    throw new Error(
      `[EBACKUP_ENVELOPE_TOO_LARGE] envelope is ${jsonBytes.length} bytes; max ${ENVELOPE_MAX_BYTES}`,
    );
  }
  const out = new Uint8Array(4 + jsonBytes.length);
  new DataView(out.buffer).setUint32(0, jsonBytes.length, false);
  out.set(jsonBytes, 4);
  return out;
}

export function decodeEnvelope(buffer: Uint8Array): { envelope: ArchiveEnvelope; bytesConsumed: number } {
  if (buffer.length < 4) {
    throw new Error("[EBACKUP_ENVELOPE_TRUNCATED] need at least 4 bytes for length prefix");
  }
  const length = new DataView(buffer.buffer, buffer.byteOffset, 4).getUint32(0, false);
  if (length === 0 || length > ENVELOPE_MAX_BYTES) {
    throw new Error(`[EBACKUP_ENVELOPE_INVALID] length=${length} out of range`);
  }
  if (buffer.length < 4 + length) {
    throw new Error("[EBACKUP_ENVELOPE_TRUNCATED] buffer shorter than declared envelope length");
  }
  const json = new TextDecoder().decode(buffer.subarray(4, 4 + length));
  let envelope: ArchiveEnvelope;
  try {
    envelope = JSON.parse(json) as ArchiveEnvelope;
  } catch (err) {
    throw new Error(`[EBACKUP_ENVELOPE_INVALID] JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (envelope.magic !== ARCHIVE_MAGIC) {
    throw new Error(`[EBACKUP_ENVELOPE_INVALID] unexpected magic: ${envelope.magic}`);
  }
  return { envelope, bytesConsumed: 4 + length };
}

/**
 * Build an envelope skeleton (without HMAC). Caller fills hmac via
 * `hmacEnvelope(hmacKey, canonicalizeForHmac(env))` then sets it on the
 * returned object.
 */
export function buildEnvelopeSkeleton(input: {
  producerPluginVersion: string;
  instanceId: string;
  snapshotUuid: string;
  archiveUuid: string;
  createdAt: string;
  cadence: ArchiveEnvelope["cadence"];
  scheduleId?: string;
  salt: Uint8Array;
  kdfParams?: KdfParams;
  estimatedUncompressedBytes: number;
  publicTableCounts: Record<string, number>;
  pluginNamespaces: ArchiveEnvelope["pluginNamespaces"];
  excludedPluginNamespaces: ArchiveEnvelope["excludedPluginNamespaces"];
}): Omit<ArchiveEnvelope, "hmac"> {
  return {
    magic: ARCHIVE_MAGIC,
    producerPluginVersion: input.producerPluginVersion,
    instanceId: input.instanceId,
    snapshotUuid: input.snapshotUuid,
    archiveUuid: input.archiveUuid,
    createdAt: input.createdAt,
    cadence: input.cadence,
    scheduleId: input.scheduleId,
    salt: Buffer.from(input.salt).toString("base64url"),
    kdfParams: input.kdfParams ?? DEFAULT_KDF,
    estimatedUncompressedBytes: input.estimatedUncompressedBytes,
    publicTableCounts: input.publicTableCounts,
    pluginNamespaces: input.pluginNamespaces,
    excludedPluginNamespaces: input.excludedPluginNamespaces,
  };
}

/** Compute the destination key path for an archive — used by all adapters. */
export function archiveKeyFor(envelope: { createdAt: string; archiveUuid: string }, prefix?: string): string {
  const ts = envelope.createdAt.replace(/[:.]/g, "").slice(0, 15); // 20260509T030700
  const safePrefix = prefix && prefix.length > 0 ? prefix.replace(/^\/+|\/+$/g, "") + "/" : "";
  return `${safePrefix}${ts}-${envelope.archiveUuid}.pcback`;
}
