# backup-tools

Encrypted system snapshots for your Paperclip instance, on a schedule (or on demand), shipped to one or more destinations. Restore wizard included.

## What it does

- Produces full-instance database snapshots (public schema + every plugin namespace whose manifest has `database.includeInBackup !== false`).
- Encrypts each snapshot **client-side** with **Argon2id-derived AES-256-GCM** before upload — destinations never see plaintext.
- Fans out a single backup to one or more configured destinations (S3-compatible, Google Drive) in parallel.
- Runs on four cadences: hourly / daily / weekly / monthly. Operators bind schedules to destinations on the settings page.
- Prunes old archives per destination by `keepLast`.
- Restore wizard streams a remote archive back through the privileged `/api/system/snapshot/restore` endpoint with a typed-confirmation gate.
- Failure issues filed in a configured company's inbox.

## Tools

| Tool | Purpose |
|---|---|
| `backup_run_now` | Trigger a manual backup (mutationsEnabled gate). Optional destinationId. |
| `backup_list_recent` | List recent backups (filterable by cadence/status). |
| `backup_get_status` | Fetch one backup with per-destination outcomes. |
| `backup_list_destinations` | List destinations the company is allowed to use. |
| `backup_archive_describe` | Read the manifest envelope of a remote archive without downloading the body. |

## Setup walkthrough

See the [setup page on the plugin's settings tab](`/instance/settings/plugins/backup-tools`) — that's the canonical doc, rendered from `manifest.ts`'s `setupInstructions`. Quick summary:

1. **Create the passphrase secret.** Name it `BACKUP_PASSPHRASE`, ≥ 32 chars. Store outside Paperclip too. Lose it = lose all archives.
2. **Configure ≥ 1 destination.** v0.1 supports `s3` (AWS / R2 / B2 / Wasabi / MinIO / etc) and `google-drive`. Local/NAS destinations are placeholders for v0.2 once the host gains the `host.fs.write-allowlisted` capability.
3. **Configure ≥ 1 schedule.** Pick a cadence (hourly/daily/weekly/monthly) and bind to one or more destination IDs. `keepLast` controls retention per destination.
4. **Allow ≥ 1 company.** `allowedCompanies` controls which companies' agents can use the backup_* tools and see backup status. Restore is instance-admin-only regardless.
5. **Run a manual backup** via the Overview tab to verify destinations work end-to-end.

### MinIO quickstart for local backups

Run MinIO:
```
docker run -d -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=minio -e MINIO_ROOT_PASSWORD=minio12345 \
  -v $HOME/.paperclip-backups:/data \
  minio/minio server /data --console-address ":9001"
```

Create a bucket via the console at <http://localhost:9001>, generate an access key, then add a destination:
```jsonc
{
  "id": "minio-local",
  "kind": "s3",
  "label": "Local MinIO",
  "config": {
    "endpoint": "http://localhost:9000",
    "region": "us-east-1",
    "bucket": "paperclip-backups",
    "prefix": "",
    "accessKeyIdSecretRef": "MINIO_ACCESS_KEY",
    "secretAccessKeySecretRef": "MINIO_SECRET_KEY",
    "forcePathStyle": true,
    "serverSideEncryption": ""
  }
}
```

## Archive format

```
[4 bytes BE envelope-length] [envelope JSON bytes] [body chunks ...] [4 zero bytes]
```

- Envelope is unencrypted (so `backup_archive_describe` is cheap), but HMAC-sealed with a key derived from the passphrase.
- Each body chunk is independently AES-256-GCM-encrypted with a per-chunk nonce + chunk-index AAD, so reordering or replay fails authentication.
- Chunk size: 4 MiB. Overhead per chunk: 4 (length prefix) + 12 (nonce) + 16 (GCM tag) = 32 bytes.

## Error codes

| Code | Meaning |
|---|---|
| `EBACKUP_NO_PASSPHRASE` | passphraseSecretRef not configured or resolves empty |
| `EBACKUP_NO_DESTINATIONS` | No enabled destinations to fan out to |
| `EBACKUP_DEST_NOT_FOUND` | destinationId doesn't match any configured destination |
| `EBACKUP_DEST_DISABLED` | destination is configured but `enabled: false` |
| `EBACKUP_DEST_CONFIG_INCOMPLETE` | required fields missing on a destination's `config` |
| `EBACKUP_DEST_KIND_UNKNOWN` | unrecognized adapter `kind` |
| `EBACKUP_LOCAL_NOT_AVAILABLE` | kind=local or kind=nas-smb (deferred to v0.2) |
| `EBACKUP_DEST_UNREACHABLE` | health check or list failed |
| `EBACKUP_DEST_QUOTA` | destination rejected upload with quota / size error |
| `EBACKUP_UPLOAD_FAILED` | generic upload failure |
| `EBACKUP_DOWNLOAD_FAILED` | generic download failure |
| `EBACKUP_DELETE_FAILED` | retention delete failed |
| `EBACKUP_INTEGRITY_FAILED` | per-chunk authentication or envelope HMAC failed |
| `EBACKUP_ENVELOPE_TOO_LARGE` | manifest envelope exceeded 64 KiB |
| `EBACKUP_ENVELOPE_INVALID` | envelope JSON couldn't be parsed or magic mismatched |
| `EBACKUP_ENVELOPE_TRUNCATED` | not enough bytes to decode envelope |
| `EBACKUP_NO_API_URL` | worker has no PAPERCLIP_API_URL set; cannot reach core /api/system/snapshot |
| `EBACKUP_SNAPSHOT_FETCH_FAILED` | core /api/system/snapshot returned non-2xx |
| `EBACKUP_SNAPSHOT_NO_MANIFEST` | core response missing X-Paperclip-Snapshot-Manifest header |
| `EBACKUP_SNAPSHOT_NO_BODY` | core response had no body stream |
| `EBACKUP_KDF_UNSUPPORTED` | envelope declares an unknown KDF |
| `EBACKUP_NOT_FOUND` | requested backup id doesn't exist |
| `ECOMPANY_NOT_ALLOWED` | calling company isn't in `allowedCompanies` |
| `EDISABLED` | mutation tool called while `mutationsEnabled: false` |

## Recent changes

### 0.1.0 (2026-05-09)

- Initial release.
- S3 + Google Drive destinations.
- Hourly / daily / weekly / monthly cadences.
- 5 agent tools, 10 API routes, 3 UI slots (sidebar, page, dashboard widget).
- Restore wizard with typed-confirmation gate and instance-admin auth.
- Requires Paperclip core ≥ 2026-05-09 for the `/api/system/snapshot*` endpoints + `instance-admin` PluginApiRouteAuthMode + `database.includeInBackup` opt-out flag.
- Local / NAS destinations stubbed (`[EBACKUP_LOCAL_NOT_AVAILABLE]`) — pending host fs-write capability in v0.2.
- Conflict modes other than `overwrite` return `[ESNAPSHOT_CONFLICT_MODE_UNSUPPORTED]` — `skip` and `fail-on-conflict` deferred to v0.2.
