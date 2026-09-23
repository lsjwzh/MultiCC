#!/bin/sh
# Install or remove MultiCC's optional privileged helper: a sudoers drop-in that
# lets one user run a fixed set of complete commands as root without a password.
# Run as root (MultiCC invokes it through one `with administrator privileges`
# prompt); it is also fine to run by hand with sudo.
#
#   install-privileged-helper.sh install <username>
#   install-privileged-helper.sh uninstall
#
# A malformed file in /etc/sudoers.d disables sudo for the whole machine, so the
# content is validated with visudo BEFORE it is moved into place, and is written
# via a temp file + atomic mv so there is never a moment where a half-written
# file is live.
set -eu

TARGET=/etc/sudoers.d/multicc

die() { echo "multicc-helper: $1" >&2; exit 1; }

# Dry run exists so the generate-and-validate path above can be tested without
# root and without touching the real /etc/sudoers.d. It writes to a caller-named
# file and skips only the two steps that require root (chown, and the final
# check of the live sudoers); the content and visudo validation are identical.
DRYRUN="${MULTICC_HELPER_DRYRUN:-}"
if [ -n "$DRYRUN" ]; then
  TARGET="${MULTICC_HELPER_TARGET:-}"
  [ -n "$TARGET" ] || die "dry run requires MULTICC_HELPER_TARGET"
else
  [ "$(id -u)" = "0" ] || die "must run as root"
fi

case "${1:-}" in
  uninstall)
    rm -f "$TARGET"
    echo "multicc-helper: removed $TARGET"
    exit 0
    ;;
  install) ;;
  *) die "usage: $0 install <username> | uninstall" ;;
esac

USER_NAME="${2:-}"
[ -n "$USER_NAME" ] || die "install requires a username"
# Mirrors the check in src/privileged-helper.js. A username is the only caller
# input this script accepts, and it is interpolated into a sudoers rule, so it
# is constrained to characters that cannot terminate or extend that rule.
case "$USER_NAME" in
  *[!a-zA-Z0-9._-]*) die "refusing an unusual username: $USER_NAME" ;;
esac
[ -n "$DRYRUN" ] || id -u "$USER_NAME" >/dev/null 2>&1 || die "no such user: $USER_NAME"

TMP="$(mktemp /tmp/multicc-sudoers.XXXXXX)"
trap 'rm -f "$TMP"' EXIT

cat > "$TMP" <<RULES
# Installed by MultiCC. Safe to delete: MultiCC falls back to prompting for
# a password each time. Each line is a COMPLETE command with no arguments
# supplied by the caller; never add a path, filename or wildcard here.
$USER_NAME ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0
$USER_NAME ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 1
RULES

# -f checks this file specifically rather than the live /etc/sudoers.
visudo -c -f "$TMP" >/dev/null 2>&1 || die "generated sudoers file failed validation; nothing was changed"

# sudo silently ignores a drop-in that is group/world-writable or not owned by
# root, so the mode and owner are part of the contract, not hygiene.
[ -n "$DRYRUN" ] || chown root:wheel "$TMP"
chmod 0440 "$TMP"
mv -f "$TMP" "$TARGET"
trap - EXIT

# Prove the whole thing is live rather than merely written.
if [ -z "$DRYRUN" ]; then
  visudo -c >/dev/null 2>&1 || die "sudoers is invalid after install (unexpected) — remove $TARGET"
fi
echo "multicc-helper: installed $TARGET for $USER_NAME"
