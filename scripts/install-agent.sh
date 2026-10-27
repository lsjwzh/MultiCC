#!/bin/sh
# Install or remove com.multicc.agent, the per-user desktop agent (see
# scripts/macos-agent/MultiCCAgent.swift). It is a LaunchAgent in the
# user's own GUI session, exactly where clicks and screen capture must run.
# Only copying the signed bundle into /Applications may need administrator
# approval; the Agent and its LaunchAgent always run as the logged-in user.
#
#   install-agent.sh install [--chrome-launch /path/launch.sh]
#   install-agent.sh uninstall
#   install-agent.sh status
#
# MultiCC runs "install" by itself at startup (src/macos-agent-provision.js)
# whenever the agent is missing or its source changed, so installing or
# updating MultiCC installs or updates the agent. "uninstall" turns that off
# (marker file auto-install-disabled); a manual "install" turns it back on.
#
# Binary: the release package ships a prebuilt universal one
# (macos-agent/prebuilt/, with the SHA-256 of the source it was built from);
# it is used when it matches the source. Otherwise build it here, which needs
# the Xcode command line tools.
#
# Layout:
#   /Applications/MultiCC Agent.app        the ONE program that holds the
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
PREBUILT="${MULTICC_AGENT_PREBUILT:-$HERE/macos-agent/prebuilt}"
APP="${MULTICC_AGENT_APP:-/Applications/MultiCC Agent.app}"
LEGACY_APP="${MULTICC_AGENT_LEGACY_APP:-$HOME/Applications/MultiCC Agent.app}"
# A custom installation is isolated unless its legacy path is explicit too.
MIGRATE_LEGACY=""
if [ -z "${MULTICC_AGENT_APP:-}" ] || [ -n "${MULTICC_AGENT_LEGACY_APP:-}" ]; then MIGRATE_LEGACY=1; fi
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
    if ! rm -rf "$APP" 2>/dev/null; then
      [ -z "$NO_LAUNCHCTL" ] || die "cannot remove $APP"
      /usr/bin/osascript - "$APP" <<'APPLESCRIPT' \
        || die "removal from Applications was not authorized"
on run argv
  do shell script "/bin/rm -rf " & quoted form of (item 1 of argv) with prompt "MultiCC 需要从全局「应用程序」目录移除桌面助手。" with administrator privileges
end run
APPLESCRIPT
    fi
    lc bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
    rm -f "$PLIST" "$LINK" "$DIR/agent.sock"
    # config.json and agent.log stay: they hold the user's choices and history.
    # The marker stops MultiCC from reinstalling it at the next start.
    mkdir -p "$DIR" && : > "$DIR/auto-install-disabled"
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

# Build/sign as the user in a private staging directory. Never run this
# installer as root: launchctl, sockets and configuration belong to that user.
TARGET_APP="$APP"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/multicc-agent-install.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
APP="$WORK/MultiCC Agent.app"
if [ -d "$TARGET_APP" ]; then
  /usr/bin/ditto "$TARGET_APP" "$APP"
elif [ -n "$MIGRATE_LEGACY" ] && [ -d "$LEGACY_APP" ] && [ ! -L "$LEGACY_APP" ] \
  && [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$LEGACY_APP/Contents/Info.plist" 2>/dev/null || true)" = "$LABEL" ]; then
  # Reuse the signed bundle so a path-only migration does not rebuild or re-sign.
  /usr/bin/ditto "$LEGACY_APP" "$APP"
