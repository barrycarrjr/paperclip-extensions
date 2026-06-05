---
name: s3-file-manager
description: >
  Download from and upload to S3 buckets using the s3-tools plugin. Maps S3
  prefixes to local directories, supports bulk operations, and generates
  presigned URLs. Use when an agent needs to pull or push files from S3.
---

# S3 File Manager

Orchestrates S3 file operations using the `s3-tools` plugin.

## Pre-requisites

The `s3-tools` plugin must be installed and `ready` in Paperclip.

## Plugin tools

All tools use the `s3-tools:<tool>` format:

| Tool | What it does |
|---|---|
| `s3-tools:s3_list` | List objects in a bucket path |
| `s3-tools:s3_download` | Download files to local directory |
| `s3-tools:s3_upload` | Upload local files to S3 |
| `s3-tools:s3_delete` | Delete S3 objects (destructive) |
| `s3-tools:s3_presign` | Generate temporary presigned URLs |

## Common workflows

### Download book covers from S3

```json
{ "tool": "s3-tools:s3_download", "parameters": {
    "bucket": "assets", "s3Prefix": "covers/", "localPath": "./downloads/covers", "fileTypes": "jpg,png,webp"
} }
```

### Upload published ePubs to S3

```json
{ "tool": "s3-tools:s3_upload", "parameters": {
    "bucket": "publish", "localPath": "./stories/books/published", "s3Prefix": "kindle/ready/", "fileTypes": "epub,pdf"
} }
```

### Generate a presigned URL for Instagram posting

Instagram Graph API requires media at public URLs. Use presigned URLs:

```json
{ "tool": "s3-tools:s3_presign", "parameters": {
    "bucket": "assets", "s3Key": "social/post-image.jpg", "expiresIn": 3600
} }
```

Then pass the URL to `instagram-tools:instagram_post_photo`.

### List available exports

```json
{ "tool": "s3-tools:s3_list", "parameters": {
    "bucket": "exports", "prefix": "monthly/2026/", "maxKeys": 50
} }
```

## Errors

- **Access denied (403)** → Check IAM policy for the bucket.
- **Bucket not found** → Verify bucket name and region in plugin config.
- **Credentials invalid** → Ask the board to update secrets.
