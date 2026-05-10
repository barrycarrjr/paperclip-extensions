import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "backup-tools";
const PLUGIN_VERSION = "0.1.1";

// ---------------------------------------------------------------------------
// instanceConfigSchema sub-shapes
// ---------------------------------------------------------------------------

const s3DestinationConfigSchema = {
  type: "object",
  required: ["bucket", "accessKeyIdSecretRef", "secretAccessKeySecretRef"],
  propertyOrder: [
    "endpoint",
    "region",
    "bucket",
    "prefix",
    "accessKeyIdSecretRef",
    "secretAccessKeySecretRef",
    "forcePathStyle",
    "serverSideEncryption",
  ],
  properties: {
    endpoint: {
      type: "string",
      title: "S3 endpoint URL",
      description:
        "Full URL of the S3-compatible endpoint (e.g. https://s3.us-east-1.amazonaws.com, https://<account>.r2.cloudflarestorage.com, https://s3.us-west-002.backblazeb2.com, http://localhost:9000 for MinIO). Leave blank to use the AWS default for the chosen region.",
    },
    region: {
      type: "string",
      title: "Region",
      description:
        "Region for the bucket (e.g. us-east-1, auto for R2). Required even for non-AWS providers — most SDKs reject empty regions.",
    },
    bucket: {
      type: "string",
      title: "Bucket",
      description:
        "Bucket name. Must already exist; the plugin will not auto-create. For local MinIO testing, create with `mc mb local/paperclip-backups` first.",
    },
    prefix: {
      type: "string",
      default: "paperclip-backups/",
      title: "Key prefix",
      description:
        "Prefix prepended to every archive key (e.g. paperclip-backups/). Use trailing slash. Useful for sharing one bucket across multiple instances.",
    },
    accessKeyIdSecretRef: {
      type: "string",
      format: "secret-ref",
      title: "Access key ID (secret-ref)",
      description:
        "Paperclip secret holding the S3 access key ID. For AWS: create an IAM user with s3:PutObject/GetObject/DeleteObject/ListBucket on the bucket — broader privileges are not needed.",
    },
    secretAccessKeySecretRef: {
      type: "string",
      format: "secret-ref",
      title: "Secret access key (secret-ref)",
      description: "Paperclip secret holding the S3 secret access key.",
    },
    forcePathStyle: {
      type: "boolean",
      default: false,
      title: "Force path-style URLs",
      description:
        "Required for MinIO and some self-hosted S3 implementations. Leave off for AWS / R2 / B2 / Wasabi.",
    },
    serverSideEncryption: {
      type: "string",
      enum: ["", "AES256", "aws:kms"],
      default: "AES256",
      title: "Server-side encryption (S3 SSE)",
      description:
        "Bucket-side encryption layered on top of the plugin's client-side AES-256-GCM. AES256 = SSE-S3 (no extra config). aws:kms = SSE-KMS (uses bucket's default KMS key). Empty = no SSE header sent.",
    },
  },
} as const;

const googleDriveDestinationConfigSchema = {
  type: "object",
  required: [
    "oauthRefreshTokenSecretRef",
    "oauthClientIdSecretRef",
    "oauthClientSecretSecretRef",
    "folderId",
  ],
  propertyOrder: [
    "oauthClientIdSecretRef",
    "oauthClientSecretSecretRef",
    "oauthRefreshTokenSecretRef",
    "folderId",
    "sharedDriveId",
  ],
  properties: {
    oauthClientIdSecretRef: {
      type: "string",
      format: "secret-ref",
      title: "OAuth client ID (secret-ref)",
      description:
        "Paperclip secret holding the Google OAuth 2.0 client ID. Get from console.cloud.google.com → APIs & Services → Credentials → 'Web application' OAuth client. Same shape as the google-workspace plugin uses.",
    },
    oauthClientSecretSecretRef: {
      type: "string",
      format: "secret-ref",
      title: "OAuth client secret (secret-ref)",
      description: "Paperclip secret holding the OAuth client secret paired with the client ID above.",
    },
    oauthRefreshTokenSecretRef: {
      type: "string",
      format: "secret-ref",
      title: "OAuth refresh token (secret-ref)",
      description:
        "Paperclip secret holding the long-lived refresh token. Generate by completing the standard offline-access OAuth dance against scopes 'https://www.googleapis.com/auth/drive.file'. The plugin uses this scope only — it cannot read or modify files it didn't create.",
    },
    folderId: {
      type: "string",
      title: "Folder ID",
      description:
        "Drive folder ID where archives are uploaded. Get from the folder URL: drive.google.com/drive/folders/<THIS-IS-THE-ID>. The OAuth account must have edit access. The plugin only writes here — it doesn't traverse children.",
    },
    sharedDriveId: {
      type: "string",
      title: "Shared drive ID (optional)",
      description:
        "If folderId is inside a shared drive, set the shared drive ID here. Leave blank for personal Drive folders.",
    },
  },
} as const;

