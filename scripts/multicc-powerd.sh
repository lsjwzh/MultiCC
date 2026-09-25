#!/bin/sh
# com.multicc.powerd — MultiCC's root power reconciler (installed by
# scripts/install-powerd.sh as /Library/PrivilegedHelperTools/com.multicc.powerd).
#
# What it is for: the sudoers helper (src/privileged-helper.js) removes the
# password prompt, but a one-shot `pmset -a disablesleep 1` is lost the moment
# another program resets it (observed: UU Remote's root helper clears
# SleepDisabled on its own schedule). This job holds the user's INTENT and puts
# the setting back.
#
# Why it stays as safe as the sudoers whitelist: it has no listener and accepts
# no arguments. launchd starts it (on intent-file change and every few seconds),
# it reads ONE word from the intent file, and the only root actions it can take
# are the same two fixed commands the sudoers drop-in already allows. Anything
# that is not exactly `on` or `off` is ignored.
#
# Intent semantics (deliberately asymmetric):
#   on   keep SleepDisabled=1, restoring it whenever something clears it
#   off  set SleepDisabled=0 ONCE when the intent changes to off, then leave it
#        alone — enforcing 0 would fight other apps' own "prevent sleep" switch
#   anything else / missing: unmanaged, never touches pmset
set -u

DIR=/Library/Application\ Support/multicc
PMSET=/usr/bin/pmset
# Test hooks. Honoured only when NOT root: launchd gives the real job a fixed
# environment, and a root process must never take paths from its environment.
if [ "$(id -u)" != "0" ]; then
  DIR="${MULTICC_POWERD_DIR:-$DIR}"
  PMSET="${MULTICC_POWERD_PMSET:-$PMSET}"
fi
INTENT="$DIR/power-intent"
STATE="$DIR/powerd.state"
STATUS="$DIR/powerd-status.json"

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

read_intent() {
  # Refuse a symlink: the directory is root-owned so the user cannot swap the
  # file, but the check is cheap and keeps root from following a planted link.
  [ -f "$INTENT" ] && [ ! -L "$INTENT" ] || { echo none; return; }
  word=$(head -c 16 "$INTENT" 2>/dev/null | tr -d ' \t\r\n')
  case "$word" in on|off) echo "$word" ;; *) echo none ;; esac
}

observed() {
  "$PMSET" -g 2>/dev/null | awk '/^[ \t]*SleepDisabled[ \t]/ { print $2; exit }'
}

# State file: "<last intent acted on> <restore count> <last restore time>".
LAST=none; RESTORES=0; LAST_RESTORE=
if [ -f "$STATE" ] && [ ! -L "$STATE" ]; then
  read -r LAST RESTORES LAST_RESTORE < "$STATE" 2>/dev/null || true
  case "$RESTORES" in ''|*[!0-9]*) RESTORES=0 ;; esac
fi

intent=$(read_intent)
before=$(observed)
action=none

case "$intent" in
  on)
    if [ "$before" != "1" ]; then
      "$PMSET" -a disablesleep 1 >/dev/null 2>&1 && action=set-1 || action=set-1-failed
      # A reset after we already held "on" is exactly the case this job exists
      # for; count it so the UI can say "restored N times".
      if [ "$LAST" = on ] && [ "$action" = set-1 ]; then
        RESTORES=$((RESTORES + 1)); LAST_RESTORE=$(now)
      fi
    fi
    ;;
  off)
    if [ "$LAST" != off ] && [ "$before" != "0" ]; then
      "$PMSET" -a disablesleep 0 >/dev/null 2>&1 && action=set-0 || action=set-0-failed
    fi
    ;;
esac

after=$(observed)
case "$action" in *failed) ;; *) LAST=$intent ;; esac
umask 022
printf '%s %s %s\n' "$LAST" "$RESTORES" "$LAST_RESTORE" > "$STATE"
printf '{"intent":"%s","observed":"%s","action":"%s","restores":%s,"lastRestoreAt":"%s","updatedAt":"%s"}\n' \
  "$intent" "${after:-unknown}" "$action" "$RESTORES" "$LAST_RESTORE" "$(now)" > "$STATUS"
exit 0
