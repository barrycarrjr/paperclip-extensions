/**
 * backup-tools plugin worker.
 *
 * Responsibilities:
 *   - 4 cadence jobs (hourly/daily/weekly/monthly): scan schedule_state for
 *     due rows, fan out backups, prune retention, write history.
 *   - 5 agent tools: backup_run_now, list, get, list_destinations, archive_describe.
 *   - 10 API routes (board + instance-admin): destinations, backups, restore,
 *     manifest-of, schedules.
 *   - 1 data handler for the sidebar visibility ping.
 *
 * Privileged operations (snapshot produce, snapshot restore) go through the
 * host's `ctx.system` calls, not the core `/api/system/snapshot*` endpoints,
 * which a worker cannot reach. The plugin never reads or writes core tables
 * directly.
 */

import {
  definePlugin,
  runWorker,
  type PluginApiRequestInput,
  type PluginApiResponse,
  type PluginContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { Readable, PassThrough, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  statSync,
  mkdirSync,
  readdirSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { assertCompanyAccess, isCompanyAllowed } from "./companyAccess.js";
import { createBackupQueue, type BackupTurn, type BackupTurnHooks } from "./backupQueue.js";
import {
  CHUNK_SIZE_BYTES,
  NONCE_LENGTH,
  TAG_LENGTH,
  createChunkCipher,
  createChunkDecipher,
  deriveKeys,
  generateArchiveUuid,
  generateSalt,
  hmacEnvelope,
  verifyEnvelopeHmac,
} from "./encryption.js";
import {
  archiveKeyFor,
  buildEnvelopeSkeleton,
  canonicalizeForHmac,
  decodeEnvelope,
  encodeEnvelope,
  type ArchiveEnvelope,
} from "./archiveManifest.js";
import {
  createAdapterForDestination,
  type BackupDestinationAdapter,
  type DestinationConfigEntry,
} from "./adapters/index.js";

// ─── Plugin manifest version (kept here so we don't import the manifest module
// at runtime — esbuild would bundle the giant SETUP_INSTRUCTIONS string).

const PLUGIN_VERSION = "0.1.0";

// ─── Config types (mirror of the JSON Schema in manifest.ts) ─────────────────

type ScheduleEntry = {
  id: string;
  cadence: "hourly" | "daily" | "weekly" | "monthly";
  destinationIds: string[];
  keepLast?: number;
  enabled?: boolean;
};

type InstanceConfig = {
  allowedCompanies?: string[];
  passphraseSecretRef?: string;
  destinations?: DestinationConfigEntry[];
  schedules?: ScheduleEntry[];
  retention?: {
    maxArchivesPerDestination?: number;
    maxTotalSizeGb?: number;
  };
  maxRunMinutes?: number;
  mutationsEnabled?: boolean;
  alertOnFailureToCompanyId?: string;
};

// ─── Adapter cache ───────────────────────────────────────────────────────────

const adapterCache = new Map<string, BackupDestinationAdapter>();

function clearAdapterCache() {
  adapterCache.clear();
}

async function getAdapter(
  ctx: PluginContext,
  destinationId: string,
): Promise<BackupDestinationAdapter> {
  const cached = adapterCache.get(destinationId);
  if (cached) return cached;
  const cfg = (await ctx.config.get()) as InstanceConfig;
  const entry = (cfg.destinations ?? []).find((d) => d.id === destinationId);
  if (!entry) throw new Error(`[EBACKUP_DEST_NOT_FOUND] no destination configured with id=${destinationId}`);
  if (entry.enabled === false) throw new Error(`[EBACKUP_DEST_DISABLED] destination ${destinationId} is disabled`);
  const adapter = await createAdapterForDestination(ctx, entry);
  adapterCache.set(destinationId, adapter);
  return adapter;
}

// ─── Database helpers ────────────────────────────────────────────────────────
//
// The host's plugin-SQL validator requires every table reference in runtime
// SQL to be fully qualified with the plugin's database namespace. The
// namespace is derived dynamically (sha256 of plugin key); ctx.db.namespace
// exposes it. We never hardcode it — the migration file does, but at runtime
// we read it off ctx.db.

const TABLES = {
  backups: (ns: string) => `${ns}.backups`,
  destResults: (ns: string) => `${ns}.backup_destination_results`,
  scheduleState: (ns: string) => `${ns}.schedule_state`,
  restoreRuns: (ns: string) => `${ns}.restore_runs`,
  instanceKeys: (ns: string) => `${ns}.instance_keys`,
};

// ─── Encryption key resolution ───────────────────────────────────────────────
//
// When passphraseSecretRef is set, the operator's secret is used as the KDF
// input (user-managed passphrase mode). When it is absent, a random 256-bit
// key is generated on first use and stored in the plugin DB (auto-key mode).
// Either way, callers receive a plain string that flows into deriveKeys().

const AUTO_KEY_ID = "instance-encryption-key-v1";

async function resolveEncryptionPassphrase(ctx: PluginContext, cfg: InstanceConfig): Promise<string> {
  if (cfg.passphraseSecretRef) {
    const passphrase = await ctx.secrets.resolve(cfg.passphraseSecretRef);
    if (!passphrase || passphrase.length < 8) {
      throw new Error("[EBACKUP_NO_PASSPHRASE] passphrase resolved empty or too short");
    }
    return passphrase;
  }
  const ns = ctx.db.namespace;
  const [existing] = await ctx.db.query<{ key_hex: string }>(
    `SELECT key_hex FROM ${TABLES.instanceKeys(ns)} WHERE key_id = $1`,
    [AUTO_KEY_ID],
  );
  if (existing) return existing.key_hex;
  const keyHex = randomBytes(32).toString("hex");
  await ctx.db.execute(
    `INSERT INTO ${TABLES.instanceKeys(ns)} (key_id, key_hex) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [AUTO_KEY_ID, keyHex],
  );
  const [row] = await ctx.db.query<{ key_hex: string }>(
    `SELECT key_hex FROM ${TABLES.instanceKeys(ns)} WHERE key_id = $1`,
    [AUTO_KEY_ID],
  );
  return row?.key_hex ?? keyHex;
}

async function ensureSchedulesSeeded(ctx: PluginContext, schedules: ScheduleEntry[]) {
  const ns = ctx.db.namespace;
  for (const s of schedules) {
    await ctx.db.execute(
      `INSERT INTO ${TABLES.scheduleState(ns)} (schedule_id, cadence, next_run_after, last_run_at, last_run_status, consecutive_failures)
       VALUES ($1, $2, now(), NULL, NULL, 0)
       ON CONFLICT (schedule_id) DO UPDATE SET cadence = EXCLUDED.cadence`,
      [s.id, s.cadence],
    );
  }
}

async function pickDueSchedules(ctx: PluginContext, cadence: ScheduleEntry["cadence"]): Promise<string[]> {
  const ns = ctx.db.namespace;
  const rows = await ctx.db.query<{ schedule_id: string }>(
    `SELECT schedule_id FROM ${TABLES.scheduleState(ns)}
     WHERE cadence = $1 AND next_run_after <= now()`,
    [cadence],
  );
  return rows.map((r) => r.schedule_id);
}

function nextRunFor(cadence: ScheduleEntry["cadence"], from: Date): Date {
  const d = new Date(from.getTime());
  if (cadence === "hourly") d.setUTCHours(d.getUTCHours() + 1, 7, 0, 0);
  else if (cadence === "daily") {
    d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(3, 7, 0, 0);
  } else if (cadence === "weekly") {
    const dayOfWeek = d.getUTCDay();
    const daysUntilSunday = (7 - dayOfWeek) % 7 || 7;
    d.setUTCDate(d.getUTCDate() + daysUntilSunday);
    d.setUTCHours(3, 7, 0, 0);
  } else if (cadence === "monthly") {
    d.setUTCMonth(d.getUTCMonth() + 1, 1);
    d.setUTCHours(3, 7, 0, 0);
  }
  return d;
}

async function updateScheduleAfterRun(
  ctx: PluginContext,
  scheduleId: string,
  cadence: ScheduleEntry["cadence"],
  status: "succeeded" | "failed" | "partial",
) {
  const ns = ctx.db.namespace;
  const next = nextRunFor(cadence, new Date());
  const isFailure = status !== "succeeded";
  await ctx.db.execute(
    `UPDATE ${TABLES.scheduleState(ns)} SET
       last_run_at = now(),
       last_run_status = $2,
       next_run_after = $3,
       consecutive_failures = CASE WHEN $4::boolean THEN consecutive_failures + 1 ELSE 0 END
     WHERE schedule_id = $1`,
    [scheduleId, status, next.toISOString(), isFailure],
  );
}

// ─── Archive production ──────────────────────────────────────────────────────

async function fetchSnapshotFromCore(ctx: PluginContext): Promise<{
  manifest: import("./archiveManifest.js").ArchiveEnvelope extends infer T ? unknown : never; // narrowed below
  snapshotUuid: string;
  instanceId: string;
  createdAt: string;
  publicTableCounts: Record<string, number>;
  pluginNamespaces: Array<{
    pluginKey: string;
    pluginVersion: string;
    namespaceName: string;
    tableCounts: Record<string, number>;
  }>;
  excludedPluginNamespaces: Array<{
    pluginKey: string;
    pluginVersion: string;
    namespaceName: string;
    reason: string;
  }>;
  estimatedUncompressedBytes: number;
  bodyStream: NodeJS.ReadableStream;
  bodySizeHint?: number;
  /** Release the host's copy once the archive is built. Always call it. */
  release: () => Promise<void>;
}> {
  // Ask the host directly rather than calling its HTTP API.
  //
  // The HTTP route was never reachable from in here and could not be made so:
  // it requires instance-admin rights a worker has no way to hold, and plugin
  // outbound HTTP deliberately refuses loopback and private addresses so a
  // plugin cannot attack the host it runs inside. Both of those are worth
  // keeping. `ctx.system.createSnapshot()` sidesteps them entirely — it is
  // gated on the `system.snapshot.read` capability in our manifest instead.
  //
  // The host writes the dump to its own disk and hands back a path. We are a
  // child process on the same machine, so we can just open it.
  const snapshot = await ctx.system.createSnapshot();
  const bodyStream = createReadStream(snapshot.filePath);
  return {
    manifest: snapshot.manifest as never,
    snapshotUuid: snapshot.manifest.snapshotUuid,
    instanceId: snapshot.manifest.instanceId,
    createdAt: snapshot.manifest.createdAt,
    publicTableCounts: snapshot.manifest.publicTableCounts,
    pluginNamespaces: snapshot.manifest.pluginNamespaces,
    excludedPluginNamespaces: snapshot.manifest.excludedPluginNamespaces,
    estimatedUncompressedBytes: snapshot.manifest.estimatedUncompressedBytes,
    bodyStream,
    bodySizeHint: snapshot.sizeBytes,
    release: async () => {
      await ctx.system.releaseSnapshot(snapshot.filePath);
    },
  };
}

async function buildEncryptedArchiveToTmpFile(input: {
  passphrase: string;
  envelopeSeed: Omit<ArchiveEnvelope, "hmac" | "salt" | "kdfParams"> & { salt: Uint8Array };
  bodyStream: NodeJS.ReadableStream;
}): Promise<{ archiveFilePath: string; envelope: ArchiveEnvelope; sizeBytes: number }> {
  const { passphrase, envelopeSeed, bodyStream } = input;
  const { bodyKey, hmacKey, params } = await deriveKeys({
    passphrase,
    salt: envelopeSeed.salt,
  });

  // Build the envelope first (with HMAC) then encode it as the file's prefix.
  const skeleton = buildEnvelopeSkeleton({
    producerPluginVersion: envelopeSeed.producerPluginVersion,
    instanceId: envelopeSeed.instanceId,
    snapshotUuid: envelopeSeed.snapshotUuid,
    archiveUuid: envelopeSeed.archiveUuid,
    createdAt: envelopeSeed.createdAt,
    cadence: envelopeSeed.cadence,
    scheduleId: envelopeSeed.scheduleId,
    salt: envelopeSeed.salt,
    kdfParams: params,
    estimatedUncompressedBytes: envelopeSeed.estimatedUncompressedBytes,
    publicTableCounts: envelopeSeed.publicTableCounts,
    pluginNamespaces: envelopeSeed.pluginNamespaces,
    excludedPluginNamespaces: envelopeSeed.excludedPluginNamespaces,
  });
  const envelope: ArchiveEnvelope = { ...skeleton, hmac: "" };
  envelope.hmac = hmacEnvelope(hmacKey, canonicalizeForHmac(envelope));

  const archiveFilePath = join(tmpdir(), `pcback-${envelope.archiveUuid}.bin`);
  const out = createWriteStream(archiveFilePath);
  out.write(encodeEnvelope(envelope));

  const cipher = createChunkCipher(bodyKey);
  // Read the body in CHUNK_SIZE_BYTES chunks, encrypt, write.
  const reader = bodyStream as unknown as AsyncIterable<Uint8Array>;
  let buffer = new Uint8Array(0);
  for await (const chunk of reader) {
    const merged = new Uint8Array(buffer.length + chunk.byteLength);
    merged.set(buffer);
    merged.set(chunk, buffer.length);
    buffer = merged;
    while (buffer.length >= CHUNK_SIZE_BYTES) {
      const slice = buffer.subarray(0, CHUNK_SIZE_BYTES);
      buffer = buffer.subarray(CHUNK_SIZE_BYTES);
      out.write(Buffer.from(cipher.encryptChunk(slice)));
    }
  }
  if (buffer.length > 0) {
    out.write(Buffer.from(cipher.encryptChunk(buffer)));
  }
  out.write(Buffer.from(cipher.finalize()));
  await new Promise<void>((resolve, reject) => {
    out.end((err: unknown) => (err ? reject(err) : resolve()));
  });
  const sizeBytes = statSync(archiveFilePath).size;
  return { archiveFilePath, envelope, sizeBytes };
}

/** Check the envelope's seal with the passphrase and return the body's decipher. */
async function unlockArchive(passphrase: string, envelope: ArchiveEnvelope): Promise<ReturnType<typeof createChunkDecipher>> {
  const salt = Buffer.from(envelope.salt, "base64url");
  const { bodyKey, hmacKey } = await deriveKeys({
    passphrase,
    salt: new Uint8Array(salt.buffer, salt.byteOffset, salt.byteLength),
    params: envelope.kdfParams,
  });
  // Verify the envelope HMAC against the canonical form.
  if (!verifyEnvelopeHmac(hmacKey, canonicalizeForHmac(envelope), envelope.hmac)) {
    throw new Error("[EBACKUP_INTEGRITY_FAILED] envelope HMAC verification failed");
  }
  return createChunkDecipher(bodyKey);
}

/**
 * Decrypt the whole archive and throw the plain text away: the preview. Every
 * chunk is authenticated and the end marker must be there, so a wrong
 * passphrase, a changed byte or a cut-off archive all fail, and nothing of the
 * database reaches the disk.
 */
async function verifyArchive(input: {
  passphrase: string;
  envelope: ArchiveEnvelope;
  encryptedBodyStream: NodeJS.ReadableStream;
}): Promise<void> {
  const decipher = await unlockArchive(input.passphrase, input.envelope);
  const discard = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  await decryptBodyTo(discard, decipher, input.encryptedBodyStream);
}

/**
 * Folders holding an apply's decrypted dump, in the system temp folder:
 * `pcback-restore-<worker pid>-XXXXXX`. Each holds the whole database in plain
 * text. The pid lets a later worker tell a stopped worker's leftovers from a
 * running one's.
 */
const RESTORE_DIR_PREFIX = "pcback-restore-";

/** The folder of the apply running now, if any, so onShutdown can remove it. */
let restoreTempDir: string | null = null;

function removeRestoreDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  if (restoreTempDir === dir) restoreTempDir = null;
}

/**
 * Decrypt the whole archive into a file for Paperclip to apply. The file is
 * new (`wx`), readable by this account only (0600), and alone in a folder
 * from mkdtemp, which is private to this account on Linux and macOS. On
 * Windows the temp folder is already per user. A failure part way removes the
 * folder; otherwise the caller removes it once Paperclip has finished.
 */
async function decryptArchiveForApply(input: {
  passphrase: string;
  envelope: ArchiveEnvelope;
  encryptedBodyStream: NodeJS.ReadableStream;
}): Promise<{ dir: string; sqlGzPath: string }> {
  const decipher = await unlockArchive(input.passphrase, input.envelope);
  const dir = await mkdtemp(join(tmpdir(), `${RESTORE_DIR_PREFIX}${process.pid}-`));
  restoreTempDir = dir;
  const sqlGzPath = join(dir, "dump.sql.gz");
  try {
    const out = createWriteStream(sqlGzPath, { flags: "wx", mode: 0o600 });
    // With no listener, a failed write is thrown from nowhere and stops the
    // worker. With one, it reaches end()'s callback in decryptBodyTo instead.
    out.on("error", () => {});
    try {
      await decryptBodyTo(out, decipher, input.encryptedBodyStream);
    } catch (err) {
      // Close the file before the folder goes, so nothing is still writing.
      if (!out.closed) {
        await new Promise<void>((resolve) => {
          out.once("close", () => resolve());
          out.end();
        });
      }
      throw err;
    }
  } catch (err) {
    // A chunk that fails authentication part way through leaves the chunks
    // before it on disk in plain text.
    removeRestoreDir(dir);
    throw err;
  }
  return { dir, sqlGzPath };
}

/**
 * Remove decrypted dumps a stopped worker left in the temp folder. A worker
 * stopped mid-restore never reaches runRestore's cleanup, and each dump is the
 * whole database in plain text. A folder whose worker is still running (a
 * second Paperclip on this machine, say) is left alone. Loose
 * `pcback-decrypt-*.sql.gz` files are what versions before 0.1.33 left.
 */
function sweepDecryptedLeftovers(ctx: PluginContext): void {
  const root = tmpdir();
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  let removed = 0;
  for (const name of names) {
    const owner = /^pcback-restore-(\d+)-/.exec(name);
    if (!owner && !/^pcback-decrypt-.*\.sql\.gz$/.test(name)) continue;
    const path = join(root, name);
    if (path === restoreTempDir) continue;
    if (owner && Number(owner[1]) !== process.pid && processIsRunning(Number(owner[1]))) continue;
    try {
      rmSync(path, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* best-effort */
    }
  }
  if (removed > 0) ctx.logger.warn("removed decrypted restore files a stopped worker left behind", { removed });
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it is running, as another account.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The longest chunk on the wire: length prefix aside, nonce, a full chunk and its tag. */
const MAX_ENCRYPTED_CHUNK_BYTES = NONCE_LENGTH + CHUNK_SIZE_BYTES + TAG_LENGTH;

async function decryptBodyTo(
  out: Writable,
  decipher: ReturnType<typeof createChunkDecipher>,
  encryptedBodyStream: NodeJS.ReadableStream,
): Promise<void> {
  let buffer = new Uint8Array(0);
  const reader = encryptedBodyStream as unknown as AsyncIterable<Uint8Array>;
  let endOfStream = false;
  for await (const chunk of reader) {
    // Nothing may follow the end marker. Read on to make sure of it.
    if (endOfStream) {
      if (chunk.byteLength > 0) throw new Error("[EBACKUP_INTEGRITY_FAILED] the archive has data after its end marker");
      continue;
    }
    const merged = new Uint8Array(buffer.length + chunk.byteLength);
    merged.set(buffer);
    merged.set(chunk, buffer.length);
    buffer = merged;
    // Process as many full chunks as we have.
    while (buffer.length >= 4) {
      const len = new DataView(buffer.buffer, buffer.byteOffset, 4).getUint32(0, false);
      if (len === 0) {
        endOfStream = true;
        buffer = buffer.subarray(4);
        break;
      }
      // A damaged length would otherwise have the rest of the archive held
      // in memory, waiting for a chunk this plugin never writes.
      if (len > MAX_ENCRYPTED_CHUNK_BYTES) {
        throw new Error("[EBACKUP_INTEGRITY_FAILED] the archive has a chunk longer than any this plugin writes");
      }
      if (buffer.length < 4 + len) break; // wait for more bytes
      const nonce = buffer.subarray(4, 4 + NONCE_LENGTH);
      const ct = buffer.subarray(4 + NONCE_LENGTH, 4 + len);
      const pt = decipher.decryptChunk(nonce, ct);
      out.write(Buffer.from(pt));
      buffer = buffer.subarray(4 + len);
    }
    if (endOfStream && buffer.length > 0) {
      throw new Error("[EBACKUP_INTEGRITY_FAILED] the archive has data after its end marker");
    }
  }
  // Every archive ends with a marker. Without one it was cut off, and the
  // chunks after the last whole one are missing. This used to decrypt what was
  // there, drop a partial last chunk and report success.
  if (!endOfStream) {
    throw new Error("[EBACKUP_INTEGRITY_FAILED] the archive is cut off: it has no end marker");
  }
  // if (!endOfStream) {
  //   // Process trailing chunk without sentinel (writer likely cut off mid-stream)
  //   if (buffer.length >= 4) {
  //     const len = new DataView(buffer.buffer, buffer.byteOffset, 4).getUint32(0, false);
  //     if (len > 0 && buffer.length >= 4 + len) {
  //       const nonce = buffer.subarray(4, 4 + NONCE_LENGTH);
  //       const ct = buffer.subarray(4 + NONCE_LENGTH, 4 + len);
  //       const pt = decipher.decryptChunk(nonce, ct);
  //       out.write(Buffer.from(pt));
  //     }
  //   }
  // }
  await new Promise<void>((resolve, reject) => {
    out.end((err: unknown) => (err ? reject(err) : resolve()));
  });
}

// ─── runBackup — the main fan-out path ──────────────────────────────────────

type BackupCadence = ScheduleEntry["cadence"] | "manual";

async function runBackup(
  ctx: PluginContext,
  cadence: BackupCadence,
  scheduleId: string | null,
  destinationIds: string[],
  triggeredBy: { actorId?: string; agentId?: string },
  /** The backup's turn in the queue (see queueBackup), which every backup takes. */
  turn?: BackupTurnHooks,
): Promise<{ backupId: string; status: "succeeded" | "failed" | "partial"; sizeBytes: number }> {
  const cfg = (await ctx.config.get()) as InstanceConfig;
  const passphrase = await resolveEncryptionPassphrase(ctx, cfg);
  // False once the deadline has given up on this backup and recorded it, so
  // a late finish does not write over that.
  let mayRecord: boolean | undefined;
  const claimOutcome = () => (mayRecord ??= turn ? turn.claimOutcome() : true);

  const ns = ctx.db.namespace;
  const archiveUuid = generateArchiveUuid();
  const startedAt = new Date();
  const backupId = randomUUID();

  await ctx.db.execute(
    `INSERT INTO ${TABLES.backups(ns)} (id, archive_uuid, cadence, schedule_id, status, started_at, triggered_by_actor_id, triggered_by_agent_id)
     VALUES ($1, $2, $3, $4, 'running', $5, $6, $7)`,
    [backupId, archiveUuid, cadence, scheduleId, startedAt.toISOString(), triggeredBy.actorId ?? null, triggeredBy.agentId ?? null],
  );
  turn?.started(backupId);

  let archiveFilePath: string | null = null;
  let envelope: ArchiveEnvelope | null = null;
  let archiveSizeBytes = 0;
  const perDestResults: { id: string; status: "succeeded" | "failed"; remoteKey?: string; error?: string }[] = [];

  try {
    // 1) ask the host for a snapshot (it writes it to disk, we read the file)
    const snap = await fetchSnapshotFromCore(ctx);

    // 2) encrypt to tmp file (we need a real file because we may upload to N destinations)
    try {
      const built = await buildEncryptedArchiveToTmpFile({
        passphrase,
        envelopeSeed: {
          magic: "PCBACKUP1",
          producerPluginVersion: PLUGIN_VERSION,
          instanceId: snap.instanceId,
          snapshotUuid: snap.snapshotUuid,
          archiveUuid,
          createdAt: startedAt.toISOString(),
          cadence,
          scheduleId: scheduleId ?? undefined,
          salt: generateSalt(),
          estimatedUncompressedBytes: snap.estimatedUncompressedBytes,
          publicTableCounts: snap.publicTableCounts,
          pluginNamespaces: snap.pluginNamespaces,
          excludedPluginNamespaces: snap.excludedPluginNamespaces,
        } as never,
        bodyStream: snap.bodyStream,
      });
      archiveFilePath = built.archiveFilePath;
      envelope = built.envelope;
      archiveSizeBytes = built.sizeBytes;
    } finally {
      // The host's copy is the size of the whole database. Release it the
      // moment we've finished encrypting our own, success or failure —
      // holding it through the upload fan-out would double the disk cost of
      // every backup for no reason.
      await snap.release().catch((err: unknown) => {
        ctx.logger.warn("could not release host snapshot", { err: String(err) });
      });
    }

    // 3) fan-out upload
    for (const destId of destinationIds) {
      try {
        const adapter = await getAdapter(ctx, destId);
        const remoteKey = archiveKeyFor(envelope, undefined);
        const stream = createReadStream(archiveFilePath);
        await adapter.upload(remoteKey, stream, archiveSizeBytes);
        perDestResults.push({ id: destId, status: "succeeded", remoteKey });
        await ctx.db.execute(
          `INSERT INTO ${TABLES.destResults(ns)} (backup_id, destination_id, destination_kind, status, remote_key, size_bytes, upload_started_at, upload_completed_at)
           VALUES ($1, $2, $3, 'succeeded', $4, $5, $6, now())`,
          [backupId, destId, adapter.kind, remoteKey, archiveSizeBytes, startedAt.toISOString()],
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        perDestResults.push({ id: destId, status: "failed", error: errMsg });
        await ctx.db.execute(
          `INSERT INTO ${TABLES.destResults(ns)} (backup_id, destination_id, destination_kind, status, error_code, error_message, upload_started_at, upload_completed_at)
           VALUES ($1, $2, $3, 'failed', $4, $5, $6, now())`,
          [backupId, destId, "unknown", extractErrorCode(errMsg), errMsg.slice(0, 1000), startedAt.toISOString()],
        );
      }
    }

    // 4) prune retention per destination
    if (envelope) await applyRetention(ctx, cfg, scheduleId, destinationIds);

    const successes = perDestResults.filter((r) => r.status === "succeeded").length;
    const finalStatus: "succeeded" | "failed" | "partial" =
      successes === 0 ? "failed" : successes < destinationIds.length ? "partial" : "succeeded";

    if (!claimOutcome()) return { backupId, status: "failed", sizeBytes: archiveSizeBytes };
    // error_summary is cleared so a finished row never carries an earlier
    // run's reason, such as EBACKUP_INTERRUPTED, under a "succeeded" status.
    await ctx.db.execute(
      `UPDATE ${TABLES.backups(ns)} SET status = $2, completed_at = now(), size_bytes = $3, manifest_json = $4, error_summary = NULL WHERE id = $1`,
      [backupId, finalStatus, archiveSizeBytes, JSON.stringify(envelope)],
    );

    if (scheduleId && cadence !== "manual") {
      await updateScheduleAfterRun(ctx, scheduleId, cadence, finalStatus);
    }

    if (finalStatus !== "succeeded") {
      await maybeCreateFailureIssue(ctx, cfg, backupId, finalStatus, perDestResults);
    } else {
      await clearFailureAlert(ctx, cfg);
    }

    void ctx.activity.log({
      action: "backup.run",
      details: {
        backupId,
        cadence,
        scheduleId: scheduleId ?? undefined,
        status: finalStatus,
        sizeBytes: archiveSizeBytes,
        destinations: perDestResults,
      },
    } as never).catch(() => {});

    return { backupId, status: finalStatus, sizeBytes: archiveSizeBytes };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (!claimOutcome()) return { backupId, status: "failed", sizeBytes: archiveSizeBytes };
    await recordFailedBackup(ctx, cfg, backupId, cadence, scheduleId, errMsg, perDestResults);
    return { backupId, status: "failed", sizeBytes: archiveSizeBytes };
  } finally {
    if (archiveFilePath && existsSync(archiveFilePath)) {
      try { unlinkSync(archiveFilePath); } catch { /* best-effort */ }
    }
  }
}

/** Record a failed backup: its row, its schedule, and the failure alert. */
async function recordFailedBackup(
  ctx: PluginContext,
  cfg: InstanceConfig,
  backupId: string,
  cadence: BackupCadence,
  scheduleId: string | null,
  errMsg: string,
  perDestResults: Array<{ id: string; status: string; error?: string }>,
) {
  await ctx.db.execute(
    `UPDATE ${TABLES.backups(ctx.db.namespace)} SET status = 'failed', completed_at = now(), error_summary = $2 WHERE id = $1`,
    [backupId, errMsg.slice(0, 1000)],
  );
  if (scheduleId && cadence !== "manual") {
    await updateScheduleAfterRun(ctx, scheduleId, cadence, "failed");
  }
  await maybeCreateFailureIssue(ctx, cfg, backupId, "failed", perDestResults, errMsg);
}

/** Close a row its backup left running. A row that has finished is left alone. */
async function closeBackupRow(ctx: PluginContext, backupId: string, errMsg: string) {
  await ctx.db.execute(
    `UPDATE ${TABLES.backups(ctx.db.namespace)} SET status = 'failed', completed_at = now(), error_summary = $2 WHERE id = $1 AND status = 'running'`,
    [backupId, errMsg.slice(0, 1000)],
  );
}

function extractErrorCode(msg: string): string {
  const match = msg.match(/^\[([A-Z_0-9]+)\]/);
  return match ? match[1] : "EBACKUP_UNKNOWN";
}

async function maybeCreateFailureIssue(
  ctx: PluginContext,
  cfg: InstanceConfig,
  backupId: string,
  status: string,
  perDest: Array<{ id: string; status: string; error?: string }>,
  topLevelError?: string,
) {
  if (!cfg.alertOnFailureToCompanyId) return;
  const companyId = cfg.alertOnFailureToCompanyId;
  const failureSummary =
    topLevelError ??
    perDest
      .filter((d) => d.status === "failed")
      .map((d) => `- ${d.id}: ${d.error}`)
      .join("\n");
  const detail =
    `Backup run \`${backupId}\` finished with status \`${status}\`.\n\n${failureSummary}\n\n` +
    `See plugin dashboard for the full per-destination breakdown.`;

  try {
    // Repeat failures escalate on ONE issue instead of filing a fresh one
    // every night. Six consecutive nightly failures previously produced six
    // separate unassigned backlog items, which read as noise and were ignored
    // for the better part of a week while no backup succeeded at all. A
    // problem that is getting worse has to get louder, not longer.
    const open = await ctx.issues.list({
      companyId,
      originKind: `plugin:${PLUGIN_KEY}` as const,
      originId: FAILURE_ISSUE_ORIGIN_ID,
      limit: 20,
    });
    const existing = open.find((i) => i.status !== "done" && i.status !== "cancelled") ?? null;

    if (existing) {
      const streak = await recordFailureStreak(ctx, companyId);
      await ctx.issues.createComment(
        existing.id,
        `Failed again (${streak} consecutive failures).\n\n${detail}`,
        companyId,
      );
      // Priority climbs with the streak. Two nights is a glitch; four nights
      // running means there is no usable recent backup of anything.
      const priority = streak >= 4 ? "critical" : streak >= 2 ? "high" : "medium";
      if (existing.priority !== priority) {
        await ctx.issues.update(existing.id, { priority }, companyId);
      }
      return;
    }

    await resetFailureStreak(ctx, companyId);
    await ctx.issues.create({
      companyId,
      title: `[backup-tools] backups are failing`,
      // `description`, not `body`. The SDK's create() takes `description`, so
      // the old `body` key was silently dropped — every one of those nightly
      // issues was filed with an empty body and no clue what had gone wrong.
      // The `as never` cast is gone too; it was what stopped the compiler
      // saying so.
      description: detail,
      priority: "high",
      originKind: `plugin:${PLUGIN_KEY}` as const,
      originId: FAILURE_ISSUE_ORIGIN_ID,
    });
  } catch (err) {
    ctx.logger.warn("alertOnFailureToCompanyId issue creation failed", { err: String(err) });
  }
}

/** Matches the manifest's plugin id — used to tag and re-find our own issues. */
const PLUGIN_KEY = "backup-tools";
/** Stable origin id so the running failure issue can be found again. */
const FAILURE_ISSUE_ORIGIN_ID = "backup-failure-streak";
const FAILURE_STREAK_KEY = "backup.failure.streak";

/**
 * A backup finally worked. Close the running failure issue and reset the
 * streak, so the next bad night starts a fresh, correctly-prioritised alert
 * rather than continuing to escalate an outage that is already over.
 */
async function clearFailureAlert(ctx: PluginContext, cfg: InstanceConfig): Promise<void> {
  if (!cfg.alertOnFailureToCompanyId) return;
  const companyId = cfg.alertOnFailureToCompanyId;
  try {
    await ctx.state.delete(failureStreakScope(companyId));
    const open = await ctx.issues.list({
      companyId,
      originKind: `plugin:${PLUGIN_KEY}` as const,
      originId: FAILURE_ISSUE_ORIGIN_ID,
      limit: 20,
    });
    for (const issue of open) {
      if (issue.status === "done" || issue.status === "cancelled") continue;
      await ctx.issues.createComment(issue.id, "A backup completed successfully. Closing.", companyId);
      await ctx.issues.update(issue.id, { status: "done" }, companyId);
    }
  } catch (err) {
    ctx.logger.warn("could not clear backup failure alert", { err: String(err) });
  }
}

function failureStreakScope(companyId: string) {
  return { scopeKind: "company" as const, scopeId: companyId, stateKey: FAILURE_STREAK_KEY };
}

async function recordFailureStreak(ctx: PluginContext, companyId: string): Promise<number> {
  try {
    const prev = await ctx.state.get(failureStreakScope(companyId));
    const next = (typeof prev === "number" ? prev : 0) + 1;
    await ctx.state.set(failureStreakScope(companyId), next);
    return next;
  } catch {
    return 1;
  }
}

async function resetFailureStreak(ctx: PluginContext, companyId: string): Promise<void> {
  try {
    await ctx.state.set(failureStreakScope(companyId), 1);
  } catch {
    /* best-effort */
  }
}

async function applyRetention(
  ctx: PluginContext,
  cfg: InstanceConfig,
  scheduleId: string | null,
  destinationIds: string[],
) {
  const schedule = scheduleId ? cfg.schedules?.find((s) => s.id === scheduleId) : null;
  const keepLast = schedule?.keepLast ?? cfg.retention?.maxArchivesPerDestination ?? 365;
  for (const destId of destinationIds) {
    try {
      const adapter = await getAdapter(ctx, destId);
      const list = await adapter.list();
      list.sort((a, b) => (b.lastModified ?? "").localeCompare(a.lastModified ?? ""));
      const toDelete = list.slice(keepLast).map((o) => o.key);
      if (toDelete.length > 0) await adapter.delete(toDelete);
    } catch (err) {
      ctx.logger.warn("retention prune failed", { destId, err: String(err) });
    }
  }
}

// ─── One backup at a time, and Run now ───────────────────────────────────────
//
// Every backup, scheduled or Run now, takes its turn in one queue: the host
// makes one snapshot at a time (see backupQueue.ts).
//
// A backup takes about a minute and grows with the instance, but Paperclip
// stops waiting for a plugin request after 30 seconds. So Run now answers as
// soon as the backup row exists and the backup carries on in this worker. The
// row records how it ends, which is what the Backups page and
// backup_get_status read.

const backupQueue = createBackupQueue();

/**
 * Backups still at work. Not the same as the queue's: a backup its deadline
 * gave up on leaves the queue but goes on snapshotting or uploading.
 */
let backupsWorking = 0;

/** True while any backup is queued or still at work. */
function backupRunning(): boolean {
  return backupQueue.current() !== null || backupsWorking > 0;
}

/** The maxRunMinutes setting in milliseconds, or its default of 60 minutes. */
function maxRunMs(cfg: InstanceConfig): number {
  const minutes = cfg.maxRunMinutes;
  return (typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0 ? minutes : 60) * 60_000;
}

/** Queue a backup behind any backup already running or waiting. */
function queueBackup(
  ctx: PluginContext,
  cfg: InstanceConfig,
  cadence: BackupCadence,
  scheduleId: string | null,
  destinationIds: string[],
  triggeredBy: { actorId?: string; agentId?: string },
): BackupTurn {
  return backupQueue.enqueue({
    destinationIds,
    deadlineMs: maxRunMs(cfg),
    run: (turn) => {
      backupsWorking += 1;
      return runBackup(ctx, cadence, scheduleId, destinationIds, triggeredBy, turn).finally(() => {
        backupsWorking -= 1;
      });
    },
    giveUp: (backupId, reason, claimed) =>
      claimed
        ? recordFailedBackup(ctx, cfg, backupId, cadence, scheduleId, reason, [])
        : closeBackupRow(ctx, backupId, reason),
    report: (message, err) => ctx.logger.error(message, { err: String(err), cadence, scheduleId }),
  });
}

function sameDestinations(a: string[], b: string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((id) => right.has(id));
}

async function startManualBackup(
  ctx: PluginContext,
  cfg: InstanceConfig,
  destinationIds: string[],
  triggeredBy: { actorId?: string; agentId?: string },
  /** The caller picked these destinations rather than taking every enabled one. */
  chosen = false,
): Promise<{ backupId: string; status: "running"; alreadyRunning: boolean }> {
  // An apply is replacing the database. A backup now would copy a database
  // that is about to go, or be refused by Paperclip part way.
  if (activeRestore?.mode === "apply") {
    throw new Error("[EBACKUP_RESTORE_RUNNING] a restore is running, try again when it finishes");
  }
  // Nothing here awaits before queueBackup, so two callers cannot both find
  // the queue empty and start two backups.
  const running = backupQueue.current();
  if (running) {
    // Run now hands back the backup already running, scheduled or not. A
    // caller who picked other destinations would not get them from it.
    if (chosen && !sameDestinations(destinationIds, running.destinationIds)) {
      throw new Error("[EBACKUP_ALREADY_RUNNING] a backup is already running, try again when it finishes");
    }
    return { backupId: await running.started, status: "running", alreadyRunning: true };
  }
  if (destinationIds.length === 0) {
    throw new Error("[EBACKUP_NO_DESTINATIONS] no enabled destinations configured");
  }
  const turn = queueBackup(ctx, cfg, "manual", null, destinationIds, triggeredBy);
  return { backupId: await turn.started, status: "running", alreadyRunning: false };
}

// ─── Restore ─────────────────────────────────────────────────────────────────
//
// A restore replaces the whole instance database with an archive, so only an
// instance admin may preview or apply one. On the page that is
// hostScope.isInstanceAdmin, which the host sets and the browser cannot. The
// restore API routes are instance-admin routes, so the host checks those.
//
// A restore downloads and decrypts the whole archive before Paperclip replays
// it, which takes longer than the host's 30 seconds for a plugin request. So,
// like Run now, preview and apply answer as soon as the restore has started,
// and the page follows it through restore.status. Progress is kept here, not
// in the database: an apply replaces the tables the plugin's database calls go
// through, so those calls wait until it has finished.
//
// A preview decrypts and checks the whole archive here and keeps nothing.
// Paperclip reads an archive only to apply it.

const RESTORE_CONFIRM_PHRASE = "RESTORE THIS INSTANCE";

type RestoreMode = "preview" | "apply";
type RestoreConflictMode = "overwrite" | "skip" | "fail-on-conflict";

/** What the page and the restore API routes see of a restore. Never the passphrase. */
type RestoreView = {
  restoreId: string;
  mode: RestoreMode;
  status: "running" | "succeeded" | "failed";
  /** While it runs: fetching and decrypting the archive, or Paperclip at work on the dump. */
  stage: "download" | "paperclip" | null;
  destinationId: string;
  archiveKey: string;
  /** The person who asked, as the host or the API caller named them. */
  requestedBy: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** From the archive's envelope, once it has been read. */
  archive: { createdAt: string; instanceId: string; cadence: string; tables: number; rows: number } | null;
  /** How it ended: the preview's check, or Paperclip's answer to an apply. */
  result: { applied: boolean; dryRun: boolean; warnings: string[] } | null;
  error: string | null;
};

/** The restore running now. One at a time. */
let activeRestore: RestoreView | null = null;
/** Settles when the restore running now has ended. */
let activeRestoreEnded: Promise<void> = Promise.resolve();
/** The latest restore, running or finished. Kept until the worker restarts. */
let latestRestore: RestoreView | null = null;

/**
 * `ctx.system.restoreSnapshot`, the restore half of `createSnapshot`. Paperclip's
 * plugin toolkit has it from the release that added the
 * `system.snapshot.restore` capability. It is spelled out here so the plugin
 * still builds against an older vendored toolkit; a build made that way cannot
 * restore, and says so.
 */
export type SystemRestoreCall = (input: {
  filePath: string;
  mode: RestoreMode;
  conflictMode?: RestoreConflictMode;
  requestedByUserId?: string | null;
}) => Promise<{ applied: boolean; dryRun: boolean; touchedTables: string[]; warnings: string[] }>;

function hostRestore(ctx: PluginContext): SystemRestoreCall {
  const system = ctx.system as PluginContext["system"] & { restoreSnapshot?: SystemRestoreCall };
  if (typeof system.restoreSnapshot !== "function") {
    throw new Error(
      "[EBACKUP_RESTORE_UNSUPPORTED] this build of backup-tools cannot ask Paperclip for a restore; it needs rebuilding with Paperclip's current plugin toolkit",
    );
  }
  return (input) => system.restoreSnapshot!(input);
}

/** True only when the host says the caller is an instance admin. */
function hostSaysInstanceAdmin(params: Record<string, unknown>): boolean {
  return (params.hostScope as { isInstanceAdmin?: unknown } | undefined)?.isInstanceAdmin === true;
}

/** The few facts about an archive a person checks before restoring it. */
function describeArchive(envelope: ArchiveEnvelope): NonNullable<RestoreView["archive"]> {
  const counts = [
    ...Object.values(envelope.publicTableCounts ?? {}),
    ...(envelope.pluginNamespaces ?? []).flatMap((ns) => Object.values(ns.tableCounts ?? {})),
  ];
  return {
    createdAt: envelope.createdAt,
    instanceId: envelope.instanceId,
    cadence: envelope.cadence,
    tables: counts.length,
    rows: counts.reduce((sum, n) => sum + (Number.isFinite(n) ? n : 0), 0),
  };
}

type RestoreRequest = {
  mode: RestoreMode;
  destinationId?: unknown;
  archiveKey?: unknown;
  passphrase?: unknown;
  conflictMode?: unknown;
  confirmPhrase?: unknown;
  /** The person asking: the host's hostScope.userId, or the API caller's user. */
  requestedBy: string | null;
  /** The company the call came from. An apply's activity entry is filed there. */
  companyId: string | null;
};

/**
 * Start a preview or an apply and answer at once. The caller has already
 * checked that an instance admin asked. Nothing here awaits before
 * activeRestore is set, so two clicks cannot start two restores.
 */
function startRestore(ctx: PluginContext, request: RestoreRequest): { restoreId: string; mode: RestoreMode; status: "running" } {
  const destinationId = typeof request.destinationId === "string" ? request.destinationId.trim() : "";
  const archiveKey = typeof request.archiveKey === "string" ? request.archiveKey.trim() : "";
  if (!destinationId || !archiveKey) {
    throw new Error("[EBACKUP_RESTORE_INVALID] pick a destination and an archive to restore");
  }
  if (request.mode === "apply" && request.confirmPhrase !== RESTORE_CONFIRM_PHRASE) {
    throw new Error(`[EBACKUP_RESTORE_NOT_CONFIRMED] type ${RESTORE_CONFIRM_PHRASE} to apply a restore`);
  }
  if (activeRestore) {
    throw new Error("[EBACKUP_RESTORE_RUNNING] a restore is already running, wait for it to finish");
  }
  // Paperclip refuses a restore while it takes a snapshot, but a backup goes
  // on encrypting and uploading after that, even one its deadline gave up on.
  // A restore must not start under it.
  if (request.mode === "apply" && backupRunning()) {
    throw new Error("[EBACKUP_BACKUP_RUNNING] a backup is running, try the restore again when it finishes");
  }

  const restore: RestoreView = {
    restoreId: randomUUID(),
    mode: request.mode,
    status: "running",
    stage: "download",
    destinationId,
    archiveKey,
    requestedBy: request.requestedBy,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    archive: null,
    result: null,
    error: null,
  };
  activeRestore = restore;
  latestRestore = restore;
  // A blank passphrase means this instance's own key, the one its backups use.
  const passphrase = typeof request.passphrase === "string" && request.passphrase.length > 0 ? request.passphrase : null;
  const conflictMode: RestoreConflictMode =
    request.conflictMode === "skip" || request.conflictMode === "fail-on-conflict" ? request.conflictMode : "overwrite";
  activeRestoreEnded = runRestore(ctx, restore, passphrase, conflictMode, request.companyId).finally(() => {
    if (activeRestore === restore) activeRestore = null;
  });
  return { restoreId: restore.restoreId, mode: restore.mode, status: "running" };
}

/**
 * Settles once no apply is running, or after `maxWaitMs` in case one never
 * ends. A scheduled backup waits here rather than copying a database that is
 * being replaced, or being refused part way by Paperclip.
 */
async function applyEnded(maxWaitMs: number): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (activeRestore?.mode === "apply" && Date.now() < deadline) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      activeRestoreEnded,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
      }),
    ]);
    clearTimeout(timer);
  }
}

