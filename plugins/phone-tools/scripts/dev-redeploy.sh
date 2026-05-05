#!/usr/bin/env bash
# Dev-time redeploy: rebuild the plugin, then call
# `paperclipai plugin reinstall <key> --local-path <plugin-dir>`
# to fully re-read the manifest, re-copy dist/ into the managed install
# folder, sync the DB record, and cycle the worker.
#
# The --local-path flag is what makes this work even after a .pcplugin
# Library install — without it, `paperclipai plugin reinstall` reads
# from the plugin's stored localSourcePath in the DB, which gets
# overwritten with a one-shot temp extract when a .pcplugin is uploaded.
# Passing the real source path bypasses that staleness.
#
# Run from anywhere; paths are computed relative to this script.
#
# Optional env var:
#   PAPERCLIP_REPO   defaults to ../../../paperclip relative to this plugin

set -euo pipefail

PLUGIN_ID="phone-tools"

PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PAPERCLIP_REPO="${PAPERCLIP_REPO:-$PLUGIN_DIR/../../../paperclip}"

if [ ! -d "$PAPERCLIP_REPO" ]; then
  echo "ERROR: PAPERCLIP_REPO=$PAPERCLIP_REPO does not exist." >&2
  echo "  Set PAPERCLIP_REPO to your paperclip checkout." >&2
  exit 2
fi

echo "→ Building plugin..."
( cd "$PLUGIN_DIR" && pnpm build )

# Convert the plugin dir to a Windows-style path if we're on Git-Bash so
# the paperclip server (Node on Windows) can resolve it. cygpath is
# available in Git-Bash; fall back to the bare Unix path on macOS/Linux.
PLUGIN_DIR_NATIVE="$(cygpath -w "$PLUGIN_DIR" 2>/dev/null || echo "$PLUGIN_DIR")"

echo "→ Reinstalling via paperclipai CLI (re-validates manifest, re-copies dist, syncs DB, cycles worker)..."
(
  cd "$PAPERCLIP_REPO"
  pnpm --filter paperclipai exec tsx src/index.ts plugin reinstall "$PLUGIN_ID" --local-path "$PLUGIN_DIR_NATIVE" 2>&1 | tail -3
)

echo "✓ Redeploy complete."
