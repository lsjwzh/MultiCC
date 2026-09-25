#!/bin/sh
# Install or remove com.multicc.powerd, the root LaunchDaemon that keeps the
# "run with the lid closed" setting at the user's intent (see
# scripts/multicc-powerd.sh for what it does and why it is safe). Run as root;
# MultiCC invokes it through one `with administrator privileges` prompt.
#
#   install-powerd.sh install <username>
#   install-powerd.sh uninstall
#
# Layout (mirrors how UU Remote splits its daemon, minus the XPC listener):
#   /Library/PrivilegedHelperTools/com.multicc.powerd   root:wheel 0755  the job
#   /Library/LaunchDaemons/com.multicc.powerd.plist     root:wheel 0644  launchd
#   /Library/Application Support/multicc/               root:wheel 0755
#     power-intent        <user>:staff 0644  the ONLY thing MultiCC writes
#     powerd-status.json  root 0644          last reconcile, read by MultiCC
#
# The job file must be root-owned and outside anything the user can write: if
# the user could edit it, installing this would hand them a root shell.
set -eu

LABEL=com.multicc.powerd
SRC="$(cd "$(dirname "$0")" && pwd)/multicc-powerd.sh"

die() { echo "multicc-powerd: $1" >&2; exit 1; }

# Dry run writes the whole layout under a caller-named prefix and skips only
# what needs root (chown, launchctl), so the generated files can be tested.
ROOT=""
if [ -n "${MULTICC_POWERD_DRYRUN:-}" ]; then
  ROOT="${MULTICC_POWERD_PREFIX:-}"
  [ -n "$ROOT" ] || die "dry run requires MULTICC_POWERD_PREFIX"
else
  [ "$(id -u)" = "0" ] || die "must run as root"
fi
JOB="$ROOT/Library/PrivilegedHelperTools/$LABEL"
PLIST="$ROOT/Library/LaunchDaemons/$LABEL.plist"
DATA="$ROOT/Library/Application Support/multicc"

as_root() { [ -n "$ROOT" ] || "$@"; }

case "${1:-}" in
  uninstall)
    as_root launchctl bootout "system/$LABEL" >/dev/null 2>&1 || true
    rm -f "$PLIST" "$JOB" "$DATA/power-intent" "$DATA/powerd.state" "$DATA/powerd-status.json"
    rmdir "$DATA" 2>/dev/null || true
    # The current SleepDisabled value is left as it is: uninstalling stops the
    # enforcement, it does not silently flip the user's machine back to sleeping.
    echo "multicc-powerd: removed $LABEL"
    exit 0
    ;;
  install) ;;
  *) die "usage: $0 install <username> | uninstall" ;;
esac

USER_NAME="${2:-}"
[ -n "$USER_NAME" ] || die "install requires a username"
case "$USER_NAME" in
  *[!a-zA-Z0-9._-]*) die "refusing an unusual username: $USER_NAME" ;;
esac
[ -n "$ROOT" ] || id -u "$USER_NAME" >/dev/null 2>&1 || die "no such user: $USER_NAME"
[ -f "$SRC" ] || die "missing $SRC"
/bin/sh -n "$SRC" || die "daemon script has a syntax error; nothing was changed"

mkdir -p "$(dirname "$JOB")" "$(dirname "$PLIST")" "$DATA"

TMP="$(mktemp "$(dirname "$JOB")/.$LABEL.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
cp "$SRC" "$TMP"
as_root chown root:wheel "$TMP"
chmod 0755 "$TMP"
mv -f "$TMP" "$JOB"

cat > "$TMP" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>/Library/PrivilegedHelperTools/$LABEL</string></array>
  <key>WatchPaths</key>
  <array><string>/Library/Application Support/multicc/power-intent</string></array>
  <key>StartInterval</key><integer>15</integer>
  <key>RunAtLoad</key><true/>
  <key>ThrottleInterval</key><integer>2</integer>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
PLIST_EOF
plutil -lint "$TMP" >/dev/null || die "generated plist failed validation; job file was installed but not loaded"
as_root chown root:wheel "$TMP"
chmod 0644 "$TMP"
mv -f "$TMP" "$PLIST"
trap - EXIT

as_root chown root:wheel "$DATA"
chmod 0755 "$DATA"
# Keep an existing intent across reinstalls; a fresh install starts unmanaged,
# so installing never changes the machine's current power setting by itself.
[ -f "$DATA/power-intent" ] || : > "$DATA/power-intent"
as_root chown "$USER_NAME:staff" "$DATA/power-intent"
chmod 0644 "$DATA/power-intent"

as_root launchctl bootout "system/$LABEL" >/dev/null 2>&1 || true
as_root launchctl bootstrap system "$PLIST" || die "launchctl bootstrap failed"
echo "multicc-powerd: installed $LABEL for $USER_NAME"