/** Fetch and decrypt the archive, then check it or hand it to Paperclip, recording how it went on `restore`. */
async function runRestore(
  ctx: PluginContext,
  restore: RestoreView,
  passphrase: string | null,
  conflictMode: RestoreConflictMode,
  companyId: string | null,
): Promise<void> {
  ctx.logger.info(`restore ${restore.mode} started`, {
    restoreId: restore.restoreId,
    destinationId: restore.destinationId,
    archiveKey: restore.archiveKey,
    requestedBy: restore.requestedBy,
  });
  let tempDir: string | null = null;
  try {
    const cfg = (await ctx.config.get()) as InstanceConfig;
    const key = passphrase ?? (await resolveEncryptionPassphrase(ctx, cfg));
    const adapter = await getAdapter(ctx, restore.destinationId);
    const { envelope, bytesConsumed } = decodeEnvelope(await adapter.downloadHead(restore.archiveKey));
    restore.archive = describeArchive(envelope);
    const body = skipBytes(await adapter.download(restore.archiveKey), bytesConsumed);
    if (restore.mode === "preview") {
      // Every part decrypted and checked, and the plain text thrown away.
      // Paperclip's own preview reads nothing but whether the file exists, so
      // writing the database to disk for it would buy nothing.
      await verifyArchive({ passphrase: key, envelope, encryptedBodyStream: body });
      restore.result = { applied: false, dryRun: true, warnings: [] };
    } else {
      const decrypted = await decryptArchiveForApply({ passphrase: key, envelope, encryptedBodyStream: body });
      tempDir = decrypted.dir;
      // Nothing should have started a backup since the check at the start,
      // but this is the last moment it can still be refused cleanly.
      if (backupRunning()) {
        throw new Error("[EBACKUP_BACKUP_RUNNING] a backup started while the archive was being prepared, try the restore again when it finishes");
      }
      restore.stage = "paperclip";
      const outcome = await hostRestore(ctx)({
        filePath: decrypted.sqlGzPath,
        mode: "apply",
        conflictMode,
        requestedByUserId: restore.requestedBy,
      });
      restore.result = { applied: outcome.applied, dryRun: outcome.dryRun, warnings: outcome.warnings ?? [] };
    }
    restore.status = "succeeded";
  } catch (err) {
    restore.error = err instanceof Error ? err.message : String(err);
    restore.status = "failed";
  } finally {
    restore.stage = null;
    restore.finishedAt = new Date().toISOString();
    // The decrypted dump is the whole database in plain text.
    if (tempDir) removeRestoreDir(tempDir);
  }
  const outcome = {
    restoreId: restore.restoreId,
    status: restore.status,
    requestedBy: restore.requestedBy,
    error: restore.error ?? undefined,
  };
  if (restore.status === "failed") ctx.logger.warn(`restore ${restore.mode} failed`, outcome);
  else ctx.logger.info(`restore ${restore.mode} finished`, outcome);
  if (restore.mode === "apply") await recordApplyActivity(ctx, restore, companyId);
}

