#!/usr/bin/env bash
#
# Build the Flutter release APK and publish it to public/multicc.apk so the
# in-app updater serves the current version. Also writes a version sidecar
# (public/multicc.apk.json) that /api/apk-info reads to show the real version
# in the "发现新版本 X" dialog.
#
# Run from anywhere:  ./scripts/publish-apk.sh
# Remember to bump `version:` in app/pubspec.yaml first, or Android will treat
# the new build as the same version and refuse to install over the old one.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/app/build/app/outputs/flutter-apk/app-release.apk"
DEST="$ROOT/public/multicc.apk"

echo "[publish-apk] Building release APK…"
( cd "$ROOT/app" && flutter build apk --release )

cp "$SRC" "$DEST"

# Extract versionName/versionCode via the Android SDK's aapt2, if available, so
# the server can advertise the exact version. Falls back gracefully if absent.
AAPT="$(ls "$HOME/Library/Android/sdk/build-tools/"*/aapt2 2>/dev/null | sort -V | tail -1 || true)"
VN=""; VC=""
if [ -n "${AAPT:-}" ]; then
  LINE="$("$AAPT" dump badging "$DEST" 2>/dev/null | grep -m1 '^package:' || true)"
  VN="$(printf '%s' "$LINE" | sed -n "s/.*versionName='\([^']*\)'.*/\1/p")"
  VC="$(printf '%s' "$LINE" | sed -n "s/.*versionCode='\([^']*\)'.*/\1/p")"
fi

printf '{"versionName":"%s","versionCode":%s,"builtAt":"%s"}\n' \
  "${VN:-unknown}" "${VC:-0}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DEST.json"

echo "[publish-apk] Published → $DEST"
echo "[publish-apk] Version: ${VN:-?} (code ${VC:-?})"
echo "[publish-apk] The running server serves it immediately (no-store); the app"
echo "[publish-apk] update check fires on the next poll."
