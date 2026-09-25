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
# macOS keys an ad-hoc signed program's grants to its code hash, so rebuilding
# silently revokes them. The binary is therefore rebuilt ONLY when the Swift
# source changes (tracked by a stamp), never on a plain reinstall.
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

[ -f "$SRC" ] || die "missing $SRC"
SUM="$(shasum -a 256 "$SRC" | cut -d' ' -f1)"
STAMP="$APP/Contents/Resources/source.sha256"
if [ -x "$BIN" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$SUM" ]; then
  echo "multicc-agent: binary up to date (grants preserved)"
else
  [ -x "$BIN" ] && echo "multicc-agent: source changed — rebuilding; macOS will ask for the grants again"
  mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
  TMP="$(mktemp "$APP/Contents/MacOS/.build.XXXXXX")"
  trap 'rm -f "$TMP"' EXIT
  xcrun swiftc -O -o "$TMP" "$SRC" || die "swift build failed (need Xcode command line tools)"
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
</dict>
</plist>
INFO
  codesign --force --sign - --identifier "$LABEL" "$APP" >/dev/null 2>&1 || die "codesign failed"
  printf '%s\n' "$SUM" > "$STAMP"
fi

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
lc bootstrap "$DOMAIN" "$PLIST" || die "launchctl bootstrap failed"
echo "multicc-agent: installed $LABEL"
