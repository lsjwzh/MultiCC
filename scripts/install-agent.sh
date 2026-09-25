#!/bin/sh
# Install or remove com.multicc.agent, the per-user desktop agent (see
# scripts/macos-agent/MultiCCAgent.swift). No root: it is a LaunchAgent in the
# user's own GUI session, exactly where clicks and screen capture must run.
#
#   install-agent.sh install [--chrome-launch /path/launch.sh]
#   install-agent.sh uninstall
#   install-agent.sh status
#
# Layout:
#   ~/Applications/MultiCC Agent.app       the ONE program that holds the
#                                          Accessibility + Screen Recording grants
#   ~/Library/LaunchAgents/com.multicc.agent.plist
#   ~/.multicc/agent/                      0700: agent.sock, config.json, agent.log
#   ~/.multicc/bin/multicc-agent           client symlink for scripts and skills
#
# macOS stores each grant together with the program's designated requirement.
# Ad-hoc signed, that requirement is the exact code hash: every rebuild revokes
# the grants, and flipping the switch off/on in System Settings does NOT help
# (the stored hash stays stale; the entry must be removed and re-added). So:
#   - sign with a real certificate when the keychain has one (Developer ID
#     Application, then Apple Development, or MULTICC_AGENT_SIGN_IDENTITY);
#     the requirement is then "this identifier + this team" and survives
#     rebuilds. MULTICC_AGENT_SIGN_IDENTITY=- forces ad-hoc.
#   - rebuild ONLY when the Swift source changes (tracked by a stamp), and
#     re-sign without rebuilding when only the chosen identity changed.
set -eu

LABEL=com.multicc.agent
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/macos-agent/MultiCCAgent.swift"
APP="${MULTICC_AGENT_APP:-$HOME/Applications/MultiCC Agent.app}"
BIN="$APP/Contents/MacOS/MultiCCAgent"
PLIST="${MULTICC_AGENT_PLIST:-$HOME/Library/LaunchAgents/$LABEL.plist}"
DIR="${MULTICC_AGENT_DIR:-$HOME/.multicc/agent}"
LINK="${MULTICC_AGENT_LINK:-$HOME/.multicc/bin/multicc-agent}"
NO_LAUNCHCTL="${MULTICC_AGENT_NO_LAUNCHCTL:-}"
DOMAIN="gui/$(id -u)"

die() { echo "multicc-agent: $1" >&2; exit 1; }
lc() { [ -n "$NO_LAUNCHCTL" ] || launchctl "$@"; }

case "${1:-}" in
  uninstall)
    lc bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
    rm -f "$PLIST" "$LINK" "$DIR/agent.sock"
    rm -rf "$APP"
    # config.json and agent.log stay: they hold the user's choices and history.
    echo "multicc-agent: removed $LABEL (grants in System Settings can be deleted by hand)"
    exit 0
    ;;
  status)
    lc print "$DOMAIN/$LABEL" 2>/dev/null | grep -E '^\s*(state|pid|last exit code)' || echo "not loaded"
    [ -x "$BIN" ] && "$BIN" status || true
    exit 0
    ;;
  install) shift ;;
  *) die "usage: $0 install [--chrome-launch PATH] | uninstall | status" ;;
esac

CHROME_LAUNCH=""
while [ $# -gt 0 ]; do
  case "$1" in
    --chrome-launch) CHROME_LAUNCH="${2:-}"; shift 2 ;;
    *) die "unknown option: $1" ;;
  esac
done

# Prints the SHA-1 of the identity to sign with, or "-" for ad-hoc.
signing_identity() {
  if [ -n "${MULTICC_AGENT_SIGN_IDENTITY:-}" ]; then echo "$MULTICC_AGENT_SIGN_IDENTITY"; return; fi
  ids="$(security find-identity -v -p codesigning 2>/dev/null || true)"
  for kind in "Developer ID Application" "Apple Development"; do
    hash="$(printf '%s\n' "$ids" | awk -v k="\"$kind:" 'index($0, k) { print $2; exit }')"
    [ -n "$hash" ] && { echo "$hash"; return; }
  done
  echo -
}

