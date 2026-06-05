---
name: kdp-publisher
description: >
  Publish books to Amazon KDP using the kdp-tools plugin. Watches a folder
  pipeline (pending/published/error) for ePub or PDF manuscripts, validates
  them via plugin tools, publishes to KDP, then moves files based on outcome.
  Supports books, childrens_books, comics, graphic_novels, and short_stories.
  Always requires board approval before submission.
---

# KDP Publisher

Orchestrates the KDP publishing workflow using the `kdp-tools` plugin.
This skill teaches agents **when and how** to use the plugin tools —
the plugin handles the heavy lifting (validation, file I/O, API calls).

## Pre-requisites

The `kdp-tools` plugin must be installed and `ready` in Paperclip
(check via `/instance/settings/plugins/kdp-tools`).

## Folder Structure

```
stories/
├── books/pending/          ← Drop ePub/PDF + metadata.json here
├── books/published/        ← Successfully published
├── books/error/            ← Failed with error report
├── childrens_books/...
├── comics/...
├── graphic_novels/...
└── short_stories/...
```

## When to invoke

- A scheduled routine fires this skill to check for pending files.
- An operator assigns a task saying "publish the pending books."
- After a content pipeline drops new manuscripts into pending/.

## Workflow

### 1. Scan for pending files

Call the plugin tool:

```json
{ "tool": "kdp-tools:kdp_scan_pending", "parameters": {} }
```

If no pending files found, comment "No pending manuscripts" and exit clean.

### 2. Validate each file

For each file returned by the scan:

```json
{ "tool": "kdp-tools:kdp_validate", "parameters": { "filePath": "<path>" } }
```

If validation fails, move to error/:

```json
{ "tool": "kdp-tools:kdp_move_file", "parameters": { "filePath": "<path>", "destination": "error", "reason": "<issues>" } }
```

### 3. Request board approval

For each validated file, create a confirmation request:

```
Ready to publish to KDP:
- File: my-novel.epub
- Title: "My Novel"
- Author: Author Name
- Content type: books

Approve to proceed.
```

Do NOT proceed until approval is received.

### 4. Publish

```json
{ "tool": "kdp-tools:kdp_publish", "parameters": { "filePath": "<path>", "contentType": "books" } }
```

### 5. Report

Append a comment on the issue with results:

```
KDP Publisher — <timestamp>
- Pending: 4 | Published: 2 | Failed: 1 | Missing metadata: 1
  ✅ books/my-novel.epub → published
  ❌ books/bad-format.epub → missing metadata
```

## Metadata sidecar

Each manuscript needs a companion `.json` file:

```json
{
  "title": "My Novel",
  "author": "Author Name",
  "description": "Book description.",
  "categories": ["Fiction"],
  "keywords": ["adventure"],
  "price": "2.99",
  "coverImage": "my-novel-cover.jpg"
}
```

## Errors

- **Plugin not installed** → 404 or 503. Report and ask the board.
- **Missing metadata** → File moved to error/ automatically.
- **KDP auth failure** → Report. Do NOT retry.
