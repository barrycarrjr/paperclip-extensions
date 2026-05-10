/**
 * Adapter factory: turn an `instanceConfig.destinations[]` entry into a
 * concrete BackupDestinationAdapter. Resolves secret-refs to real values
 * via ctx.secrets.resolve at construction time.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { BackupDestinationAdapter } from "./types.js";
import { S3Adapter, type S3AdapterConfig } from "./s3.js";
import { GoogleDriveAdapter, type GoogleDriveAdapterConfig } from "./googleDrive.js";
import { LocalAdapter, type LocalAdapterConfig } from "./local.js";

export type DestinationConfigEntry = {
  id: string;
  kind: "s3" | "google-drive" | "local" | "nas-smb";
  label: string;
  enabled?: boolean;
  config: Record<string, unknown>;
};

export async function createAdapterForDestination(
  ctx: PluginContext,
  entry: DestinationConfigEntry,
): Promise<BackupDestinationAdapter> {
  if (entry.kind === "s3") {
    const cfg = entry.config as Partial<{
      endpoint: string;
      region: string;
      bucket: string;
      prefix: string;
      accessKeyIdSecretRef: string;
      secretAccessKeySecretRef: string;
      forcePathStyle: boolean;
      serverSideEncryption: "" | "AES256" | "aws:kms";
    }>;
    if (!cfg.region || !cfg.bucket || !cfg.accessKeyIdSecretRef || !cfg.secretAccessKeySecretRef) {
      throw new Error(
        `[EBACKUP_DEST_CONFIG_INCOMPLETE] destination ${entry.id}: s3 requires region, bucket, accessKeyIdSecretRef, secretAccessKeySecretRef`,
      );
    }
    const accessKeyId = await ctx.secrets.resolve(cfg.accessKeyIdSecretRef);
    const secretAccessKey = await ctx.secrets.resolve(cfg.secretAccessKeySecretRef);
    const fullCfg: S3AdapterConfig = {
      endpoint: cfg.endpoint,
      region: cfg.region,
      bucket: cfg.bucket,
      prefix: cfg.prefix,
      accessKeyId,
      secretAccessKey,
      forcePathStyle: cfg.forcePathStyle,
      serverSideEncryption: cfg.serverSideEncryption,
    };
    return new S3Adapter({ destinationId: entry.id, label: entry.label, config: fullCfg });
  }

  if (entry.kind === "google-drive") {
    const cfg = entry.config as Partial<{
      oauthClientIdSecretRef: string;
      oauthClientSecretSecretRef: string;
      oauthRefreshTokenSecretRef: string;
      folderId: string;
      sharedDriveId: string;
    }>;
    if (
      !cfg.oauthClientIdSecretRef ||
      !cfg.oauthClientSecretSecretRef ||
      !cfg.oauthRefreshTokenSecretRef ||
      !cfg.folderId
    ) {
      throw new Error(
        `[EBACKUP_DEST_CONFIG_INCOMPLETE] destination ${entry.id}: google-drive requires oauthClientIdSecretRef, oauthClientSecretSecretRef, oauthRefreshTokenSecretRef, folderId`,
      );
    }
    const oauthClientId = await ctx.secrets.resolve(cfg.oauthClientIdSecretRef);
    const oauthClientSecret = await ctx.secrets.resolve(cfg.oauthClientSecretSecretRef);
    const oauthRefreshToken = await ctx.secrets.resolve(cfg.oauthRefreshTokenSecretRef);
    const fullCfg: GoogleDriveAdapterConfig = {
      oauthClientId,
      oauthClientSecret,
      oauthRefreshToken,
      folderId: cfg.folderId,
      sharedDriveId: cfg.sharedDriveId,
    };
    return new GoogleDriveAdapter({ destinationId: entry.id, label: entry.label, config: fullCfg });
  }

  if (entry.kind === "local" || entry.kind === "nas-smb") {
    const cfg = entry.config as Partial<{ path: string }>;
    if (!cfg.path) {
      throw new Error(
        `[EBACKUP_DEST_CONFIG_INCOMPLETE] destination ${entry.id} kind=${entry.kind} requires config.path (absolute filesystem path; ~ expands to home dir).`,
      );
    }
    const fullCfg: LocalAdapterConfig = { path: cfg.path };
    return new LocalAdapter({
      kind: entry.kind,
      destinationId: entry.id,
      label: entry.label,
      config: fullCfg,
    });
  }

  throw new Error(`[EBACKUP_DEST_KIND_UNKNOWN] kind=${entry.kind}`);
}

export type { BackupDestinationAdapter, DestinationObject, HealthCheckResult } from "./types.js";