/**
 * File an apply in the activity log once it has ended. An entry written when
 * it started would be gone: the apply replaces the activity log with the
 * archive's.
 */
async function recordApplyActivity(ctx: PluginContext, restore: RestoreView, companyId: string | null): Promise<void> {
  if (!companyId) {
    ctx.logger.warn("restore not filed in the activity log: the call named no company", { restoreId: restore.restoreId });
    return;
  }
  try {
    await ctx.activity.log({
      companyId,
      message: restore.status === "succeeded" ? "backup.restore.applied" : "backup.restore.failed",
      metadata: {
        restoreId: restore.restoreId,
        requestedByUserId: restore.requestedBy,
        destinationId: restore.destinationId,
        archiveKey: restore.archiveKey,
        archiveCreatedAt: restore.archive?.createdAt ?? null,
        archiveInstanceId: restore.archive?.instanceId ?? null,
        error: restore.error,
      },
    });
  } catch (err) {
    // The company may not be in the archive the instance now holds.
    ctx.logger.warn("could not file the restore in the activity log", {
      restoreId: restore.restoreId,
      err: String(err),
    });
  }
}

// ─── Tool / API handlers ─────────────────────────────────────────────────────

// Stashed at setup time so onApiRequest (which doesn't get a ctx parameter)
// can reuse the same context.
let stashedCtx: PluginContext | null = null;

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    stashedCtx = ctx;
    ctx.logger.info("backup-tools plugin setup");
    const cfg = (await ctx.config.get()) as InstanceConfig;

    if (!cfg.passphraseSecretRef) {
      ctx.logger.info("backup-tools: no passphraseSecretRef set — auto-key mode active. A random instance key will be generated on first backup and stored in the plugin database.");
    }
    if ((cfg.destinations ?? []).length === 0) {
      ctx.logger.warn("backup-tools: no destinations configured.");
    }
    if ((cfg.schedules ?? []).length > 0) {
      await ensureSchedulesSeeded(ctx, cfg.schedules!);
    }

    // Nothing runs in a worker that has only just started, so a backup still
    // marked running was cut off when the last worker stopped (a restart or an
    // upgrade mid-run). Close it, or the Backups page shows it running forever.
    await ctx.db
      .execute(
        `UPDATE ${TABLES.backups(ctx.db.namespace)} SET status = 'failed', completed_at = now(), error_summary = $1 WHERE status = 'running'`,
        ["[EBACKUP_INTERRUPTED] the plugin stopped before this backup finished"],
      )
      .catch((err: unknown) => {
        ctx.logger.warn("could not close backups left running", { err: String(err) });
      });

    // Likewise a decrypted dump left by a worker stopped mid-restore.
    sweepDecryptedLeftovers(ctx);

    // ─── Cadence jobs ────────────────────────────────────────────────────

    for (const cadence of ["hourly", "daily", "weekly", "monthly"] as const) {
      ctx.jobs.register(`cadence_${cadence}`, async () => {
        const due = await pickDueSchedules(ctx, cadence);
        if (due.length === 0) {
          ctx.logger.info(`cadence_${cadence}: no due schedules`);
          return;
        }
        ctx.logger.info(`cadence_${cadence}: running ${due.length} schedule(s)`);
        const cfgNow = (await ctx.config.get()) as InstanceConfig;
        for (const scheduleId of due) {
          const schedule = cfgNow.schedules?.find((s) => s.id === scheduleId);
          if (!schedule || schedule.enabled === false) {
            await ctx.db.execute(
              `UPDATE ${TABLES.scheduleState(ctx.db.namespace)} SET next_run_after = $2 WHERE schedule_id = $1`,
              [scheduleId, nextRunFor(cadence, new Date()).toISOString()],
            );
            continue;
          }
          // An apply is replacing the database: wait for it, then back up
          // what it restored. Bounded by maxRunMinutes in case it never ends.
          if (activeRestore?.mode === "apply") {
            ctx.logger.info(`cadence_${cadence}: waiting for a restore to finish`, { scheduleId });
            await applyEnded(maxRunMs(cfgNow));
          }
          // Waits its turn behind any backup already running, Run now's
          // included. Starting alongside it failed at once, because the host
          // refuses a second snapshot while one is in flight. The queue logs
          // a backup that fails.
          await queueBackup(ctx, cfgNow, cadence, scheduleId, schedule.destinationIds, {}).finished;
        }
      });
    }

    // ─── Tools ───────────────────────────────────────────────────────────

    ctx.tools.register(
      "backup_run_now",
      {
        displayName: "Run backup now",
        description: "Trigger an on-demand backup. Mutation-gated.",
        parametersSchema: { type: "object", properties: { destinationId: { type: "string" }, idempotencyKey: { type: "string" } } },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const cfgNow = (await ctx.config.get()) as InstanceConfig;
        if (cfgNow.mutationsEnabled !== true) {
          return { error: "[EDISABLED] backup_run_now requires mutationsEnabled=true on the plugin settings" };
        }
        if (!isCompanyAllowed(cfgNow.allowedCompanies, runCtx.companyId)) {
          assertCompanyAccess(ctx, {
            tool: "backup_run_now",
            resourceLabel: "backup-tools",
            resourceKey: "plugin",
            allowedCompanies: cfgNow.allowedCompanies,
            companyId: runCtx.companyId,
          });
        }
        const p = params as { destinationId?: string };
        const destinationIds = p.destinationId
          ? [p.destinationId]
          : (cfgNow.destinations ?? []).filter((d) => d.enabled !== false).map((d) => d.id);
        if (destinationIds.length === 0) {
          return { error: "[EBACKUP_NO_DESTINATIONS] no enabled destinations configured" };
        }
        // Answers once the backup has started. Waiting for the whole backup ran
        // past the host's 30 second limit on a tool call.
        let started: Awaited<ReturnType<typeof startManualBackup>>;
        try {
          started = await startManualBackup(ctx, cfgNow, destinationIds, { agentId: runCtx.agentId }, Boolean(p.destinationId));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const code = extractErrorCode(message);
          if (code === "EBACKUP_ALREADY_RUNNING" || code === "EBACKUP_RESTORE_RUNNING") return { error: message };
          throw err;
        }
        return {
          content: started.alreadyRunning
            ? `A backup is already running: id=${started.backupId}. Follow it with backup_get_status.`
            : `Backup started: id=${started.backupId}. It takes a minute or more. Follow it with backup_get_status.`,
          data: started,
        };
      },
    );

    ctx.tools.register(
      "backup_list_recent",
      {
        displayName: "List recent backups",
        description: "List recent backup runs.",
        parametersSchema: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 200, default: 20 },
            cadence: { type: "string" },
            status: { type: "string" },
          },
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const cfgNow = (await ctx.config.get()) as InstanceConfig;
        if (!isCompanyAllowed(cfgNow.allowedCompanies, runCtx.companyId)) {
          return { error: "[ECOMPANY_NOT_ALLOWED]" };
        }
        const p = params as { limit?: number; cadence?: string; status?: string };
        const limit = Math.min(Math.max(p.limit ?? 20, 1), 200);
        const filters: string[] = [];
        const args: unknown[] = [];
        if (p.cadence) { filters.push(`cadence = $${filters.length + 1}`); args.push(p.cadence); }
        if (p.status) { filters.push(`status = $${filters.length + 1}`); args.push(p.status); }
        const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
        const rows = await ctx.db.query<Record<string, unknown>>(
          `SELECT id, archive_uuid, cadence, schedule_id, status, started_at, completed_at, size_bytes, error_summary
           FROM ${TABLES.backups(ctx.db.namespace)} ${where} ORDER BY started_at DESC LIMIT ${limit}`,
          args,
        );
        return { content: `${rows.length} backup(s)`, data: { backups: rows } };
      },
    );

    ctx.tools.register(
      "backup_get_status",
      {
        displayName: "Get backup status",
        description: "Fetch one backup record + per-destination outcomes.",
        parametersSchema: { type: "object", required: ["backupId"], properties: { backupId: { type: "string" } } },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const cfgNow = (await ctx.config.get()) as InstanceConfig;
        if (!isCompanyAllowed(cfgNow.allowedCompanies, runCtx.companyId)) {
          return { error: "[ECOMPANY_NOT_ALLOWED]" };
        }
        const p = params as { backupId: string };
        const ns = ctx.db.namespace;
        const [backup] = await ctx.db.query<Record<string, unknown>>(
          `SELECT * FROM ${TABLES.backups(ns)} WHERE id = $1`, [p.backupId],
        );
        if (!backup) return { error: "[EBACKUP_NOT_FOUND]" };
        const dests = await ctx.db.query<Record<string, unknown>>(
          `SELECT * FROM ${TABLES.destResults(ns)} WHERE backup_id = $1`, [p.backupId],
        );
        return { data: { backup, destinations: dests } };
      },
    );

    ctx.tools.register(
      "backup_list_destinations",
      {
        displayName: "List destinations",
        description: "List configured destinations for the calling company.",
        parametersSchema: { type: "object", properties: {} },
      },
      async (_params, runCtx): Promise<ToolResult> => {
        const cfgNow = (await ctx.config.get()) as InstanceConfig;
        if (!isCompanyAllowed(cfgNow.allowedCompanies, runCtx.companyId)) {
          return { error: "[ECOMPANY_NOT_ALLOWED]" };
        }
        const dests = (cfgNow.destinations ?? []).filter((d) => d.enabled !== false).map((d) => ({
          id: d.id, kind: d.kind, label: d.label,
        }));
        return { data: { destinations: dests } };
      },
    );

    ctx.tools.register(
      "backup_archive_describe",
      {
        displayName: "Describe archive",
        description: "Read the manifest envelope of a remote archive without downloading the body.",
        parametersSchema: {
          type: "object", required: ["destinationId", "archiveKey"],
          properties: { destinationId: { type: "string" }, archiveKey: { type: "string" } },
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const cfgNow = (await ctx.config.get()) as InstanceConfig;
        if (!isCompanyAllowed(cfgNow.allowedCompanies, runCtx.companyId)) {
          return { error: "[ECOMPANY_NOT_ALLOWED]" };
        }
        const p = params as { destinationId: string; archiveKey: string };
        const adapter = await getAdapter(ctx, p.destinationId);
        const head = await adapter.downloadHead(p.archiveKey);
        try {
          const { envelope } = decodeEnvelope(head);
          return { data: { envelope } };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    );

    // ─── Streams + UI data feeds ─────────────────────────────────────────

    ctx.data.register("sidebar.visibility", async (params: Record<string, unknown>) => {
      const companyId = (params.companyId as string) ?? "";
      const cfgNow = (await ctx.config.get()) as InstanceConfig;
      return { visible: isCompanyAllowed(cfgNow.allowedCompanies, companyId) };
    });

    ctx.data.register("dashboard.health", async (params: Record<string, unknown>) => {
      // Backup status is for the companies on the allowed list. This had no
      // check, so the dashboard widget showed it to every company. hostScope
      // is the company the host checked; the page cannot forge it.
      const companyId = (params.hostScope as { companyId?: string | null } | undefined)?.companyId ?? "";
      const cfgNow = (await ctx.config.get()) as InstanceConfig;
      if (!isCompanyAllowed(cfgNow.allowedCompanies, companyId)) {
        throw new Error("[ECOMPANY_NOT_ALLOWED]");
      }
      const ns2 = ctx.db.namespace;
      const [last] = await ctx.db.query<{
        status: string;
        started_at: string;
        size_bytes: number | null;
        cadence: string;
      }>(
        // cadence is selected because the Overview card renders it. It was left
        // out of this list, so the card printed a bare "Cadence:" with nothing
        // after it.
        `SELECT status, started_at, size_bytes, cadence FROM ${TABLES.backups(ns2)} ORDER BY started_at DESC LIMIT 1`,
      );
      const dueRows = await ctx.db.query<{ next_run_after: string }>(
        `SELECT next_run_after FROM ${TABLES.scheduleState(ns2)} ORDER BY next_run_after ASC LIMIT 1`,
      );
      return {
        lastRun: last ?? null,
        nextRunAfter: dueRows[0]?.next_run_after ?? null,
      };
    });

    // The History and Destinations tabs call these through usePluginData, which
    // resolves against this registry — NOT the routeKey dispatch in
    // onApiRequest, where `backups.list` and `destinations.list` also exist.
    // Only the API side was ever wired up, so getData threw "no data handler
    // registered" on every render and both tabs sat empty forever: History said
    // "No backups yet" next to an Overview card reporting a successful backup.

    ctx.data.register("backups.list", async (params: Record<string, unknown>) => {
      const companyId = (params.companyId as string) ?? "";
      const cfgNow = (await ctx.config.get()) as InstanceConfig;
      if (!isCompanyAllowed(cfgNow.allowedCompanies, companyId)) {
        throw new Error("[ECOMPANY_NOT_ALLOWED]");
      }
      const backups = await ctx.db.query(
        `SELECT id, archive_uuid, cadence, schedule_id, status, started_at, completed_at, size_bytes
         FROM ${TABLES.backups(ctx.db.namespace)} ORDER BY started_at DESC LIMIT 100`,
      );
      return { backups };
    });

    ctx.data.register("destinations.list", async (params: Record<string, unknown>) => {
      const companyId = (params.companyId as string) ?? "";
      const cfgNow = (await ctx.config.get()) as InstanceConfig;
      if (!isCompanyAllowed(cfgNow.allowedCompanies, companyId)) {
        throw new Error("[ECOMPANY_NOT_ALLOWED]");
      }
      const destinations = (cfgNow.destinations ?? [])
        .filter((d) => d.enabled !== false)
        .map((d) => ({ id: d.id, kind: d.kind, label: d.label }));
      return { destinations };
    });

    // The Overview tab's Run now button calls usePluginAction, which resolves
    // against this registry, not the routeKey dispatch in onApiRequest where
    // backups.run-now also exists. Nothing was registered here, so the button
    // failed at once with "No action or operation handler registered" and
    // never started a backup.
    ctx.actions.register("backups.run-now", async (params: Record<string, unknown>) => {
      // hostScope is the company the host checked. The page cannot forge it.
      const companyId = (params.hostScope as { companyId?: string | null } | undefined)?.companyId ?? "";
      const cfgNow = (await ctx.config.get()) as InstanceConfig;
      assertCompanyAccess(ctx, {
        tool: "backups.run-now",
        resourceLabel: "backup-tools",
        resourceKey: "plugin",
        allowedCompanies: cfgNow.allowedCompanies,
        companyId,
      });
      const destinationIds = (cfgNow.destinations ?? []).filter((d) => d.enabled !== false).map((d) => d.id);
      return await startManualBackup(ctx, cfgNow, destinationIds, {});
    });

    // The Restore tab's Preview and Apply called these keys, and nothing was
    // registered under them, so both failed at once like Run now did. Only an
    // instance admin may preview or apply a restore, whatever the allowed
    // list says. The tab shows its controls only to instance admins, but the
    // check that counts is the one in each action.
    ctx.data.register("restore.status", async (params: Record<string, unknown>) => {
      const isInstanceAdmin = hostSaysInstanceAdmin(params);
      return { isInstanceAdmin, restore: isInstanceAdmin && latestRestore ? { ...latestRestore } : null };
    });

    for (const mode of ["preview", "apply"] as const) {
      ctx.actions.register(`restore.${mode}`, async (params: Record<string, unknown>) => {
        if (!hostSaysInstanceAdmin(params)) {
          throw new Error("[EBACKUP_RESTORE_NOT_ADMIN] only an instance admin can preview or apply a restore");
        }
        const hostScope = params.hostScope as { userId?: unknown; companyId?: unknown };
        return startRestore(ctx, {
          mode,
          destinationId: params.destinationId,
          archiveKey: params.archiveKey,
          passphrase: params.passphrase,
          conflictMode: params.conflictMode,
          confirmPhrase: params.confirmPhrase,
          requestedBy: typeof hostScope.userId === "string" ? hostScope.userId : null,
          companyId: typeof hostScope.companyId === "string" ? hostScope.companyId : null,
        });
      });
    }
  },

  // ─── API request dispatch ────────────────────────────────────────────────

  async onApiRequest(input: PluginApiRequestInput): Promise<PluginApiResponse> {
    return await handleApi(input).catch((err) => ({
      status: 500,
      body: { error: err instanceof Error ? err.message : String(err) },
    }));
  },

  async onConfigChanged(_newCfg: Record<string, unknown>): Promise<void> {
    clearAdapterCache();
  },

  async onShutdown(): Promise<void> {
    // The worker exits after this, so a restore under way never reaches its
    // own cleanup, and the dump it decrypted is the whole database in plain
    // text. If the folder cannot go now (Paperclip still has the file open),
    // the next worker's start removes it.
    if (restoreTempDir) removeRestoreDir(restoreTempDir);
  },

  async onHealth() {
    return { status: "ok", message: "backup-tools ready" };
  },
});

