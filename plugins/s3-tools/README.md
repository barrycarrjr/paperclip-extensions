# s3-tools

Paperclip plugin that exposes S3 download, upload, list, delete, and presigned URL operations as agent tools.

## Tools

| Tool | Description |
|---|---|
| `s3_list` | List objects in a bucket path |
| `s3_download` | Download files from S3 to local directory |
| `s3_upload` | Upload local files to S3 |
| `s3_delete` | Delete S3 objects |
| `s3_presign` | Generate temporary presigned URLs |

## Setup

1. Create IAM credentials with S3 access
2. Store as Paperclip secrets: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
3. Configure buckets on `/instance/settings/plugins/s3-tools`

## Build

```bash
pnpm install
pnpm build
```

## Companion skill

`s3-file-manager` — teaches agents the file management workflow.
