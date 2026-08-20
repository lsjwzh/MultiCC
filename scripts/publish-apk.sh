#!/usr/bin/env bash
#
# Build the Flutter release APK and publish it to public/multicc.apk so the
# in-app updater serves the current version. Also writes a version sidecar
# (public/multicc.apk.json) that /api/apk-info reads to show the real version
# in the "发现新版本 X" dialog.
#
# Run from anywhere:  ./scripts/publish-apk.sh [--if-missing]
# Remember to bump `version:` in app/pubspec.yaml first, or Android will treat
# the new build as the same version and refuse to install over the old one.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/app/build/app/outputs/flutter-apk/app-release.apk"
DEST="$ROOT/public/multicc.apk"
IF_MISSING=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --if-missing) IF_MISSING=true ;;
    --help|-h)
      echo "Usage: ./scripts/publish-apk.sh [--if-missing]"
      echo "  --if-missing  keep an existing APK only when its metadata is current"
      exit 0
      ;;
    *)
      echo "[publish-apk] ERROR: unknown option: $1" >&2
      exit 2
      ;;
  esac
  shift
done

if [ ! -f "$ROOT/app/pubspec.yaml" ]; then
  echo "[publish-apk] ERROR: missing app/pubspec.yaml under $ROOT" >&2
  exit 1
fi

APP_VERSION="$(awk '/^version:[[:space:]]*/ { sub(/^version:[[:space:]]*/, ""); print; exit }' "$ROOT/app/pubspec.yaml")"
VN="${APP_VERSION%%+*}"
if [ -z "$VN" ] || [ "$APP_VERSION" = "$VN" ]; then
  echo "[publish-apk] ERROR: app/pubspec.yaml must declare version: <name>+<integer>" >&2
  exit 1
fi
VC="${APP_VERSION##*+}"
case "$VC" in
  ''|*[!0-9]*)
    echo "[publish-apk] ERROR: pubspec versionCode must be an integer (got: $VC)" >&2
    exit 1
    ;;
esac

if [ "$IF_MISSING" = true ] && [ -s "$DEST" ] && [ -s "$DEST.json" ]; then
  PUBLISHED_META="$(tr -d '[:space:]' < "$DEST.json")"
  case "$PUBLISHED_META" in
    *\"versionName\":\"$VN\",\"versionCode\":$VC*)
      echo "[publish-apk] Current APK kept → $DEST (version $VN, code $VC)"
      exit 0
      ;;
  esac
fi

if ! command -v flutter >/dev/null 2>&1; then
  echo "[publish-apk] ERROR: Flutter SDK not found on PATH; cannot build Android APK." >&2
  echo "[publish-apk] Install Flutter, or run install.sh with --no-apk for a server-only install." >&2
  exit 1
fi

echo "[publish-apk] Building release APK…"
( cd "$ROOT/app" && flutter build apk --release )

if [ ! -s "$SRC" ]; then
  echo "[publish-apk] ERROR: Flutter reported success but produced no release APK at $SRC" >&2
  exit 1
fi

mkdir -p "$(dirname "$DEST")"
TMP_APK="${DEST}.tmp.$$"
TMP_SHA="${DEST}.sha1.tmp.$$"
TMP_JSON="${DEST}.json.tmp.$$"
cleanup() { rm -f "$TMP_APK" "$TMP_SHA" "$TMP_JSON"; }
trap cleanup EXIT
cp "$SRC" "$TMP_APK"

# Keep the legacy checksum sidecar in sync for scripts and mirrors that still
# verify the published APK before serving or copying it.
if command -v shasum >/dev/null 2>&1; then
  shasum -a 1 "$TMP_APK" | awk '{print $1}' > "$TMP_SHA"
elif command -v sha1sum >/dev/null 2>&1; then
  sha1sum "$TMP_APK" | awk '{print $1}' > "$TMP_SHA"
else
  echo "[publish-apk] WARNING: no SHA-1 utility found; checksum sidecar omitted" >&2
fi

# This build does not pass --build-name/--build-number, so pubspec.yaml is the
# authoritative version source on every platform; no Android SDK path probing is
# needed. Flutter accepts semver+integer here, and Android uses the two halves as
# versionName/versionCode.
printf '{"versionName":"%s","versionCode":%s,"builtAt":"%s"}\n' \
  "$VN" "$VC" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$TMP_JSON"

# Publish from the destination filesystem so a concurrent download sees either
# the complete old APK or the complete new one, never a partially copied file.
mv -f "$TMP_APK" "$DEST"
if [ -s "$TMP_SHA" ]; then
  mv -f "$TMP_SHA" "$DEST.sha1"
else
  rm -f "$DEST.sha1"
fi
mv -f "$TMP_JSON" "$DEST.json"
trap - EXIT

echo "[publish-apk] Published → $DEST"
echo "[publish-apk] Version: ${VN:-?} (code $VC)"
echo "[publish-apk] The running server serves it immediately (no-store); the app"
echo "[publish-apk] update check fires on the next poll."
