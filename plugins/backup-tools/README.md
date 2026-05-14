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

1. **Encryption key** — leave "Backup passphrase" blank to use auto-key mode (recommended). The plugin generates a random 256-bit key on first backup and stores it in its own database. Same-instance restores need no passphrase. For cross-instance recovery, export the key from the Restore tab first. Alternatively, set `passphraseSecretRef` to a secret holding your own passphrase.
2. **Configure ≥ 1 destination.** Choose: `local` (any directory on the host — simplest), `nas-smb` (a mounted SMB share path — same code as local), `s3` (AWS / R2 / B2 / Wasabi / MinIO / etc.), or `google-drive`.
3. **Configure ≥ 1 schedule.** Pick a cadence (hourly/daily/weekly/monthly) and bind to one or more destination IDs. `keepLast` controls retention per destination.
4. **Allow ≥ 1 company.** `allowedCompanies` controls which companies' agents can use the backup_* tools and see backup status. Restore is instance-admin-only regardless.
5. **Run a manual backup** via the Overview tab to verify destinations work end-to-end.

### Local-directory quickstart (no external service)

Add a destination with kind=`local`:

```jsonc
{
  "id": "local-disk",
  "kind": "local",
  "label": "Local disk",
  "config": {
    "path": "~/.paperclip/backups"
  }
}
```

The directory is auto-created if missing. `~` expands to your OS home dir. No external service — archives just land as `.pcback` files in that folder.

### MinIO quickstart (optional, for S3-API testing)

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

## Auto-key mode

When `passphraseSecretRef` is not set, the plugin manages the encryption key itself:

- On first backup a random 256-bit key is generated and stored in the `instance_keys` plugin table.
- All archives (backup and restore) on the same instance use this key transparently — no passphrase input needed.
- To restore on a **different** instance: `GET /api/plugins/backup-tools/instance-key/export` (instance-admin) returns `{ mode: "auto-key", keyHex: "...", createdAt: "..." }`. Paste the hex string as the passphrase in the restore wizard on the target instance.
- Setting `passphraseSecretRef` at any point switches to user-managed mode for **new** backups. Archives created before the switch can still be decrypted by exporting the auto-key.

## Error codes

| Code | Meaning |
|---|---|
| `EBACKUP_NO_PASSPHRASE` | passphraseSecretRef is set but the secret resolves empty or too short |
| `EBACKUP_NO_DESTINATIONS` | No enabled destinations to fan out to |
| `EBACKUP_DEST_NOT_FOUND` | destinationId doesn't match any configured destination |
| `EBACKUP_DEST_DISABLED` | destination is configured but `enabled: false` |
| `EBACKUP_DEST_CONFIG_INCOMPLETE` | required fields missing on a destination's `config` |
| `EBACKUP_DEST_KIND_UNKNOWN` | unrecognized adapter `kind` |
| `EBACKUP_UNSAFE_KEY` | archive key contained `..` or path separators (local adapter only) |
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

- **v0.1.13** — First release on the registry. v0.1.0 ships system-snapshot management: encrypted backups (Argon2id + AES-256-GCM, client-side) on a schedule, fan-out to S3-compatible + Google Drive destinations, and a restore wizard with typed-confirmation. Requires paperclip core ≥ the matching system-snapshot endpoints landing in the host repo. Full feature list and v0.2 roadmap in README.

- **v0.1.12** — First release on the registry. v0.1.0 ships system-snapshot management: encrypted backups (Argon2id + AES-256-GCM, client-side) on a schedule, fan-out to S3-compatible + Google Drive destinations, and a restore wizard with typed-confirmation. Requires paperclip core ≥ the matching system-snapshot endpoints landing in the host repo. Full feature list and v0.2 roadmap in README.

- **v0.1.11** — First release on the registry. v0.1.0 ships system-snapshot management: encrypted backups (Argon2id + AES-256-GCM, client-side) on a schedule, fan-out to S3-compatible + Google Drive destinations, and a restore wizard with typed-confirmation. Requires paperclip core ≥ the matching system-snapshot endpoints landing in the host repo. Full feature list and v0.2 roadmap in README.

- **v0.1.10** — First release on the registry. v0.1.0 ships system-snapshot management: encrypted backups (Argon2id + AES-256-GCM, client-side) on a schedule, fan-out to S3-compatible + Google Drive destinations, and a restore wizard with typed-confirmation. Requires paperclip core ≥ the matching system-snapshot endpoints landing in the host repo. Full feature list and v0.2 roadmap in README.