const localDestinationConfigSchema = {
  type: "object",
  required: ["path"],
  propertyOrder: ["path"],
  properties: {
    path: {
      type: "string",
      title: "Local path",
      description:
        "Absolute path on the host filesystem. **v0.1 status:** the plugin SDK does not yet expose host-filesystem write access — selecting kind: 'local' returns [EBACKUP_LOCAL_NOT_AVAILABLE] until the host gains the `host.fs.write-allowlisted` capability. Workaround: run MinIO locally and use kind: 's3' against http://localhost:9000.",
    },
  },
} as const;

const nasSmbDestinationConfigSchema = {
  type: "object",
  required: ["path"],
  propertyOrder: ["path"],
  properties: {
    path: {
      type: "string",
      title: "Mount path",
      description:
        "Absolute path on the host where the NAS share is mounted (e.g. //192.168.1.10/backups). Same v0.1 limitation as kind: 'local' — see above.",
    },
  },
} as const;

const destinationItemSchema = {
  type: "object",
  required: ["id", "kind", "label", "config"],
  propertyOrder: ["id", "kind", "label", "enabled", "config"],
  properties: {
    id: {
      type: "string",
      title: "Destination ID",
      description:
        "Stable identifier referenced by schedules (e.g. 'aws-prod', 'home-nas'). Lowercase, no spaces. Don't change once schedules reference it.",
    },
    kind: {
      type: "string",
      enum: ["s3", "google-drive", "local", "nas-smb"],
      title: "Kind",
      description:
        "Which adapter handles this destination. v0.1 supports s3 + google-drive. local + nas-smb are placeholders for v0.2.",
    },
    label: {
      type: "string",
      title: "Display label",
      description: "Human-readable name shown in the dashboard and history view.",
    },
    enabled: {
      type: "boolean",
      default: true,
      title: "Enabled",
      description:
        "Disable to keep the destination configured but skip it on scheduled runs (and reject manual runs targeting it).",
    },
    config: {
      type: "object",
      title: "Adapter-specific config",
      description:
        "Shape depends on `kind`. See per-kind sub-schemas in the README. The form renderer will switch on the `kind` field above.",
      additionalProperties: true,
      // The form should render different sub-schemas based on `kind`; the
      // renderer reads x-paperclip-showWhen on each child schema. For v0.1
      // we keep the config field a free object and document the shape in
      // the plugin README — operators using the JSON-direct edit path can
      // copy from the README's example. A subsequent iteration will swap
      // this for a discriminated union once the form renderer supports it.
      "x-paperclip-configByKind": {
        s3: s3DestinationConfigSchema,
        "google-drive": googleDriveDestinationConfigSchema,
        local: localDestinationConfigSchema,
        "nas-smb": nasSmbDestinationConfigSchema,
      },
    },
  },
} as const;