async function handleApi(input: PluginApiRequestInput): Promise<PluginApiResponse> {
  const ctx = stashedCtx;
  if (!ctx) return { status: 503, body: { error: "backup-tools not initialised" } };
  const { routeKey, params, query, body } = input;
  // The host only checks that the caller belongs to the company in
  // ?companyId=. Without this, a member of any company could start a
  // whole-instance backup, list the archives or probe the destinations.
  const cfgAccess = (await ctx.config.get()) as InstanceConfig;
  if (!isCompanyAllowed(cfgAccess.allowedCompanies, input.companyId)) {
    return {
      status: 403,
      body: { error: `[ECOMPANY_NOT_ALLOWED] backup-tools is not assigned to company ${input.companyId}.` },
    };
  }
  switch (routeKey) {
    case "destinations.list": {
      const cfgNow = (await ctx.config.get()) as InstanceConfig;
      const dests = (cfgNow.destinations ?? []).filter((d) => d.enabled !== false).map((d) => ({
        id: d.id, kind: d.kind, label: d.label,
      }));
      return { status: 200, body: { destinations: dests } };
    }
    case "destinations.health": {
      const adapter = await getAdapter(ctx, (params as { id: string }).id);
      const result = await adapter.healthCheck();
      return { status: 200, body: result };
    }
    case "destinations.list-archives": {
      const adapter = await getAdapter(ctx, (params as { id: string }).id);
      const archives = await adapter.list();
      return { status: 200, body: { archives } };
    }
    case "backups.list": {
      const rows = await ctx.db.query(
        `SELECT id, archive_uuid, cadence, schedule_id, status, started_at, completed_at, size_bytes
         FROM ${TABLES.backups(ctx.db.namespace)} ORDER BY started_at DESC LIMIT 100`,
      );
      return { status: 200, body: { backups: rows } };
    }
    case "backups.get": {
      const id = (params as { id: string }).id;
      const ns3 = ctx.db.namespace;
      const [backup] = await ctx.db.query(`SELECT * FROM ${TABLES.backups(ns3)} WHERE id = $1`, [id]);
      if (!backup) return { status: 404, body: { error: "[EBACKUP_NOT_FOUND]" } };
      const dests = await ctx.db.query(`SELECT * FROM ${TABLES.destResults(ns3)} WHERE backup_id = $1`, [id]);
      return { status: 200, body: { backup, destinations: dests } };
    }
    case "backups.run-now": {
      const cfgNow = (await ctx.config.get()) as InstanceConfig;
      const b = (body ?? {}) as { destinationIds?: string[] };
      const chosen = Boolean(b.destinationIds && b.destinationIds.length > 0);
      const destinationIds = chosen
        ? b.destinationIds!
        : (cfgNow.destinations ?? []).filter((d) => d.enabled !== false).map((d) => d.id);
      // 202: the backup has started, not finished. Waiting for it ran past
      // the host's 30 second limit and answered 502 for a backup that worked.
      try {
        return { status: 202, body: await startManualBackup(ctx, cfgNow, destinationIds, {}, chosen) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = extractErrorCode(message);
        if (code === "EBACKUP_ALREADY_RUNNING" || code === "EBACKUP_RESTORE_RUNNING") {
          return { status: 409, body: { error: message } };
        }
        if (code === "EBACKUP_NO_DESTINATIONS") return { status: 400, body: { error: message } };
        throw err;
      }
    }
    case "manifest-of": {
      const p = params as { destinationId: string; archiveKey: string };
      const adapter = await getAdapter(ctx, p.destinationId);
      const head = await adapter.downloadHead(p.archiveKey);
      const { envelope } = decodeEnvelope(head);
      return { status: 200, body: { envelope } };
    }
    case "schedules.run-due-eval": {
      const id = (params as { id: string }).id;
      const [row] = await ctx.db.query<{ schedule_id: string; cadence: string; next_run_after: string }>(
        `SELECT schedule_id, cadence, next_run_after FROM ${TABLES.scheduleState(ctx.db.namespace)} WHERE schedule_id = $1`, [id],
      );
      if (!row) return { status: 404, body: { error: "schedule not seeded" } };
      const due = new Date(row.next_run_after) <= new Date();
      return { status: 200, body: { ...row, due } };
    }
    case "instance-key.export": {
      const cfgNow = (await ctx.config.get()) as InstanceConfig;
      if (cfgNow.passphraseSecretRef) {
        return { status: 200, body: { mode: "passphrase", message: "This instance uses a user-managed passphrase. Export it from your password manager for cross-instance restores." } };
      }
      const ns4 = ctx.db.namespace;
      const [keyRow] = await ctx.db.query<{ key_hex: string; created_at: string }>(
        `SELECT key_hex, created_at FROM ${TABLES.instanceKeys(ns4)} WHERE key_id = $1`,
        [AUTO_KEY_ID],
      );
      if (!keyRow) {
        return { status: 404, body: { error: "Auto-key not yet generated — run one backup first." } };
      }
      return { status: 200, body: { mode: "auto-key", keyHex: keyRow.key_hex, createdAt: keyRow.created_at, note: "Store this key safely outside Paperclip. Paste it as the passphrase when restoring to a different instance." } };
    }
    case "restore.preview":
    case "restore.apply": {
      // The host lets only instance admins reach these two routes. Like the
      // page's actions they answer once the restore has started: waiting for
      // it ran past the host's 30 seconds. Follow it with restore.get.
      const b = (body ?? {}) as Record<string, unknown>;
      try {
        return {
          status: 202,
          body: startRestore(ctx, {
            mode: routeKey === "restore.apply" ? "apply" : "preview",
            destinationId: b.destinationId,
            archiveKey: b.archiveKey,
            passphrase: b.passphrase,
            conflictMode: b.conflictMode,
            confirmPhrase: b.confirmPhrase,
            requestedBy: input.actor.userId ?? input.actor.actorId ?? null,
            companyId: input.companyId,
          }),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = extractErrorCode(message);
        if (code === "EBACKUP_RESTORE_RUNNING" || code === "EBACKUP_BACKUP_RUNNING") {
          return { status: 409, body: { error: message } };
        }
        if (code === "EBACKUP_RESTORE_INVALID" || code === "EBACKUP_RESTORE_NOT_CONFIRMED") {
          return { status: 400, body: { error: message } };
        }
        throw err;
      }
      // Until 0.1.33 these routes waited for the whole restore and posted the
      // decrypted dump to Paperclip's own HTTP API. That could never work from
      // a worker: the route is for instance admins, which a worker cannot be,
      // and plugin HTTP refuses loopback and private addresses. Kept for
      // reference; restores go through ctx.system.restoreSnapshot now.
      //
      // const apply = routeKey === "restore.apply";
      // const cfgNow = (await ctx.config.get()) as InstanceConfig;
      // const b = (body ?? {}) as {
      //   destinationId?: string; archiveKey?: string; passphrase?: string;
      //   conflictMode?: string; confirmPhrase?: string;
      // };
      // if (!b.destinationId || !b.archiveKey) {
      //   return { status: 400, body: { error: "destinationId and archiveKey required" } };
      // }
      // if (apply && b.confirmPhrase !== "RESTORE THIS INSTANCE") {
      //   return { status: 400, body: { error: "confirmPhrase must equal 'RESTORE THIS INSTANCE'" } };
      // }
      // // Passphrase is optional: if omitted, the auto-key is loaded from the
      // // plugin DB. For cross-instance restores in auto-key mode, the caller
      // // must export the key first and pass it here explicitly.
      // const restorePassphrase = b.passphrase ?? await resolveEncryptionPassphrase(ctx, cfgNow);
      // const adapter = await getAdapter(ctx, b.destinationId);
      // const headBytes = await adapter.downloadHead(b.archiveKey);
      // const { envelope, bytesConsumed } = decodeEnvelope(headBytes);
      // const fullStream = await adapter.download(b.archiveKey);
      // // Skip the envelope bytes already consumed.
      // const skipped = await skipBytes(fullStream, bytesConsumed);
      // const { sqlGzPath } = await decryptArchiveToTmpSql({
      //   passphrase: restorePassphrase,
      //   envelope,
      //   encryptedBodyStream: skipped,
      // });
      // try {
      //   const apiBase = process.env.PAPERCLIP_API_URL?.replace(/\/+$/, "") ?? "";
      //   if (!apiBase) return { status: 500, body: { error: "[EBACKUP_NO_API_URL] worker has no PAPERCLIP_API_URL" } };
      //   const url = `${apiBase}/api/system/snapshot/restore?mode=${apply ? "apply" : "preview"}&conflict=${b.conflictMode ?? "overwrite"}`;
      //   const sqlBody = createReadStream(sqlGzPath);
      //   const resp = await ctx.http.fetch(url, {
      //     method: "POST",
      //     headers: { "Content-Type": "application/gzip" },
      //     body: sqlBody as unknown as BodyInit,
      //     // @ts-expect-error duplex is required by Node fetch when streaming a request body
      //     duplex: "half",
      //   });
      //   const text = await resp.text();
      //   if (!resp.ok) return { status: 502, body: { error: text } };
      //   return { status: 200, body: JSON.parse(text) };
      // } finally {
      //   try { unlinkSync(sqlGzPath); } catch { /* best-effort */ }
      // }
    }
    case "restore.get": {
      const id = (params as { id: string }).id;
      if (!latestRestore || latestRestore.restoreId !== id) {
        return {
          status: 404,
          body: { error: "[EBACKUP_RESTORE_NOT_FOUND] only the latest restore is kept, and not across a restart" },
        };
      }
      return { status: 200, body: { ...latestRestore } };
    }
    default:
      return { status: 404, body: { error: `Unknown route: ${routeKey}` } };
  }
}

/**
 * The archive's body: the stream with its first `bytes` (the envelope) skipped.
 *
 * This used to read the stream in two `for await` loops, one after the other.
 * Leaving the first loop destroys the stream, so the second got nothing, and
 * any archive longer than one read never decrypted. It reads once now.
 */
function skipBytes(stream: NodeJS.ReadableStream, bytes: number): NodeJS.ReadableStream {
  return Readable.from(
    (async function* () {
      let remaining = bytes;
      for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
        if (remaining >= chunk.byteLength) {
          remaining -= chunk.byteLength;
          continue;
        }
        yield remaining > 0 ? chunk.subarray(remaining) : chunk;
        remaining = 0;
      }
    })(),
  );
}

export default plugin;
runWorker(plugin, import.meta.url);

// Keep this referenced so esbuild doesn't drop.
void Writable;
void PassThrough;
void pipeline;
void mkdirSync;
