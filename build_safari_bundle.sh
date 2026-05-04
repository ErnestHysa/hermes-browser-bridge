#!/bin/bash
# Build the Safari .safariextension bundle from extension_safari source.
# Safari requires manifest.json at the ROOT of the bundle, not inside Contents/Resources/.

set -e

SRC="extension_safari"
DST="extension_safari.safariextension"

echo "Building Safari extension bundle: $DST"

# Remove existing bundle and rebuild from scratch
rm -rf "$DST"

# Root-level files (manifest.json must be at root per Safari requirement)
mkdir -p "$DST/images"
mkdir -p "$DST/_locales/en"

cp "$SRC/Contents/Resources/manifest.json" "$DST/"
cp "$SRC/Contents/Resources/background.js"  "$DST/"
cp "$SRC/Contents/Resources/content.js"       "$DST/"
cp "$SRC/Contents/Resources/popup.html"       "$DST/"
cp "$SRC/Contents/Resources/popup.css"       "$DST/"
cp "$SRC/Contents/Resources/popup.js"        "$DST/"

# Icons go in images/ subdirectory (manifest.json references images/icon-16.png etc.)
cp "$SRC/Contents/Resources/images/icon-*.png" "$DST/images/"

# Localization
cp "$SRC/Contents/Resources/_locales/en/messages.json" "$DST/_locales/en/"

# Native handler (Safari bundle metadata)
mkdir -p "$DST/Contents/MacOS"
cp "$SRC/Contents/Info.plist"                          "$DST/Contents/"
cp "$SRC/Contents/MacOS/SafariWebExtensionHandler"     "$DST/Contents/MacOS/"

echo "Done: $DST"
ls -la "$DST"
