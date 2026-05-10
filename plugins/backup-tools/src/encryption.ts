/**
 * Client-side encryption for backup archives.
 *
 * Strategy: Argon2id-derived 32-byte key, AES-256-GCM streaming cipher.
 * Each chunk is independently encrypted + authenticated so partial corruption
 * doesn't poison the whole archive.
 *
 * Pure-JS via @noble/* — no native bindings (passes the plugin loader rules).
 */

import { argon2id } from "@noble/hashes/argon2";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { hmac } from "@noble/hashes/hmac";
import { gcm } from "@noble/ciphers/aes";
import { randomBytes as nodeRandomBytes } from "node:crypto";

function randomBytes(length: number): Uint8Array {
  return new Uint8Array(nodeRandomBytes(length));
}

export const CHUNK_SIZE_BYTES = 4 * 1024 * 1024; // 4 MiB
export const NONCE_LENGTH = 12;
export const TAG_LENGTH = 16;

export type KdfParams = {
  /** "argon2id" — the only supported KDF in v0.1. */
  kdf: "argon2id";
  /** Memory cost in KiB. Default 65536 = 64 MiB. */
  memKiB: number;
  /** Time cost (iterations). Default 3. */
  iterations: number;
  /** Parallelism. Default 1 (single-thread; widely supported). */
  parallelism: number;
};

export const DEFAULT_KDF: KdfParams = {
  kdf: "argon2id",
  memKiB: 64 * 1024,
  iterations: 3,
  parallelism: 1,
};

/**
 * Derive a 64-byte master from passphrase + salt via Argon2id, then split
 * via HKDF-SHA256 into:
 *   - bodyKey (32 bytes) — used for AES-256-GCM chunk encryption
 *   - hmacKey (32 bytes) — used for the manifest envelope's integrity HMAC
 *
 * The split happens inside this function so callers never get one without
 * the other. If you need just the body key, take the first 32 bytes of the
 * returned object's `bodyKey` field — but you should also have `hmacKey`
 * around to verify the envelope.
 */
export async function deriveKeys(input: {
  passphrase: string;
  salt: Uint8Array;
  params?: KdfParams;
}): Promise<{ bodyKey: Uint8Array; hmacKey: Uint8Array; params: KdfParams }> {
  const params = input.params ?? DEFAULT_KDF;
  if (params.kdf !== "argon2id") {
    throw new Error(`[EBACKUP_KDF_UNSUPPORTED] kdf=${params.kdf}`);
  }
  const passphraseBytes = new TextEncoder().encode(input.passphrase);
  const master = argon2id(passphraseBytes, input.salt, {
    m: params.memKiB,
    t: params.iterations,
    p: params.parallelism,
    dkLen: 32,
  });

  // Expand into two 32-byte sub-keys via HKDF.
  const bodyKey = hkdf(sha256, master, input.salt, "paperclip-backup body-key v1", 32);
  const hmacKey = hkdf(sha256, master, input.salt, "paperclip-backup hmac-key v1", 32);

  return { bodyKey, hmacKey, params };
}

/**
 * Encrypted chunk wire format:
 *
 *   [4 bytes BE chunk length] [12 bytes nonce] [N bytes ciphertext+tag]
 *
 * Length includes nonce + ciphertext + tag (i.e. everything after the length
 * prefix). Reader-side sees length first, allocates exactly that, then reads
 * nonce + body. Final chunk is followed by a length prefix of 0 (sentinel
 * end-of-stream); callers must include this themselves via finalize().
 */

export type ChunkCipher = {
  /** Encrypt one chunk. Returns the on-wire bytes (length prefix + nonce + ciphertext+tag). */
  encryptChunk(plaintext: Uint8Array): Uint8Array;
  /** Emit the end-of-stream sentinel (4 zero bytes). */
  finalize(): Uint8Array;
};

export function createChunkCipher(bodyKey: Uint8Array): ChunkCipher {
  let chunkIndex = 0;
  return {
    encryptChunk(plaintext: Uint8Array): Uint8Array {
      const nonce = randomBytes(NONCE_LENGTH);
      // Domain-separate nonces with a chunk-index counter in the AAD so
      // a reordered or replayed chunk fails authentication.
      const aad = new Uint8Array(4);
      new DataView(aad.buffer).setUint32(0, chunkIndex, false);
      const cipher = gcm(bodyKey, nonce, aad);
      const ciphertext = cipher.encrypt(plaintext);
      const out = new Uint8Array(4 + NONCE_LENGTH + ciphertext.length);
      new DataView(out.buffer).setUint32(0, NONCE_LENGTH + ciphertext.length, false);
      out.set(nonce, 4);
      out.set(ciphertext, 4 + NONCE_LENGTH);
      chunkIndex += 1;
      return out;
    },
    finalize(): Uint8Array {
      const sentinel = new Uint8Array(4);
      // 4 zero bytes = end-of-stream
      return sentinel;
    },
  };
}

export type ChunkDecipher = {
  /** Decrypt one chunk by index. Throws on auth failure. */
  decryptChunk(nonce: Uint8Array, ciphertextWithTag: Uint8Array): Uint8Array;
};

export function createChunkDecipher(bodyKey: Uint8Array): ChunkDecipher {
  let chunkIndex = 0;
  return {
    decryptChunk(nonce: Uint8Array, ciphertextWithTag: Uint8Array): Uint8Array {
      const aad = new Uint8Array(4);
      new DataView(aad.buffer).setUint32(0, chunkIndex, false);
      const cipher = gcm(bodyKey, nonce, aad);
      try {
        const plaintext = cipher.decrypt(ciphertextWithTag);
        chunkIndex += 1;
        return plaintext;
      } catch (err) {
        throw new Error(
          `[EBACKUP_INTEGRITY_FAILED] chunk ${chunkIndex} failed authentication: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}

/**
 * Compute an HMAC-SHA256 of the canonical-JSON-serialized envelope using
 * `hmacKey`. Used to seal the manifest envelope so a tampered manifest
 * (e.g. attacker swapping plugin version numbers) fails restore.
 */
export function hmacEnvelope(hmacKey: Uint8Array, envelopeJson: string): string {
  const sig = hmac(sha256, hmacKey, new TextEncoder().encode(envelopeJson));
  return Buffer.from(sig).toString("base64url");
}

export function verifyEnvelopeHmac(
  hmacKey: Uint8Array,
  envelopeJson: string,
  expectedB64Url: string,
): boolean {
  const actual = hmacEnvelope(hmacKey, envelopeJson);
  if (actual.length !== expectedB64Url.length) return false;
  // constant-time-ish compare
  let diff = 0;
  for (let i = 0; i < actual.length; i++) {
    diff |= actual.charCodeAt(i) ^ expectedB64Url.charCodeAt(i);
  }
  return diff === 0;
}

export function generateSalt(): Uint8Array {
  return randomBytes(16);
}

export function generateArchiveUuid(): string {
  // RFC4122 v4 from 16 random bytes
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) hex.push(b[i].toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}
