#!/usr/bin/env bash
#
# Build the Flutter release APK and publish it to public/multicc.apk so the
# in-app updater serves the current version. Also writes a version sidecar
# (public/multicc.apk.json) that /api/apk-info reads to show the real version
# in the "发现新版本 X" dialog.
#
# Release workflow entry point:  ./scripts/publish-apk.sh [--if-missing]
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

# A distributable package must be traceable to one exact repository release.
# These values are intentionally mandatory even though local output remains
# ignored: the same files are uploaded as immutable GitHub Release assets.
RELEASE_TAG="${MULTICC_RELEASE_TAG:-}"
RELEASE_VERSION="${MULTICC_RELEASE_VERSION:-}"
RELEASE_COMMIT="${MULTICC_RELEASE_COMMIT:-${GITHUB_SHA:-}}"
if ! [[ "$RELEASE_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "[publish-apk] ERROR: MULTICC_RELEASE_TAG must be v<major>.<minor>.<patch>" >&2
  exit 1
fi
if ! [[ "$RELEASE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || [ "$RELEASE_TAG" != "v$RELEASE_VERSION" ]; then
  echo "[publish-apk] ERROR: MULTICC_RELEASE_VERSION must match MULTICC_RELEASE_TAG" >&2
  exit 1
fi
if ! [[ "$RELEASE_COMMIT" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "[publish-apk] ERROR: MULTICC_RELEASE_COMMIT must be a full Git commit SHA" >&2
  exit 1
fi
RELEASE_COMMIT="$(printf '%s' "$RELEASE_COMMIT" | tr '[:upper:]' '[:lower:]')"

if [ "$IF_MISSING" = true ] && [ -s "$DEST" ] && [ -s "$DEST.json" ] && [ -s "$DEST.sha256" ]; then
  PUBLISHED_META="$(tr -d '[:space:]' < "$DEST.json")"
  case "$PUBLISHED_META" in
    *\"versionName\":\"$VN\",\"versionCode\":$VC*\"releaseTag\":\"$RELEASE_TAG\"*)
      echo "[publish-apk] Current APK kept → $DEST (version $VN, code $VC)"
      exit 0
      ;;
  esac
fi

FLUTTER="${FLUTTER_BIN:-}"
if [ -z "$FLUTTER" ] && [ -n "${FLUTTER_ROOT:-}" ]; then FLUTTER="$FLUTTER_ROOT/bin/flutter"; fi
if [ -z "$FLUTTER" ] && command -v flutter >/dev/null 2>&1; then FLUTTER="$(command -v flutter)"; fi
if [ -z "$FLUTTER" ]; then
  for CANDIDATE in "${HOME:-}/flutter/bin/flutter" "${HOME:-}/flutter/flutter/bin/flutter" /opt/homebrew/bin/flutter /usr/local/bin/flutter; do
    if [ -x "$CANDIDATE" ]; then FLUTTER="$CANDIDATE"; break; fi
  done
fi
if [ -z "$FLUTTER" ] || [ ! -x "$FLUTTER" ]; then
  echo "[publish-apk] ERROR: Flutter SDK not found; cannot build Android APK." >&2
  echo "[publish-apk] Install Flutter or set FLUTTER_BIN on the release runner." >&2
  exit 1
fi

for SIGNING_VAR in \
  MULTICC_ANDROID_KEYSTORE_PATH \
  MULTICC_ANDROID_STORE_PASSWORD \
  MULTICC_ANDROID_KEY_ALIAS \
  MULTICC_ANDROID_KEY_PASSWORD \
  MULTICC_APK_EXPECTED_SIGNER_SHA256; do
  if [ -z "${!SIGNING_VAR:-}" ]; then
    echo "[publish-apk] ERROR: $SIGNING_VAR is required for an official APK" >&2
    exit 1
  fi
done
EXPECTED_SIGNER_SHA256="$(printf '%s' "$MULTICC_APK_EXPECTED_SIGNER_SHA256" \
  | tr -d '[:space:]:' | tr '[:upper:]' '[:lower:]')"
if ! [[ "$EXPECTED_SIGNER_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "[publish-apk] ERROR: MULTICC_APK_EXPECTED_SIGNER_SHA256 must be a SHA-256 certificate digest" >&2
  exit 1
fi

mkdir -p "$(dirname "$DEST")"
TMP_APK="${DEST}.tmp.$$"
TMP_SHA1="${DEST}.sha1.tmp.$$"
TMP_SHA256="${DEST}.sha256.tmp.$$"
TMP_JSON="${DEST}.json.tmp.$$"
LOCK_FILE="${MULTICC_APK_BUILD_LOCK:-}"
if [ -z "$LOCK_FILE" ] && command -v node >/dev/null 2>&1 && [ -f "$ROOT/src/paths.js" ]; then
  LOCK_FILE="$(cd "$ROOT" && node -e 'const p=require("path"),{createPaths}=require("./src/paths");process.stdout.write(p.join(createPaths({dataDir:process.env.MULTICC_DATA_DIR}).detachedDir,"apk-build.lock"))' 2>/dev/null || true)"
fi
LOCK_FILE="${LOCK_FILE:-${HOME:-$ROOT}/.multicc/detached/apk-build.lock}"
LOCK_CANDIDATE="${LOCK_FILE}.$$"
LOCK_HELD=false
cleanup() {
  rm -f "$TMP_APK" "$TMP_SHA1" "$TMP_SHA256" "$TMP_JSON" "$LOCK_CANDIDATE"
  if [ "$LOCK_HELD" = true ] && [ "$(cat "$LOCK_FILE" 2>/dev/null || true)" = "$$" ]; then rm -f "$LOCK_FILE"; fi
}
trap cleanup EXIT
mkdir -p "$(dirname "$LOCK_FILE")"
printf '%s\n' "$$" > "$LOCK_CANDIDATE"
if ! ln "$LOCK_CANDIDATE" "$LOCK_FILE" 2>/dev/null; then
  LOCK_PID="$(cat "$LOCK_FILE" 2>/dev/null || true)"
  if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
    echo "[publish-apk] ERROR: another APK build is already running (PID $LOCK_PID)." >&2
    exit 75
  fi
  rm -f "$LOCK_FILE"
  if ! ln "$LOCK_CANDIDATE" "$LOCK_FILE" 2>/dev/null; then
    echo "[publish-apk] ERROR: another APK build acquired the lock; retry later." >&2
    exit 75
  fi
fi
LOCK_HELD=true
rm -f "$LOCK_CANDIDATE"

echo "[publish-apk] Building release APK…"
# Surface a keystore/pin disagreement before a multi-minute build: gradle
# signs with whatever this keystore holds, and the post-build verifier pins
# the expected digest, so a mismatch here predetermines the failure. The
# lookup itself is best-effort (a missing keytool must not abort the build).
if ! KEYSTORE_DIGEST="$(keytool -list -v -keystore "$MULTICC_ANDROID_KEYSTORE_PATH" \
  -alias "$MULTICC_ANDROID_KEY_ALIAS" \
  -storepass "$MULTICC_ANDROID_STORE_PASSWORD" 2>/dev/null \
  | awk '/SHA256:/ {print $2; exit}' | tr -d '[:space:]:' | tr '[:upper:]' '[:lower:]')"; then
  KEYSTORE_DIGEST=""
fi
if [ -n "$KEYSTORE_DIGEST" ] && [ "$KEYSTORE_DIGEST" != "$EXPECTED_SIGNER_SHA256" ]; then
  echo "[publish-apk] WARNING: signing keystore certificate differs from the expected fingerprint; the build will fail verification" >&2
fi
( cd "$ROOT/app" && "$FLUTTER" build apk --release )

if [ ! -s "$SRC" ]; then
  echo "[publish-apk] ERROR: Flutter reported success but produced no release APK at $SRC" >&2
  exit 1
fi

cp "$SRC" "$TMP_APK"

# SHA-256 is part of the release contract. Keep SHA-1 only as a compatibility
# sidecar for older local tooling.
if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$TMP_APK" | awk '{print $1}' > "$TMP_SHA256"
  shasum -a 1 "$TMP_APK" | awk '{print $1}' > "$TMP_SHA1"
elif command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$TMP_APK" | awk '{print $1}' > "$TMP_SHA256"
  if command -v sha1sum >/dev/null 2>&1; then
    sha1sum "$TMP_APK" | awk '{print $1}' > "$TMP_SHA1"
  fi
else
  echo "[publish-apk] ERROR: no SHA-256 utility found" >&2
  exit 1
fi

APKSIGNER="${APKSIGNER_BIN:-}"
if [ -z "$APKSIGNER" ]; then
  for SDK_ROOT in "${ANDROID_SDK_ROOT:-}" "${ANDROID_HOME:-}" "${HOME:-}/Library/Android/sdk"; do
    [ -n "$SDK_ROOT" ] && [ -d "$SDK_ROOT/build-tools" ] || continue
    APKSIGNER="$(find "$SDK_ROOT/build-tools" -type f -name apksigner 2>/dev/null | sort | tail -1)"
    [ -n "$APKSIGNER" ] && break
  done
fi
if [ -z "$APKSIGNER" ] || [ ! -x "$APKSIGNER" ]; then
  echo "[publish-apk] ERROR: apksigner is required to verify the official certificate" >&2
  exit 1
fi
SIGNER_OUTPUT="$("$APKSIGNER" verify --print-certs "$TMP_APK")" || {
  echo "[publish-apk] ERROR: apksigner rejected the built APK" >&2
  exit 1
}
# apksigner prints the digest as the final field of the line, but the prefix
# differs across build-tools releases (≤36: "Signer #1 certificate SHA-256
# digest:"; 37: "V2 Signer: certificate SHA-256 digest:"). Match any digest
# line and take $NF so both formats parse (v1.6.3 release, runs 4-6).
SIGNER_SHA256="$(printf '%s\n' "$SIGNER_OUTPUT" \
  | awk '/certificate SHA-256 digest:/ { print $NF; exit }' \
  | tr -d '[:space:]:' | tr '[:upper:]' '[:lower:]')"
if [ -z "$SIGNER_SHA256" ]; then
  echo "[publish-apk] ERROR: could not parse a certificate digest from apksigner output" >&2
  echo "[publish-apk]   apksigner: $APKSIGNER" >&2
  echo "[publish-apk]   verifier output:" >&2
  printf '%s\n' "$SIGNER_OUTPUT" | head -5 | sed 's/^/    /' >&2
  exit 1
fi
if [ "$SIGNER_SHA256" != "$EXPECTED_SIGNER_SHA256" ]; then
  echo "[publish-apk] ERROR: APK signer certificate does not match the official fingerprint" >&2
  # Certificate digests are public data; printing them identifies which key
  # actually signed the APK (v1.6.3 release, runs 4-5).
  echo "[publish-apk]   apksigner: $APKSIGNER" >&2
  echo "[publish-apk]   got     : ${SIGNER_SHA256:-<nothing parsed from apksigner>}" >&2
  echo "[publish-apk]   want    : $EXPECTED_SIGNER_SHA256" >&2
  echo "[publish-apk]   verifier output:" >&2
  printf '%s\n' "$SIGNER_OUTPUT" | head -5 | sed 's/^/    /' >&2
  exit 1
fi

APK_SHA256="$(tr -d '[:space:]' < "$TMP_SHA256")"
APK_SIZE="$(wc -c < "$TMP_APK" | tr -d '[:space:]')"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# This build does not pass --build-name/--build-number, so pubspec.yaml is the
# authoritative Android version source. Release identity and signer identity
# make the sidecar independently auditable after it becomes a GitHub asset.
printf '{"schemaVersion":1,"versionName":"%s","versionCode":%s,"releaseTag":"%s","releaseVersion":"%s","gitCommit":"%s","sha256":"%s","size":%s,"signerSha256":"%s","builtAt":"%s"}\n' \
  "$VN" "$VC" "$RELEASE_TAG" "$RELEASE_VERSION" "$RELEASE_COMMIT" \
  "$APK_SHA256" "$APK_SIZE" "$SIGNER_SHA256" "$BUILT_AT" > "$TMP_JSON"

# Publish from the destination filesystem so a concurrent download sees either
# the complete old APK or the complete new one, never a partially copied file.
mv -f "$TMP_APK" "$DEST"
if [ -s "$TMP_SHA1" ]; then
  mv -f "$TMP_SHA1" "$DEST.sha1"
else
  rm -f "$DEST.sha1"
fi
mv -f "$TMP_SHA256" "$DEST.sha256"
mv -f "$TMP_JSON" "$DEST.json"
cleanup
trap - EXIT

echo "[publish-apk] Published → $DEST"
echo "[publish-apk] Version: ${VN:-?} (code $VC)"
echo "[publish-apk] The running server serves it immediately (no-store); the app"
echo "[publish-apk] update check fires on the next poll."
