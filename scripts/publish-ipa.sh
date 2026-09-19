#!/usr/bin/env bash
#
# Publish a locally built IPA to the iOS OTA channel: copies it to
# public/multicc-ios.ipa and writes the metadata sidecar
# (public/multicc-ios.ipa.json) that /api/ios-ota-info and
# /ios-ota/manifest.plist read. The running server serves it immediately
# (no-store) — no restart, same model as scripts/publish-apk.sh.
#
#   ./scripts/publish-ipa.sh /path/to/Runner.ipa
#
# Build the IPA first (Xcode → Product → Archive → Distribute App → Custom,
# or `flutter build ipa --release --export-options-plist=...`). The embedded
# provisioning profile must contain the target device's UDID, otherwise iOS
# will refuse the install no matter how the IPA is delivered.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/public/multicc-ios.ipa"

if [ "$#" -ne 1 ] || [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  echo "Usage: ./scripts/publish-ipa.sh /path/to/app.ipa" >&2
  exit 2
fi
SRC="$1"
if [ ! -s "$SRC" ]; then
  echo "[publish-ipa] ERROR: IPA not found or empty: $SRC" >&2
  exit 1
fi
for TOOL in unzip plutil shasum; do
  if ! command -v "$TOOL" >/dev/null 2>&1; then
    echo "[publish-ipa] ERROR: required tool not found: $TOOL" >&2
    exit 1
  fi
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/multicc-ipa.XXXXXX")"
TMP_IPA="$DEST.tmp.$$"
TMP_JSON="$DEST.json.tmp.$$"
cleanup() { rm -rf "$WORK"; rm -f "$TMP_IPA" "$TMP_JSON"; }
trap cleanup EXIT

# An .ipa is a zip; the app's Info.plist holds the authoritative identity.
# (grep, not awk: the classic macOS BSD awk rejects "/" inside bracket
# expressions, so `[^/]` is not portable there.)
APP_PLIST_PATH="$(unzip -Z1 "$SRC" | grep -m1 -E '^Payload/[^/]+\.app/Info\.plist$' || true)"
if [ -z "$APP_PLIST_PATH" ]; then
  echo "[publish-ipa] ERROR: no Payload/*.app/Info.plist inside $SRC — not a valid iOS .ipa" >&2
  exit 1
fi
unzip -p "$SRC" "$APP_PLIST_PATH" > "$WORK/Info.plist"

plist_value() { plutil -extract "$1" raw -o - "$WORK/Info.plist" 2>/dev/null || true; }
VN="$(plist_value CFBundleShortVersionString)"
VC="$(plist_value CFBundleVersion)"
BUNDLE_ID="$(plist_value CFBundleIdentifier)"
TITLE="$(plist_value CFBundleDisplayName)"
[ -n "$TITLE" ] || TITLE="$(plist_value CFBundleName)"
[ -n "$TITLE" ] || TITLE="MultiCC"

if ! [[ "$VN" =~ ^[0-9A-Za-z][0-9A-Za-z._-]{0,79}$ ]]; then
  echo "[publish-ipa] ERROR: CFBundleShortVersionString missing/invalid: '$VN'" >&2
  exit 1
fi
if ! [[ "$VC" =~ ^[0-9A-Za-z][0-9A-Za-z._-]{0,79}$ ]]; then
  echo "[publish-ipa] ERROR: CFBundleVersion missing/invalid: '$VC'" >&2
  exit 1
fi
if ! [[ "$BUNDLE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{1,127}$ ]]; then
  echo "[publish-ipa] ERROR: CFBundleIdentifier missing/invalid: '$BUNDLE_ID'" >&2
  exit 1
fi

# ── 分发方式闸门：描述文件里必须列着设备 UDID ───────────────────────────────
# itms-services 只认 development / ad-hoc（In-House）那几类描述文件 —— 它们才带
# ProvisionedDevices。App Store 分发型（名字里的 "iOS Team Store Provisioning
# Profile"、ProfileDistributionType=STORE）一台设备都不列，手机把整个包下完之后
# 会静默丢掉：服务器这边 manifest、HEAD、GET 全 200，页面上安装按钮也是亮的，只有
# 用户那边「点了没反应」，然后继续用旧版跑。2026-09-20 发的 129 就是这么废掉的
# （build 用了 method=app-store 的 ExportOptions），所以这一条放在发布前拦。
#
# 测试口子：MULTICC_IPA_PROFILE_PLIST 指到一份已经解好的描述文件 plist 时，跳过
# security cms —— 真签名没法在单测里造出来，但两种结局（有设备 / 没设备）都要能验。
PROFILE_ENTRY="$(unzip -Z1 "$SRC" | grep -m1 -E '^Payload/[^/]+\.app/embedded\.mobileprovision$' || true)"
if [ -z "$PROFILE_ENTRY" ]; then
  echo "[publish-ipa] ERROR: $SRC 里没有 Payload/*.app/embedded.mobileprovision —— 不能投放" >&2
  exit 1
fi
if [ -n "${MULTICC_IPA_PROFILE_PLIST:-}" ]; then
  cp "$MULTICC_IPA_PROFILE_PLIST" "$WORK/profile.plist"
elif ! unzip -p "$SRC" "$PROFILE_ENTRY" > "$WORK/profile.mobileprovision" \
  || ! security cms -D -i "$WORK/profile.mobileprovision" > "$WORK/profile.plist" 2>/dev/null; then
  echo "[publish-ipa] ERROR: 解不开 $PROFILE_ENTRY（security cms -D 失败）—— 这个包装不上，先别发布" >&2
  exit 1
fi
if ! plutil -extract ProvisionedDevices raw -o - "$WORK/profile.plist" >/dev/null 2>&1; then
  echo "[publish-ipa] ERROR: 这个 IPA 是 App Store 分发型签的 —— 描述文件里一台设备都没有，" >&2
  echo "  itms-services 装不上（手机会下载完再静默丢掉，用户只看到「点了没反应」）。" >&2
  echo "  改用 development 重新导出：在 app/ 下运行" >&2
  echo "    flutter build ipa --release --export-options-plist=<method=development 的 plist>" >&2
  echo "  仓库自带的 app/ios/ExportOptions.plist 是 app-store-connect，产出的包不能走这条通道。" >&2
  exit 1
fi

IPA_SHA256="$(shasum -a 256 "$SRC" | awk '{print $1}')"
IPA_SIZE="$(wc -c < "$SRC" | tr -d '[:space:]')"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
TITLE_JSON="$(printf '%s' "$TITLE" | tr -d '\r\n' | sed 's/\\/\\\\/g; s/"/\\"/g')"

printf '{"schemaVersion":1,"versionName":"%s","versionCode":"%s","bundleId":"%s","title":"%s","sha256":"%s","size":%s,"builtAt":"%s"}\n' \
  "$VN" "$VC" "$BUNDLE_ID" "$TITLE_JSON" "$IPA_SHA256" "$IPA_SIZE" "$BUILT_AT" > "$TMP_JSON"

# Publish from the destination directory so a concurrent download sees either
# the complete old IPA or the complete new one, never a partial copy.
cp "$SRC" "$TMP_IPA"
mv -f "$TMP_IPA" "$DEST"
mv -f "$TMP_JSON" "$DEST.json"
cleanup
trap - EXIT

echo "[publish-ipa] Published → $DEST"
echo "[publish-ipa] Version: $VN (build $VC) · $BUNDLE_ID · $((IPA_SIZE / 1024 / 1024)) MB"
echo "[publish-ipa] The running server serves it immediately (no-store)."
echo "[publish-ipa] Install page (HTTPS required): ${MULTICC_OTA_BASE:-https://<your-funnel-host>}/ios-ota"
