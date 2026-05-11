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
 * core `/api/system/snapshot*` endpoints. The plugin never reads or writes
 * core tables directly.
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
import { createReadStream, createWriteStream, existsSync, statSync, mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { assertCompanyAccess, isCompanyAllowed } from "./companyAccess.js";
import {
  CHUNK_SIZE_BYTES,
  NONCE_LENGTH,
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
}> {
  // The plugin worker has http.outbound capability and runs on the same
  // box as the host (or at least within reach). We point at the host's
  // internal API URL via the standard PAPERCLIP_API_URL env var that's
  // baked into the worker process at spawn time.
  const apiBase = process.env.PAPERCLIP_API_URL?.replace(/\/+$/, "") ?? "";
  if (!apiBase) {
    throw new Error("[EBACKUP_NO_API_URL] worker has no PAPERCLIP_API_URL — cannot reach core /api/system/snapshot");
  }
  const resp = await ctx.http.fetch(`${apiBase}/api/system/snapshot`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`[EBACKUP_SNAPSHOT_FETCH_FAILED] HTTP ${resp.status}: ${body.slice(0, 300)}`);
  }
  const manifestB64 = resp.headers.get("X-Paperclip-Snapshot-Manifest");
  if (!manifestB64) throw new Error("[EBACKUP_SNAPSHOT_NO_MANIFEST] core response missing X-Paperclip-Snapshot-Manifest");
  const manifest = JSON.parse(Buffer.from(manifestB64, "base64").toString("utf8")) as {
    instanceId: string;
    snapshotUuid: string;
    createdAt: string;
    publicTableCounts: Record<string, number>;
    pluginNamespaces: Array<{ pluginKey: string; pluginVersion: string; namespaceName: string; tableCounts: Record<string, number> }>;
    excludedPluginNamespaces: Array<{ pluginKey: string; pluginVersion: string; namespaceName: string; reason: string }>;
    estimatedUncompressedBytes: number;
  };
  if (!resp.body) throw new Error("[EBACKUP_SNAPSHOT_NO_BODY] core response had no body stream");
  const bodyStream = Readable.fromWeb(resp.body as unknown as import("node:stream/web").ReadableStream);
  const sizeHeader = resp.headers.get("Content-Length");
  return {
    manifest: manifest as never,
    snapshotUuid: manifest.snapshotUuid,
    instanceId: manifest.instanceId,
    createdAt: manifest.createdAt,
    publicTableCounts: manifest.publicTableCounts,
    pluginNamespaces: manifest.pluginNamespaces,
    excludedPluginNamespaces: manifest.excludedPluginNamespaces,
    estimatedUncompressedBytes: manifest.estimatedUncompressedBytes,
    bodyStream,
    bodySizeHint: sizeHeader ? Number(sizeHeader) : undefined,
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

async function decryptArchiveToTmpSql(input: {
  passphrase: string;
  envelope: ArchiveEnvelope;
  encryptedBodyStream: NodeJS.ReadableStream;
}): Promise<{ sqlGzPath: string }> {
  const salt = Buffer.from(input.envelope.salt, "base64url");
  const { bodyKey, hmacKey } = await deriveKeys({
    passphrase: input.passphrase,
    salt: new Uint8Array(salt.buffer, salt.byteOffset, salt.byteLength),
    params: input.envelope.kdfParams,
  });
  // Verify the envelope HMAC against the canonical form.
  if (!verifyEnvelopeHmac(hmacKey, canonicalizeForHmac(input.envelope), input.envelope.hmac)) {
    throw new Error("[EBACKUP_INTEGRITY_FAILED] envelope HMAC verification failed");
  }
  const decipher = createChunkDecipher(bodyKey);
  const sqlGzPath = join(tmpdir(), `pcback-decrypt-${randomUUID()}.sql.gz`);
  const out = createWriteStream(sqlGzPath);

  let buffer = new Uint8Array(0);
  const reader = input.encryptedBodyStream as unknown as AsyncIterable<Uint8Array>;
  let endOfStream = false;
  for await (const chunk of reader) {
    if (endOfStream) break;
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
      if (buffer.length < 4 + len) break; // wait for more bytes
      const nonce = buffer.subarray(4, 4 + NONCE_LENGTH);
      const ct = buffer.subarray(4 + NONCE_LENGTH, 4 + len);
      const pt = decipher.decryptChunk(nonce, ct);
      out.write(Buffer.from(pt));
      buffer = buffer.subarray(4 + len);
    }
  }
  if (!endOfStream) {
    // Process trailing chunk without sentinel (writer likely cut off mid-stream)
    if (buffer.length >= 4) {
      const len = new DataView(buffer.buffer, buffer.byteOffset, 4).getUint32(0, false);
      if (len > 0 && buffer.length >= 4 + len) {
        const nonce = buffer.subarray(4, 4 + NONCE_LENGTH);
        const ct = buffer.subarray(4 + NONCE_LENGTH, 4 + len);
        const pt = decipher.decryptChunk(nonce, ct);
        out.write(Buffer.from(pt));
      }
    }
  }
  await new Promise<void>((resolve, reject) => {
    out.end((err: unknown) => (err ? reject(err) : resolve()));
  });
  return { sqlGzPath };
}

// ─── runBackup — the main fan-out path ──────────────────────────────────────

type BackupCadence = ScheduleEntry["cadence"] | "manual";

async function runBackup(
  ctx: PluginContext,
  cadence: BackupCadence,
  scheduleId: string | null,
  destinationIds: string[],
  triggeredBy: { actorId?: string; agentId?: string },
): Promise<{ backupId: string; status: "succeeded" | "failed" | "partial"; sizeBytes: number }> {
  const cfg = (await ctx.config.get()) as InstanceConfig;
  const passphrase = await resolveEncryptionPassphrase(ctx, cfg);

  const ns = ctx.db.namespace;
  const archiveUuid = generateArchiveUuid();
  const startedAt = new Date();
  const backupId = randomUUID();

  await ctx.db.execute(
    `INSERT INTO ${TABLES.backups(ns)} (id, archive_uuid, cadence, schedule_id, status, started_at, triggered_by_actor_id, triggered_by_agent_id)
     VALUES ($1, $2, $3, $4, 'running', $5, $6, $7)`,
    [backupId, archiveUuid, cadence, scheduleId, startedAt.toISOString(), triggeredBy.actorId ?? null, triggeredBy.agentId ?? null],
  );

  let archiveFilePath: string | null = null;
  let envelope: ArchiveEnvelope | null = null;
  let archiveSizeBytes = 0;
  const perDestResults: { id: string; status: "succeeded" | "failed"; remoteKey?: string; error?: string }[] = [];

  try {
    // 1) pull snapshot from core (streamed)
    const snap = await fetchSnapshotFromCore(ctx);

    // 2) encrypt to tmp file (we need a real file because we may upload to N destinations)
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

    await ctx.db.execute(
      `UPDATE ${TABLES.backups(ns)} SET status = $2, completed_at = now(), size_bytes = $3, manifest_json = $4 WHERE id = $1`,
      [backupId, finalStatus, archiveSizeBytes, JSON.stringify(envelope)],
    );

    if (scheduleId && cadence !== "manual") {
      await updateScheduleAfterRun(ctx, scheduleId, cadence, finalStatus);
    }

    if (finalStatus !== "succeeded") {
      await maybeCreateFailureIssue(ctx, cfg, backupId, finalStatus, perDestResults);
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
    await ctx.db.execute(
      `UPDATE ${TABLES.backups(ns)} SET status = 'failed', completed_at = now(), error_summary = $2 WHERE id = $1`,
      [backupId, errMsg.slice(0, 1000)],
    );
    if (scheduleId && cadence !== "manual") {
      await updateScheduleAfterRun(ctx, scheduleId, cadence, "failed");
    }
    await maybeCreateFailureIssue(ctx, cfg, backupId, "failed", perDestResults, errMsg);
    return { backupId, status: "failed", sizeBytes: archiveSizeBytes };
  } finally {
    if (archiveFilePath && existsSync(archiveFilePath)) {
      try { unlinkSync(archiveFilePath); } catch { /* best-effort */ }
    }
  }
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
  const failureSummary =
    topLevelError ??
    perDest
      .filter((d) => d.status === "failed")
      .map((d) => `- ${d.id}: ${d.error}`)
      .join("\n");
  try {
    await ctx.issues.create({
      companyId: cfg.alertOnFailureToCompanyId,
      title: `[backup-tools] backup ${status} (${backupId.slice(0, 8)})`,
      body: `Backup run \`${backupId}\` finished with status \`${status}\`.\n\n${failureSummary}\n\nSee plugin dashboard for the full per-destination breakdown.`,
    } as never);
  } catch (err) {
    ctx.logger.warn("alertOnFailureToCompanyId issue creation failed", { err: String(err) });
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
          try {
            await runBackup(ctx, cadence, scheduleId, schedule.destinationIds, {});
          } catch (err) {
            ctx.logger.error(`cadence_${cadence}: schedule ${scheduleId} failed`, { err: String(err) });
          }
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
        const result = await runBackup(ctx, "manual", null, destinationIds, { agentId: runCtx.agentId });
        return { content: `Backup ${result.status}: id=${result.backupId} size=${result.sizeBytes}B`, data: result };
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

    ctx.data.register("dashboard.health", async () => {
      const ns2 = ctx.db.namespace;
      const [last] = await ctx.db.query<{ status: string; started_at: string; size_bytes: number | null }>(
        `SELECT status, started_at, size_bytes FROM ${TABLES.backups(ns2)} ORDER BY started_at DESC LIMIT 1`,
      );
      const dueRows = await ctx.db.query<{ next_run_after: string }>(
        `SELECT next_run_after FROM ${TABLES.scheduleState(ns2)} ORDER BY next_run_after ASC LIMIT 1`,
      );
      return {
        lastRun: last ?? null,
        nextRunAfter: dueRows[0]?.next_run_after ?? null,
      };
    });
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

  async onHealth() {
    return { status: "ok", message: "backup-tools ready" };
  },
});

async function handleApi(input: PluginApiRequestInput): Promise<PluginApiResponse> {
  const ctx = stashedCtx;
  if (!ctx) return { status: 503, body: { error: "backup-tools not initialised" } };
  const { routeKey, params, query, body } = input;
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
      const destinationIds = b.destinationIds && b.destinationIds.length > 0
        ? b.destinationIds
        : (cfgNow.destinations ?? []).filter((d) => d.enabled !== false).map((d) => d.id);
      const result = await runBackup(ctx, "manual", null, destinationIds, {});
      return { status: 201, body: result };
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
      const apply = routeKey === "restore.apply";
      const cfgNow = (await ctx.config.get()) as InstanceConfig;
      const b = (body ?? {}) as {
        destinationId?: string; archiveKey?: string; passphrase?: string;
        conflictMode?: string; confirmPhrase?: string;
      };
      if (!b.destinationId || !b.archiveKey) {
        return { status: 400, body: { error: "destinationId and archiveKey required" } };
      }
      if (apply && b.confirmPhrase !== "RESTORE THIS INSTANCE") {
        return { status: 400, body: { error: "confirmPhrase must equal 'RESTORE THIS INSTANCE'" } };
      }
      // Passphrase is optional: if omitted, the auto-key is loaded from the
      // plugin DB. For cross-instance restores in auto-key mode, the caller
      // must export the key first and pass it here explicitly.
      const restorePassphrase = b.passphrase ?? await resolveEncryptionPassphrase(ctx, cfgNow);
      const adapter = await getAdapter(ctx, b.destinationId);
      const headBytes = await adapter.downloadHead(b.archiveKey);
      const { envelope, bytesConsumed } = decodeEnvelope(headBytes);
      const fullStream = await adapter.download(b.archiveKey);
      // Skip the envelope bytes already consumed.
      const skipped = await skipBytes(fullStream, bytesConsumed);
      const { sqlGzPath } = await decryptArchiveToTmpSql({
        passphrase: restorePassphrase,
        envelope,
        encryptedBodyStream: skipped,
      });
      try {
        const apiBase = process.env.PAPERCLIP_API_URL?.replace(/\/+$/, "") ?? "";
        if (!apiBase) return { status: 500, body: { error: "[EBACKUP_NO_API_URL] worker has no PAPERCLIP_API_URL" } };
        const url = `${apiBase}/api/system/snapshot/restore?mode=${apply ? "apply" : "preview"}&conflict=${b.conflictMode ?? "overwrite"}`;
        const sqlBody = createReadStream(sqlGzPath);
        const resp = await ctx.http.fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/gzip" },
          body: sqlBody as unknown as BodyInit,
          // @ts-expect-error duplex is required by Node fetch when streaming a request body
          duplex: "half",
        });
        const text = await resp.text();
        if (!resp.ok) return { status: 502, body: { error: text } };
        return { status: 200, body: JSON.parse(text) };
      } finally {
        try { unlinkSync(sqlGzPath); } catch { /* best-effort */ }
      }
    }
    default:
      return { status: 404, body: { error: `Unknown route: ${routeKey}` } };
  }
}

async function skipBytes(stream: NodeJS.ReadableStream, bytes: number): Promise<NodeJS.ReadableStream> {
  // Read+discard `bytes` from the stream, then return the same stream
  // for further consumption.
  let remaining = bytes;
  return new Readable({
    async read() {
      if (remaining > 0) {
        // Drain `remaining` bytes from upstream first.
        const reader = stream as unknown as AsyncIterable<Uint8Array>;
        for await (const chunk of reader) {
          if (chunk.byteLength <= remaining) {
            remaining -= chunk.byteLength;
            if (remaining === 0) break;
            continue;
          }
          const tail = chunk.subarray(remaining);
          remaining = 0;
          this.push(Buffer.from(tail));
          break;
        }
      }
      // Now pipe the rest through.
      const reader = stream as unknown as AsyncIterable<Uint8Array>;
      for await (const chunk of reader) {
        if (!this.push(Buffer.from(chunk))) {
          break;
        }
      }
      this.push(null);
    },
  });
}

export default plugin;
runWorker(plugin, import.meta.url);

// Keep this referenced so esbuild doesn't drop.
void Writable;
void PassThrough;
void pipeline;
void mkdirSync;
