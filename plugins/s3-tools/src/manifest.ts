import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 & { setupInstructions?: string } = {
  id: "s3-tools",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "S3 Tools",
  setupInstructions: `# Setup — S3 Tools

Connect one or more S3 buckets so agents can download, upload, list, and sync files. Supports AWS S3 and S3-compatible services (MinIO, R2, DigitalOcean Spaces, Backblaze B2, Wasabi).

---

## 1. Create IAM credentials

Create an IAM user or role with the minimum required permissions:

\`\`\`json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:GetObject", "s3:PutObject", "s3:ListBucket", "s3:DeleteObject"],
    "Resource": ["arn:aws:s3:::YOUR_BUCKET", "arn:aws:s3:::YOUR_BUCKET/*"]
  }]
}
\`\`\`

Remove \`s3:PutObject\` and \`s3:DeleteObject\` for read-only buckets.

---

## 2. Store credentials as Paperclip secrets

In Paperclip, go to **Secrets → Add** and create:
- \`AWS_ACCESS_KEY_ID\` — your access key
- \`AWS_SECRET_ACCESS_KEY\` — your secret key

Copy the secret UUIDs.

---

## 3. Configure the plugin (Configuration tab)

Add one entry per bucket under **S3 buckets**:
- **Identifier** — short stable key agents use (e.g. \`assets\`, \`exports\`)
- **Bucket name** — the actual S3 bucket name
- **Region** — AWS region (e.g. \`us-east-1\`)
- **Access key** — paste the secret UUID for \`AWS_ACCESS_KEY_ID\`
- **Secret key** — paste the secret UUID for \`AWS_SECRET_ACCESS_KEY\`
- **Endpoint** — leave blank for AWS S3, or set for S3-compatible services
- **Allowed companies** — which companies' agents can access this bucket
`,
  description:
    "Download, upload, list, and sync files with S3 buckets. Multi-bucket, per-bucket company isolation. Supports AWS S3 and S3-compatible services.",
  author: "BookZeta",
  categories: ["automation"],
  capabilities: [
    "agent.tools.register",
    "instance.settings.register",
    "secrets.read-ref",
    "http.outbound",
    "telemetry.track",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    propertyOrder: ["defaultBucket", "buckets"],
    properties: {
      defaultBucket: {
        type: "string",
        title: "Default bucket key",
        description: "Bucket used when an agent omits the `bucket` parameter.",
      },
      buckets: {
        type: "array",
        title: "S3 buckets",
        description: "One entry per S3 bucket this plugin can access.",
        items: {
          type: "object",
          required: ["key", "bucketName", "accessKeyRef", "secretKeyRef", "allowedCompanies"],
          propertyOrder: ["key", "displayName", "bucketName", "region", "endpoint", "accessKeyRef", "secretKeyRef", "allowedCompanies"],
          properties: {
            key: { type: "string", title: "Identifier", description: "Short stable ID agents pass (e.g. 'assets')." },
            displayName: { type: "string", title: "Display name" },
            bucketName: { type: "string", title: "Bucket name", description: "Actual S3 bucket name." },
            region: { type: "string", title: "Region", description: "AWS region (e.g. us-east-1). Default: us-east-1." },
            endpoint: { type: "string", title: "Custom endpoint", description: "For S3-compatible services. Leave blank for AWS." },
            accessKeyRef: { type: "string", format: "secret-ref", title: "Access key ID", description: "UUID of the secret holding the AWS access key." },
            secretKeyRef: { type: "string", format: "secret-ref", title: "Secret access key", description: "UUID of the secret holding the AWS secret key." },
            allowedCompanies: { type: "array", items: { type: "string", format: "company-id" }, title: "Allowed companies" },
          },
        },
      },
    },
  },
  tools: [
    {
      name: "s3_list",
      displayName: "List S3 objects",
      description: "List objects in an S3 bucket path. Returns key, size, lastModified, and etag for each object.",
      parametersSchema: {
        type: "object",
        properties: {
          bucket: { type: "string", description: "Bucket identifier from plugin config. Falls back to default." },
          prefix: { type: "string", description: "S3 key prefix to list (e.g. 'covers/'). Default: root." },
          maxKeys: { type: "number", description: "Max objects to return. Default 100, max 1000." },
          recursive: { type: "boolean", description: "Include sub-prefixes. Default true." },
        },
      },
    },
    {
      name: "s3_download",
      displayName: "Download from S3",
      description: "Download one or more files from S3 to a local directory. Preserves S3 key structure as local subdirectories.",
      parametersSchema: {
        type: "object",
        properties: {
          bucket: { type: "string", description: "Bucket identifier." },
          s3Key: { type: "string", description: "S3 object key to download. For single file." },
          s3Prefix: { type: "string", description: "S3 prefix for bulk download. All matching objects downloaded." },
          localPath: { type: "string", description: "Local directory to save files to. Required." },
          overwrite: { type: "boolean", description: "Overwrite existing local files. Default false." },
          fileTypes: { type: "string", description: "Comma-separated extension whitelist (e.g. 'pdf,epub'). Empty = all." },
          maxFiles: { type: "number", description: "Max files to download. Default 50." },
        },
        required: ["localPath"],
      },
    },
    {
      name: "s3_upload",
      displayName: "Upload to S3",
      description: "Upload one or more local files to S3. Mirrors local directory structure as S3 key prefixes.",
      parametersSchema: {
        type: "object",
        properties: {
          bucket: { type: "string", description: "Bucket identifier." },
          localPath: { type: "string", description: "Local file or directory to upload. Required." },
          s3Prefix: { type: "string", description: "S3 key prefix to upload under. Default: root." },
          overwrite: { type: "boolean", description: "Overwrite existing S3 objects. Default false." },
          storageClass: { type: "string", description: "S3 storage class. Default STANDARD." },
          contentType: { type: "string", description: "Override MIME type. Default auto-detects." },
          maxFiles: { type: "number", description: "Max files to upload. Default 50." },
        },
        required: ["localPath"],
      },
    },
    {
      name: "s3_delete",
      displayName: "Delete S3 object",
      description: "Delete one or more objects from S3. Destructive — gated by allowDeletions config switch.",
      parametersSchema: {
        type: "object",
        properties: {
          bucket: { type: "string", description: "Bucket identifier." },
          s3Key: { type: "string", description: "Single S3 key to delete." },
          s3Keys: { type: "array", items: { type: "string" }, description: "Array of S3 keys for bulk delete." },
        },
      },
    },
    {
      name: "s3_presign",
      displayName: "Generate S3 presigned URL",
      description: "Generate a temporary presigned URL for downloading or uploading an S3 object without credentials.",
      parametersSchema: {
        type: "object",
        properties: {
          bucket: { type: "string", description: "Bucket identifier." },
          s3Key: { type: "string", description: "S3 object key." },
          operation: { type: "string", description: "'getObject' or 'putObject'. Default 'getObject'." },
          expiresIn: { type: "number", description: "URL validity in seconds. Default 3600 (1 hour). Max 604800 (7 days)." },
        },
        required: ["s3Key"],
      },
    },
  ],
};

export default manifest;
