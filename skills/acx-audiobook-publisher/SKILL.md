---
name: acx-audiobook-publisher
description: >
  Publish audiobooks to Audible via ACX using the acx-tools plugin. Watches
  audiobooks/pending/ for project folders containing chapter audio, cover art,
  and metadata. Validates against ACX specs via plugin tools, submits to ACX,
  and moves projects to published/ or error/. Always requires board approval.
---

# ACX Audiobook Publisher

Orchestrates the Audible/ACX publishing workflow using the `acx-tools`
plugin. This skill teaches agents the workflow — the plugin handles
audio validation and API calls.

## Pre-requisites

The `acx-tools` plugin must be installed and `ready` in Paperclip.

## Folder Structure

```
audiobooks/
├── pending/my-audiobook/    ← Project folders go here
│   ├── metadata.json
│   ├── cover.jpg (2400×2400 min)
│   ├── 01-opening-credits.mp3
│   └── 02-chapter-one.mp3
├── published/
└── error/
```

## Workflow

### 1. Scan for pending projects

```json
{ "tool": "acx-tools:acx_scan_pending", "parameters": {} }
```

### 2. Validate audio and cover

```json
{ "tool": "acx-tools:acx_validate_audio", "parameters": { "projectPath": "<path>" } }
{ "tool": "acx-tools:acx_validate_cover", "parameters": { "filePath": "<path>/cover.jpg" } }
```

If validation fails, move to error/:

```json
{ "tool": "acx-tools:acx_move_project", "parameters": { "projectPath": "<path>", "destination": "error", "reason": "<issues>" } }
```

### 3. Request board approval

```
Ready to publish to ACX:
- Title: "My Audiobook"
- Narrator: Narrator Name
- Chapters: 12
- Total runtime: ~8h
- Cover: ✅ validated

Approve to proceed.
```

### 4. Publish

```json
{ "tool": "acx-tools:acx_publish", "parameters": { "projectPath": "<path>", "relatedKdpAsin": "B0XXXXXXXXX" } }
```

Set `relatedKdpAsin` if there's a companion KDP ebook — it links the
Audible listing to the Kindle edition on Amazon.

### 5. Report

```
ACX Publisher — <timestamp>
- Pending: 3 | Submitted: 1 | Failed: 1 | Missing metadata: 1
  ✅ my-audiobook/ → submitted (12 chapters)
  ❌ bad-audio/ → RMS too high on chapter 3
```

## ACX Audio Requirements

- Sample rate: 44.1 kHz | Bit rate: ≥192 kbps CBR
- Peak: ≤ -3 dB | RMS: -23 to -18 dB | Noise floor: ≤ -60 dB
- First file: opening credits | Last file: closing credits

## Errors

- **Plugin not installed** → Report and ask the board.
- **Audio validation fails** → Moved to error/ with per-file report.
- **ACX auth failure** → Report. Do NOT retry.
