#!/usr/bin/env bash
# Package the built Darkroom.app into a DMG with hdiutil (no Finder scripting needed).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/apps/desktop/src-tauri/target/release/bundle/macos/Darkroom.app"
OUT_DIR="$ROOT/apps/desktop/src-tauri/target/release/bundle/dmg"
VERSION=$(grep '"version"' "$ROOT/apps/desktop/src-tauri/tauri.conf.json" | head -1 | sed 's/.*: "\(.*\)".*/\1/')
STAGE="$(mktemp -d)"
mkdir -p "$OUT_DIR"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
DMG="$OUT_DIR/Darkroom_${VERSION}_$(uname -m).dmg"
rm -f "$DMG"
hdiutil create -volname "Darkroom" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"
echo "DMG: $DMG"