- **v0.1.9** — First release on the registry. v0.1.0 ships system-snapshot management: encrypted backups (Argon2id + AES-256-GCM, client-side) on a schedule, fan-out to S3-compatible + Google Drive destinations, and a restore wizard with typed-confirmation. Requires paperclip core ≥ the matching system-snapshot endpoints landing in the host repo. Full feature list and v0.2 roadmap in README.

- **v0.1.8** — First release on the registry. v0.1.0 ships system-snapshot management: encrypted backups (Argon2id + AES-256-GCM, client-side) on a schedule, fan-out to S3-compatible + Google Drive destinations, and a restore wizard with typed-confirmation. Requires paperclip core ≥ the matching system-snapshot endpoints landing in the host repo. Full feature list and v0.2 roadmap in README.

- **v0.1.7** — First release on the registry. v0.1.0 ships system-snapshot management: encrypted backups (Argon2id + AES-256-GCM, client-side) on a schedule, fan-out to S3-compatible + Google Drive destinations, and a restore wizard with typed-confirmation. Requires paperclip core ≥ the matching system-snapshot endpoints landing in the host repo. Full feature list and v0.2 roadmap in README.

- **v0.1.6** — Passphrase is now optional. When `passphraseSecretRef` is not set, the plugin auto-generates a random 256-bit instance key on first backup and stores it in its own database (auto-key mode). Same-instance restores work with no passphrase input. Cross-instance recovery: export the key via `GET /instance-key/export` (instance-admin) and paste the hex as the restore passphrase. Adds `migrations/0002_instance_keys.sql` and a new `instance-key.export` API route.
- **v0.1.5** — First release on the registry. v0.1.0 ships system-snapshot management: encrypted backups (Argon2id + AES-256-GCM, client-side) on a schedule, fan-out to S3-compatible + Google Drive destinations, and a restore wizard with typed-confirmation. Requires paperclip core ≥ the matching system-snapshot endpoints landing in the host repo. Full feature list and v0.2 roadmap in README.

- **v0.1.4** — Local-disk destinations now actually work (`kind: local` and `kind: nas-smb`). Earlier versions deferred this to v0.2 pending a host `fs-write-allowlisted` capability, but the plugin worker has been writing the in-flight encrypted archive to `tmpdir()` all along — no new host capability was actually needed. The `LocalAdapter` writes archives directly to any operator-nominated absolute path, auto-creates the directory, uses `.partial` rename-on-success to avoid leaving half-written files, and rejects unsafe keys with path separators or `..`.
- **v0.1.3** — Fix worker startup crash `Dynamic require of "buffer" is not supported`. The AWS SDK's `@smithy/util-buffer-from` calls `require("buffer")` for Node's built-in Buffer module; esbuild's default ESM output doesn't ship a working `require`, so the bundled `__require` shim threw at the first SDK call. Fix: inject a `createRequire(import.meta.url)` banner into the worker bundle so bundled CJS can resolve Node built-ins.
- **v0.1.2** — Fix install-time migration validator failure. The original `migrations/0001_init.sql` used unqualified table names (e.g. `CREATE TABLE backups`) and contained an apostrophe in a leading SQL comment that confused the host validator's quote-stripping regex; install rejected with `Plugin migrations may contain DDL statements only`. v0.1.2 fully qualifies every table and index with the plugin's database namespace and removes apostrophes from comments. Worker SQL also now uses `${ctx.db.namespace}.<table>` everywhere so runtime queries pass the same validator.
- **v0.1.1** — First release on the registry. v0.1.0 ships system-snapshot management: encrypted backups (Argon2id + AES-256-GCM, client-side) on a schedule, fan-out to S3-compatible + Google Drive destinations, and a restore wizard with typed-confirmation. Requires paperclip core ≥ the matching system-snapshot endpoints landing in the host repo. Full feature list and v0.2 roadmap in README.

### 0.1.0 (2026-05-09)

- Initial release.
- S3 + Google Drive destinations.
- Hourly / daily / weekly / monthly cadences.
- 5 agent tools, 10 API routes, 3 UI slots (sidebar, page, dashboard widget).
- Restore wizard with typed-confirmation gate and instance-admin auth.
- Requires Paperclip core ≥ 2026-05-09 for the `/api/system/snapshot*` endpoints + `instance-admin` PluginApiRouteAuthMode + `database.includeInBackup` opt-out flag.
- Local / NAS destinations stubbed (`[EBACKUP_LOCAL_NOT_AVAILABLE]`) — pending host fs-write capability in v0.2.
- Conflict modes other than `overwrite` return `[ESNAPSHOT_CONFLICT_MODE_UNSUPPORTED]` — `skip` and `fail-on-conflict` deferred to v0.2.