[ -f "$SRC" ] || die "missing $SRC"
SUM="$(shasum -a 256 "$SRC" | cut -d' ' -f1)"
STAMP="$APP/Contents/Resources/source.sha256"
SIGNER_STAMP="$APP/Contents/Resources/signer"
SIGNER="$(signing_identity)"
REBUILT=""
if [ -x "$BIN" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$SUM" ]; then
  echo "multicc-agent: binary up to date"
else
  REBUILT=1
  mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
  TMP="$(mktemp "$APP/Contents/MacOS/.build.XXXXXX")"
  trap 'rm -f "$TMP"' EXIT
  # Deployment target macOS 11 (Big Sur) is the floor; newer systems get newer
  # code paths chosen at run time (see "Platform tiers" in the source). Newer
  # frameworks are weak-linked so the one binary still launches on 11, and only
  # when this SDK has them (an older SDK compiles those blocks out).
  SDK="$(xcrun --show-sdk-path 2>/dev/null || true)"
  WEAK=""
  for fw in ScreenCaptureKit; do
    [ -d "$SDK/System/Library/Frameworks/$fw.framework" ] && WEAK="$WEAK -Xlinker -weak_framework -Xlinker $fw"
  done
  # shellcheck disable=SC2086
  xcrun swiftc -O -target "$(uname -m)-apple-macos11.0" $WEAK -o "$TMP" "$SRC" \
    || die "swift build failed (need Xcode command line tools)"
  mv -f "$TMP" "$BIN"
  trap - EXIT
  cat > "$APP/Contents/Info.plist" <<INFO
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>$LABEL</string>
  <key>CFBundleName</key><string>MultiCC Agent</string>
  <key>CFBundleExecutable</key><string>MultiCCAgent</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
</dict>
</plist>
INFO
  printf '%s\n' "$SUM" > "$STAMP"
fi

if [ -n "$REBUILT" ] || [ "$(cat "$SIGNER_STAMP" 2>/dev/null)" != "$SIGNER" ]; then
  OLD_SIGNER="$(cat "$SIGNER_STAMP" 2>/dev/null || true)"
  # Installs from before the signer stamp existed were always ad-hoc.
  if [ -z "$OLD_SIGNER" ] && [ -z "$REBUILT" ]; then OLD_SIGNER=-; fi
  # Both stamps live in Resources, which the signature seals: write, then sign.
  printf '%s\n' "$SIGNER" > "$SIGNER_STAMP"
  if ! codesign --force --sign "$SIGNER" --identifier "$LABEL" --timestamp=none "$APP" >/dev/null 2>&1; then
    rm -f "$SIGNER_STAMP"
    die "codesign failed (identity $SIGNER)"
  fi
  codesign --verify --strict "$APP" 2>/dev/null || die "signature does not verify"
  if [ "$SIGNER" = - ]; then
    if [ -f "$PLIST" ]; then
      echo "multicc-agent: ad-hoc signed — grants are tied to this exact build; remove and re-add MultiCC Agent in System Settings"
    fi
  elif [ -n "$OLD_SIGNER" ] && [ "$OLD_SIGNER" != "$SIGNER" ]; then
    echo "multicc-agent: signing identity changed — remove and re-add MultiCC Agent in System Settings once; later rebuilds keep the grants"
  fi
fi
echo "multicc-agent: requirement $(codesign -dr - "$APP" 2>/dev/null | sed -n 's/^#* *designated => //p')"

mkdir -p "$DIR" "$(dirname "$LINK")" "$(dirname "$PLIST")"
chmod 0700 "$DIR"
ln -sf "$BIN" "$LINK"

# Config is written once and then belongs to the user; --chrome-launch updates
# only the launch path and turns the watchdog on.
if [ -n "$CHROME_LAUNCH" ]; then
  [ -f "$CHROME_LAUNCH" ] || die "no such launch script: $CHROME_LAUNCH"
  /usr/bin/python3 - "$DIR/config.json" "$CHROME_LAUNCH" <<'PY'
import json, os, sys
path, launch = sys.argv[1], sys.argv[2]
cfg = json.load(open(path)) if os.path.exists(path) else {}
ch = cfg.setdefault("chrome", {})
ch.update({"enabled": True, "launch": launch})
ch.setdefault("port", 9222)
json.dump(cfg, open(path, "w"), indent=2, ensure_ascii=False)
PY
elif [ ! -f "$DIR/config.json" ]; then
  printf '{\n  "chrome": { "enabled": false, "port": 9222, "launch": "" }\n}\n' > "$DIR/config.json"
fi

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$BIN</string><string>serve</string></array>
  <key>AssociatedBundleIdentifiers</key><array><string>$LABEL</string></array>
  <key>LimitLoadToSessionType</key><array><string>Aqua</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <!-- Chrome started by the launch script must outlive an agent restart. -->
  <key>AbandonProcessGroup</key><true/>
  <key>StandardErrorPath</key><string>$DIR/agent.log</string>
  <key>StandardOutPath</key><string>$DIR/agent.log</string>
</dict>
</plist>
PLIST_EOF
plutil -lint "$PLIST" >/dev/null || die "generated plist failed validation"

lc bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
# bootout returns before the old job is fully gone; bootstrap then fails with
# "5: Input/output error". Give it a few seconds.
n=0
until lc bootstrap "$DOMAIN" "$PLIST" 2>/dev/null; do
  n=$((n + 1))
  [ "$n" -lt 10 ] || die "launchctl bootstrap failed"
  sleep 0.5
done
echo "multicc-agent: installed $LABEL"
