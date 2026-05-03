#!/usr/bin/env bash
# Dev-time redeploy: rebuild the plugin and reinstall it via the Paperclip
# CLI's `plugin reinstall` command — which re-copies dist/ into the
# managed install dir and reloads the worker in one shot, preserving
# config and plugin-scoped state.
#
# Run from anywhere; paths are computed relative to this script.
#
# Optional env var:
#   PAPERCLIP_REPO   defaults to ../../../paperclip relative to this plugin

set -euo pipefail

PLUGIN_ID="phone-tools"

PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PAPERCLIP_REPO="${PAPERCLIP_REPO:-$PLUGIN_DIR/../../../paperclip}"

echo "→ Building plugin..."
( cd "$PLUGIN_DIR" && pnpm build )

if [ ! -d "$PAPERCLIP_REPO" ]; then
  echo "ERROR: PAPERCLIP_REPO=$PAPERCLIP_REPO does not exist." >&2
  echo "Set PAPERCLIP_REPO to your paperclip checkout, or rebuild manually with pnpm build." >&2
  exit 2
fi

echo "→ Reinstalling via paperclipai CLI (re-copies dist + reloads worker)..."
(
  cd "$PAPERCLIP_REPO"
  pnpm --filter paperclipai exec tsx src/index.ts plugin reinstall "$PLUGIN_ID" 2>&1 | tail -3
)

echo "✓ Redeploy complete. Worker is running the latest build."