const scheduleItemSchema = {
  type: "object",
  required: ["id", "cadence", "destinationIds"],
  propertyOrder: ["id", "cadence", "destinationIds", "keepLast", "enabled"],
  properties: {
    id: {
      type: "string",
      title: "Schedule ID",
      description: "Stable identifier (e.g. 'daily-prod', 'hourly-nas'). Lowercase, no spaces.",
    },
    cadence: {
      type: "string",
      enum: ["hourly", "daily", "weekly", "monthly"],
      title: "Cadence",
      description:
        "How often this schedule fires. hourly fires at :07 every hour, daily at 03:07 UTC, weekly Sun 03:07 UTC, monthly 1st 03:07 UTC. The :07 minute offset avoids the load spike at the top of the hour.",
    },
    destinationIds: {
      type: "array",
      items: { type: "string" },
      title: "Destinations",
      description:
        "IDs from the destinations array above. Archive fans out to all of them in parallel on each run. Multiple schedules CAN share a destination (e.g. hourly to local NAS + weekly to S3).",
    },
    keepLast: {
      type: "integer",
      minimum: 1,
      default: 14,
      title: "Keep last N",
      description:
        "After each run, prune older archives at each destination so only the most-recent N (per destination, per schedule) remain. 14 daily = ~2 weeks of dailies.",
    },
    enabled: {
      type: "boolean",
      default: true,
      title: "Enabled",
      description: "Disable to pause this schedule without deleting it.",
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Setup instructions (rendered on the plugin's settings page)
// ---------------------------------------------------------------------------

const SETUP_INSTRUCTIONS = `# Setup — backup-tools v0.1

System backups for your Paperclip instance: encrypted snapshots fan out to one or more destinations on a schedule (or on demand), and a restore wizard replays an archive when you need to recover.

**Reckon on ~10 minutes for first-time setup with one destination.**

---

## 1. Create the encryption passphrase secret

The plugin encrypts every archive client-side with AES-256-GCM, keyed off a passphrase you provide. The destination never sees plaintext.

1. Go to your portfolio's **Secrets** page.
2. Create a secret named **\`BACKUP_PASSPHRASE\`** with a strong passphrase (≥ 32 characters recommended).
3. **Store the passphrase outside Paperclip too** — a password manager, a sealed envelope. If the secret is lost AND your instance is wiped, your archives are unrecoverable. There is no backdoor.
4. Reference \`BACKUP_PASSPHRASE\` in this plugin's settings under "Backup passphrase (secret-ref)".

---

## 2. Pick at least one destination

The plugin supports four kinds; v0.1 ships **s3** and **google-drive** working end-to-end.

### Option A — S3-compatible (AWS S3, Cloudflare R2, Backblaze B2, MinIO, Wasabi …)

1. Create a bucket on your provider. Don't enable versioning unless you also bump retention (versioning + retention=14 keeps 14× as many objects as you intended).
2. Create a credential pair (IAM user, R2 token, …) limited to **PutObject / GetObject / DeleteObject / ListBucket** on that bucket. Broader privileges aren't needed.
3. Store the access key ID and secret access key as Paperclip secrets (e.g. \`AWS_BACKUP_ACCESS_KEY_ID\`, \`AWS_BACKUP_SECRET_ACCESS_KEY\`).
4. Add a destination: kind=\`s3\`, label="AWS prod", config = { endpoint?, region, bucket, prefix, accessKeyIdSecretRef, secretAccessKeySecretRef, forcePathStyle, serverSideEncryption }.

For **local-disk testing right now**, run MinIO in Docker:

\`\`\`
docker run -d -p 9000:9000 -p 9001:9001 \\
  -e MINIO_ROOT_USER=minio -e MINIO_ROOT_PASSWORD=minio12345 \\
  -v $HOME/.paperclip-backups:/data \\
  minio/minio server /data --console-address ":9001"
\`\`\`

Then create a bucket, generate an access key in the MinIO console, and configure a destination with kind=\`s3\`, endpoint=\`http://localhost:9000\`, region=\`us-east-1\`, forcePathStyle=true.

### Option B — Google Drive

1. Create an OAuth 2.0 client at console.cloud.google.com → APIs & Services → Credentials. Type: "Web application." Add \`https://<paperclip-host>/api/oauth/callback\` to authorized redirects.
2. Run the offline-access OAuth flow against scope \`https://www.googleapis.com/auth/drive.file\`. Store the resulting refresh token plus the client ID/secret as three Paperclip secrets.
3. Pick (or create) a Drive folder, copy its ID from the URL.
4. Add a destination: kind=\`google-drive\`, label="Drive", config = { oauthClientIdSecretRef, oauthClientSecretSecretRef, oauthRefreshTokenSecretRef, folderId, sharedDriveId? }.

### Option C / D — local / NAS-SMB

**v0.1 limitation:** the plugin SDK does not yet expose host-filesystem write. Selecting kind=local or nas-smb returns \`[EBACKUP_LOCAL_NOT_AVAILABLE]\`. Workaround: run MinIO (above) and use kind=s3.

---

## 3. Create at least one schedule

Schedules bind one or more destinations to a cadence:

\`\`\`
{ id: "daily-prod", cadence: "daily", destinationIds: ["aws-prod"], keepLast: 14 }
\`\`\`

Cadences fire at the following UTC times:
- **hourly** — every hour at :07
- **daily** — every day at 03:07
- **weekly** — every Sunday at 03:07
- **monthly** — every 1st of month at 03:07

The :07 offset avoids the top-of-hour load spike.

---

## 4. Allow at least one company

The plugin is mounted in the **company sidebar** of every company you tick under "Allowed companies (for agent tools)". Use \`["*"]\` for portfolio-wide.

This list controls who can:
- See backup status on the dashboard
- Trigger on-demand backups (subject to "Allow agent-triggered on-demand backups" toggle)
- Read backup history

It does NOT control restore — restore is **instance-admin only**, regardless of allow-list.

---

## 5. Run the first backup manually

Before relying on schedules, click "Run now" on the Overview tab. Verify:
- The archive lands at the destination (use \`aws s3 ls\`, the MinIO console, or the Drive folder UI).
- The backup history shows status=succeeded and a sane size.
- Run health-check on each destination (Destinations tab → Run health check) to verify credentials.

Now wait for the next scheduled run (you'll see \`schedule_state.next_run_after\` on the Schedules tab).

---

## Restoring

Restore is **instance-admin only**. Open the **Restore** tab, follow the wizard:
1. Pick destination + archive
2. Enter passphrase (validated against the manifest envelope only — body remains encrypted on the destination until step 5)
3. Preview (envelope-only in v0.1; full preview in v0.2)
4. Type the literal phrase \`RESTORE THIS INSTANCE\` to confirm
5. Apply — streams the decrypted archive into the privileged \`/api/system/snapshot/restore\` endpoint

Conflict modes (\`overwrite\` / \`skip\` / \`fail-on-conflict\`) are declared in the wizard; v0.1 only wires \`overwrite\` through. Other modes return \`[ESNAPSHOT_CONFLICT_MODE_UNSUPPORTED]\`.

---

## Failure alerts

Set "Alert company on failure" to a company UUID; the plugin will create an issue in that company's inbox when a backup or destination fails. Leave blank to suppress automatic issue creation.

---

## What's NOT backed up (v0.1)

- **Secret values.** Only secret refs are persisted. Restore re-binds them to whichever provider the target instance has.
- **Installed plugin binaries.** The archive lists installed plugins (key + version) so you can reinstall on restore; it doesn't ship the .pcplugin binaries themselves.
- **Skill files on disk.** Operator-managed.
- **Plugin schemas with \`includeInBackup: false\`** in the plugin manifest — these are deliberately excluded.

See the plugin folder's [README.md](README.md) for the full feature roadmap.
`;

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

const manifest: PaperclipPluginManifestV1 & { setupInstructions?: string } = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Backups (system snapshot manager)",
  setupInstructions: SETUP_INSTRUCTIONS,
  description:
    "Encrypted system snapshots on a schedule. Fan-out to S3-compatible + Google Drive destinations. Restore wizard included. Encryption is client-side (Argon2id KDF + AES-256-GCM stream cipher) — destinations never see plaintext.",
  author: "Barry Carr & Tony Allard",
  categories: ["automation", "workspace"],
  capabilities: [
    "instance.settings.register",
    "ui.sidebar.register",
    "ui.page.register",
    "ui.dashboardWidget.register",
    "api.routes.register",
    "agent.tools.register",
    "database.namespace.read",
    "database.namespace.write",
    "database.namespace.migrate",
    "jobs.schedule",
    "http.outbound",
    "secrets.read-ref",
    "companies.read",
    "issues.read",
    "issues.create",
    "issue.comments.create",
    "activity.log.write",
    "telemetry.track",
    "metrics.write",
    "plugin.state.read",
    "plugin.state.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  // Cast: `includeInBackup` is recognized by the host's manifest validator
  // (paperclip core) but the field is not yet in the npm-published
  // @paperclipai/plugin-sdk type. Widen here so this plugin can populate
  // the field today; remove the cast once the SDK ships the type.
  database: ({
    namespaceSlug: "backup_tools",
    migrationsDir: "./migrations",
    coreReadTables: ["companies", "agents"],
    includeInBackup: false, // backup_tools' own state is bookkeeping for the
    // backups themselves; restoring it on top of a freshly-restored instance
    // would replay stale schedule/run state. The instance's *real* data
    // already lives in the public schema and other plugins' schemas, which
    // are what get backed up. Plugin's own state stays excluded by default.
  } as never),
  jobs: [
    {
      jobKey: "cadence_hourly",
      displayName: "Hourly cadence sweep",
      description: "Fires every hour at :07 UTC. Runs any schedule with cadence=hourly that's due.",
      schedule: "7 * * * *",
    },
    {
      jobKey: "cadence_daily",
      displayName: "Daily cadence sweep",
      description: "Fires every day at 03:07 UTC. Runs any schedule with cadence=daily that's due.",
      schedule: "7 3 * * *",
    },
    {
      jobKey: "cadence_weekly",
      displayName: "Weekly cadence sweep",
      description: "Fires every Sunday at 03:07 UTC. Runs any schedule with cadence=weekly that's due.",
      schedule: "7 3 * * 0",
    },
    {
      jobKey: "cadence_monthly",
      displayName: "Monthly cadence sweep",
      description: "Fires on the 1st of every month at 03:07 UTC. Runs any schedule with cadence=monthly that's due.",
      schedule: "7 3 1 * *",
    },
  ],
  tools: [
    {
      name: "backup_run_now",
      displayName: "Run backup now",
      description:
        "Trigger an on-demand backup. Optionally target one configured destination by id; default fan-out to all enabled destinations. Mutation gated by 'Allow agent-triggered on-demand backups' (default off). Returns { backupId, destinations: [...] }. Idempotency-key honored.",
      parametersSchema: {
        type: "object",
        properties: {
          destinationId: {
            type: "string",
            description: "Optional destination id to target. Default: fan-out to all enabled destinations.",
          },
          idempotencyKey: {
            type: "string",
            description:
              "Optional. Subsequent calls with the same key short-circuit to the existing backup record (and don't fan out twice).",
          },
        },
      },
    },
    {
      name: "backup_list_recent",
      displayName: "List recent backups",
      description:
        "List the most-recent N backup runs (default 20) for the calling company's allow-list. Each entry: { backupId, startedAt, completedAt, status, sizeBytes, cadence, destinations: [...] }.",
      parametersSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 200, default: 20 },
          cadence: { type: "string", enum: ["manual", "hourly", "daily", "weekly", "monthly"] },
          status: { type: "string", enum: ["queued", "running", "succeeded", "failed", "partial"] },
        },
      },
    },
    {
      name: "backup_get_status",
      displayName: "Get backup status",
      description:
        "Fetch one backup record + its per-destination upload outcomes. Used by an agent to poll a long-running backup it kicked off.",
      parametersSchema: {
        type: "object",
        required: ["backupId"],
        properties: {
          backupId: { type: "string" },
        },
      },
    },
    {
      name: "backup_list_destinations",
      displayName: "List destinations",
      description:
        "List the destinations the calling company is allowed to use, with their last-success-at and last-failure-reason. Filtered to enabled destinations.",
      parametersSchema: { type: "object", properties: {} },
    },
    {
      name: "backup_archive_describe",
      displayName: "Describe archive",
      description:
        "Read the manifest envelope of a remote archive without downloading the body. Returns { instanceId, createdAt, snapshotUuid, publicTableCounts, pluginNamespaces, sizeBytes }. Useful for agents auditing what's at rest in the cloud.",
      parametersSchema: {
        type: "object",
        required: ["destinationId", "archiveKey"],
        properties: {
          destinationId: { type: "string" },
          archiveKey: { type: "string", description: "Remote object key as listed by /destinations/:id/list-archives." },
        },
      },
    },
  ],
  apiRoutes: [
    {
      routeKey: "destinations.list",
      method: "GET",
      path: "/destinations",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "destinations.health",
      method: "POST",
      path: "/destinations/:id/health",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "destinations.list-archives",
      method: "GET",
      path: "/destinations/:id/list-archives",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "backups.list",
      method: "GET",
      path: "/backups",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "backups.get",
      method: "GET",
      path: "/backups/:id",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "backups.run-now",
      method: "POST",
      path: "/backups/run-now",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "restore.preview",
      method: "POST",
      path: "/restore/preview",
      // Cast: "instance-admin" is recognized by paperclip core's auth-mode
      // enum (added in the same release as /api/system/snapshot*) but isn't
      // in the npm-published SDK type yet.
      auth: "instance-admin" as never,
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "restore.apply",
      method: "POST",
      path: "/restore/apply",
      // Cast: "instance-admin" is recognized by paperclip core's auth-mode
      // enum (added in the same release as /api/system/snapshot*) but isn't
      // in the npm-published SDK type yet.
      auth: "instance-admin" as never,
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "manifest-of",
      method: "GET",
      path: "/manifest-of/:destinationId/:archiveKey",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "schedules.run-due-eval",
      method: "POST",
      path: "/schedules/:id/run-due-eval",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
  ],
  ui: {
    slots: [
      {
        type: "sidebar",
        id: "backup-sidebar",
        displayName: "Backups",
        exportName: "BackupSidebarItem",
      },
      {
        type: "page",
        id: "backup-page",
        displayName: "Backups",
        exportName: "BackupPage",
        routePath: "backups",
      },
      {
        type: "dashboardWidget",
        id: "backup-health-widget",
        displayName: "Backup health",
        exportName: "BackupHealthWidget",
      },
    ],
  },
  instanceConfigSchema: {
    type: "object",
    propertyOrder: [
      "allowedCompanies",
      "passphraseSecretRef",
      "destinations",
      "schedules",
      "retention",
      "maxRunMinutes",
      "mutationsEnabled",
      "alertOnFailureToCompanyId",
    ],
    required: ["allowedCompanies", "passphraseSecretRef", "destinations", "schedules"],
    properties: {
      allowedCompanies: {
        type: "array",
        items: { type: "string", format: "company-id" },
        title: "Allowed companies (for agent tools)",
        description:
          "Which companies' agents can call backup_* tools and see backup status in their sidebar/dashboard. Use ['*'] for portfolio-wide. NOTE: privileged backup/restore actions are instance-admin gated regardless — this list only controls who can read backup status and trigger on-demand runs.",
      },
      passphraseSecretRef: {
        type: "string",
        format: "secret-ref",
        title: "Backup passphrase (secret-ref)",
        description:
          "Secret name (e.g. BACKUP_PASSPHRASE) holding the passphrase used to encrypt all archives. **WARNING: lose this and the archives are unrecoverable.** Store the passphrase outside Paperclip too — a password manager, a sealed envelope. Recommended ≥ 32 characters.",
      },
      destinations: {
        type: "array",
        title: "Backup destinations",
        description:
          "Where archives are sent. Configure at least one. Recommended: one cloud (S3 / Drive) + one local/NAS for the 3-2-1 backup rule.",
        items: destinationItemSchema,
      },
      schedules: {
        type: "array",
        title: "Schedules",
        description:
          "Each schedule binds one or more destinations to a cadence. Multiple schedules can share a destination (e.g. hourly to local NAS + weekly to S3).",
        items: scheduleItemSchema,
      },
      retention: {
        type: "object",
        title: "Global retention guard",
        description:
          "Hard ceiling regardless of per-schedule keepLast. Stops a misconfigured schedule from filling a destination indefinitely.",
        properties: {
          maxArchivesPerDestination: {
            type: "integer",
            minimum: 1,
            default: 365,
            title: "Max archives per destination",
            description:
              "Older archives beyond this count are deleted on the next run. 365 = a year of dailies.",
          },
          maxTotalSizeGb: {
            type: "integer",
            minimum: 0,
            default: 0,
            title: "Max total size (GB, 0 = no cap)",
            description:
              "If set, deletes oldest archives until total destination usage is under this. 0 disables.",
          },
        },
      },
      maxRunMinutes: {
        type: "integer",
        minimum: 5,
        default: 60,
        title: "Max run minutes",
        description:
          "Backups that take longer than this are aborted and partial uploads cleaned up on best-effort. Increase for very large instances.",
      },
      mutationsEnabled: {
        type: "boolean",
        default: false,
        title: "Allow agent-triggered on-demand backups",
        description:
          "When false, agents cannot call backup_run_now (they can still list / describe). Scheduled runs are unaffected. Default off so a chatty agent doesn't accidentally rack up egress costs.",
      },
      alertOnFailureToCompanyId: {
        type: "string",
        format: "company-id",
        title: "Alert company on failure",
        description:
          "Optional. Company UUID whose Inbox issue queue receives a failure issue when a backup or destination fails. Leave blank to suppress automatic issue creation; failures still appear on the plugin dashboard.",
      },
    },
  },
};

export default manifest;
