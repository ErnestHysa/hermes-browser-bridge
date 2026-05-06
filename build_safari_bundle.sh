#!/usr/bin/env bash
# =============================================================================
# build_safari_bundle.sh — Generate the Safari .safariextension bundle from
# extension_safari/Contents/Resources/.
#
# Safari's sideloading requires a flat .safariextension directory with
# manifest.json at the root (not nested inside Contents/Resources/).
# This script copies and flattens the source extension into the bundle.
#
# Usage:
#   ./build_safari_bundle.sh
#
# Output:
#   extension_safari.safariextension/   (gitignored)
# =============================================================================

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="$ROOT/extension_safari/Contents/Resources"
DEST="$ROOT/extension_safari.safariextension"

# Source must exist
if [[ ! -d "$SRC" ]]; then
  echo "ERROR: Source directory not found: $SRC" >&2
  exit 1
fi

echo "Building Safari .safariextension bundle..."

# Idempotent: clear destination first
rm -rf "$DEST"
mkdir -p "$DEST"

# Copy all files from Resources, flattening the structure
# (Safari expects manifest.json at the bundle root, not nested)
cp -R "$SRC"/* "$DEST"/

echo "  Done: $DEST"