fi
BIN="$APP/Contents/MacOS/MultiCCAgent"

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
SUM="$(cat "$SRC" "$HERE/macos-agent/LidBrightnessBridge.h" "$HERE/macos-agent/LidBrightnessBridge.m" "$HERE/macos-agent/MultiCCAgentH264.swift" "$HERE/macos-agent/AgentPermissions.swift" | /usr/bin/openssl dgst -sha256 | awk '{print $NF}')"
# shasum uses Perl, which can fail in a broken LC_CTYPE environment while a
# shell pipeline still exits successfully. Never install with an empty stamp.
[ "${#SUM}" -eq 64 ] || die "could not hash Agent sources"
case "$SUM" in *[!0-9a-f]*) die "invalid Agent source hash" ;; esac
STAMP="$APP/Contents/Resources/source.sha256"
SIGNER_STAMP="$APP/Contents/Resources/signer"
SIGNER="$(signing_identity)"
REBUILT=""
RESOURCES_CHANGED=""
if [ -x "$BIN" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$SUM" ]; then
  echo "multicc-agent: binary up to date"
else
  REBUILT=1
  mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
  TMP="$(mktemp "$APP/Contents/MacOS/.build.XXXXXX")"
  # A prebuilt binary is usable whenever it matches this source — `-x` would
  # send a package whose mode bits got dropped in transit down the build path,
  # which then fails on a Mac without the command line tools.
  PREBIN="$PREBUILT/MultiCCAgent"
  if [ -f "$PREBIN" ] && [ "$(cat "$PREBUILT/source.sha256" 2>/dev/null)" = "$SUM" ]; then
    cp "$PREBIN" "$TMP"
    echo "multicc-agent: using prebuilt binary"
  else
    sh "$HERE/macos-agent/build.sh" "$TMP" \
      || die "swift build failed (need Xcode command line tools: xcode-select --install)"
  fi
  # mktemp creates 0600 and cp keeps an existing destination's mode, so a plain
  # copy would leave the binary non-executable: launchd cannot start it, every
  # request fails, and the app looks "installed but never ready". The mode is
  # not part of the code signature, so it must (and may) be fixed before signing.
  chmod 0755 "$TMP"
  mv -f "$TMP" "$BIN"
  [ -x "$BIN" ] || die "$BIN is not executable"
  cat > "$APP/Contents/Info.plist" <<INFO
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>$LABEL</string>
  <key>CFBundleName</key><string>MultiCC Agent</string>
  <key>CFBundleExecutable</key><string>MultiCCAgent</string>
  <key>CFBundleIconFile</key><string>AgentIcon.icns</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
</dict>
</plist>
INFO
  printf '%s\n' "$SUM" > "$STAMP"
fi

# Repair old bundles even when the executable is current. Never rebuild Swift
# just to update artwork, and never modify sealed resources on a no-op install.
ICON="$HERE/macos-agent/AgentIcon.icns"
[ -f "$ICON" ] || die "missing $ICON"
if ! cmp -s "$ICON" "$APP/Contents/Resources/AgentIcon.icns"; then
  cp "$ICON" "$APP/Contents/Resources/AgentIcon.icns"
  RESOURCES_CHANGED=1
fi
if [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIconFile' "$APP/Contents/Info.plist" 2>/dev/null || true)" != AgentIcon.icns ]; then
  /usr/libexec/PlistBuddy -c 'Delete :CFBundleIconFile' "$APP/Contents/Info.plist" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c 'Add :CFBundleIconFile string AgentIcon.icns' "$APP/Contents/Info.plist"
  RESOURCES_CHANGED=1
fi

if [ -n "$REBUILT" ] || [ -n "$RESOURCES_CHANGED" ] || [ "$(cat "$SIGNER_STAMP" 2>/dev/null)" != "$SIGNER" ]; then
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

# Only this fixed file-copy operation can elevate. Cancellation leaves the old
# LaunchAgent and client link intact; there is no silent per-user fallback.
[ ! -L "$TARGET_APP" ] || die "refusing to replace an App symlink: $TARGET_APP"
if [ ! -d "$TARGET_APP" ] || ! /usr/bin/diff -qr "$APP" "$TARGET_APP" >/dev/null 2>&1; then
  codesign --verify --strict "$APP" 2>/dev/null || die "staged signature does not verify"
  if ! /usr/bin/ditto "$APP" "$TARGET_APP" 2>/dev/null; then
    [ -z "$NO_LAUNCHCTL" ] || die "cannot write $TARGET_APP"
    /usr/bin/osascript - "$APP" "$TARGET_APP" <<'APPLESCRIPT' \
      || die "installation in Applications was not authorized; the previous Agent remains configured"
on run argv
  set copyCommand to "/usr/bin/ditto " & quoted form of (item 1 of argv) & " " & quoted form of (item 2 of argv)
  do shell script copyCommand with prompt "MultiCC 需要将桌面助手安装到全局「应用程序」目录。" with administrator privileges
end run
APPLESCRIPT
  fi
fi
APP="$TARGET_APP"
BIN="$APP/Contents/MacOS/MultiCCAgent"
codesign --verify --strict "$APP" 2>/dev/null || die "installed signature does not verify"

# Register the finished, signed bundle so System Settings can resolve its
# display name and icon. This registers an app, never grants TCC permissions.
if [ -z "$NO_LAUNCHCTL" ]; then
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" >/dev/null 2>&1 || true
fi

mkdir -p "$DIR" "$(dirname "$LINK")" "$(dirname "$PLIST")"
chmod 0700 "$DIR"
rm -f "$DIR/auto-install-disabled"
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
# Retire only our recognized user-level bundle, after the global job started.
# Keep a recoverable copy alongside the existing per-user configuration.
if [ -n "$MIGRATE_LEGACY" ] && [ "$LEGACY_APP" != "$APP" ] && ! [ "$LEGACY_APP" -ef "$APP" ] && [ -d "$LEGACY_APP" ] && [ ! -L "$LEGACY_APP" ] \
  && [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$LEGACY_APP/Contents/Info.plist" 2>/dev/null || true)" = "$LABEL" ]; then
  if [ -z "$NO_LAUNCHCTL" ]; then
    /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "$LEGACY_APP" >/dev/null 2>&1 || true
  fi
  BACKUP="$(mktemp -d "$DIR/legacy-app-backup.XXXXXX")"
  mv "$LEGACY_APP" "$BACKUP/MultiCC Agent.app"
  echo "multicc-agent: migrated to $APP (previous App preserved in $BACKUP)"
fi
# Retire the old standalone display watcher only after the replacement starts.
# Keep its files for recovery; no user data is deleted.
if [ -z "$NO_LAUNCHCTL" ]; then
  launchctl bootout "$DOMAIN/com.zhuanz.lid-display-guard" >/dev/null 2>&1 || true
  LEGACY_PLIST="$HOME/Library/LaunchAgents/com.zhuanz.lid-display-guard.plist"
  [ ! -f "$LEGACY_PLIST" ] || mv "$LEGACY_PLIST" "$LEGACY_PLIST.disabled"
fi
echo "multicc-agent: installed $LABEL"
