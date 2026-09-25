#!/bin/bash
# mcu.sh — one entry point for screenshots and input, whichever backend exists.
#
#   agent   MultiCC Agent (com.multicc.agent): one app holds Accessibility +
#           Screen Recording, so it works from any CLI, any provider, `-p` mode.
#           Adds element-level control (see / click-el / set / press) and the
#           safety rails: Esc stop, one session at a time, locked-screen and
#           protected-app refusals.
#   legacy  screencapture + cliclick + _cu_scroll: works only if the CALLING
#           process chain (terminal / node / cliclick) has been granted.
#
# Usage:
#   mcu.sh backend                         print "agent" or "legacy: <reason>"
#   mcu.sh status                          agent grants, lock, Esc stop, lease
#   mcu.sh see [APP|pid:N] [--json]        elements of APP's front window (agent only)
#   mcu.sh click-el|rclick-el|dclick-el ID act on an element from the latest see
#   mcu.sh click-text TEXT                 best text match from the latest see
#   mcu.sh set ID VALUE | type-el ID TEXT  write / type into an element
#   mcu.sh press CHORD [N]                 cmd+shift+g, return, escape, cmd+v ...
#   mcu.sh snap OUT.png [W H X Y]          screenshot at LOGICAL resolution, optional crop
#   mcu.sh click|dclick|rclick|move X Y    logical coordinates, same as the snap
#   mcu.sh scroll X Y N                    N<0 down, N>0 up
#   mcu.sh type TEXT                       Unicode text into the focused field
#   mcu.sh resume | release                clear an Esc stop (only when the user says so) / free the lease
# MCU_BACKEND=legacy forces the fallback (useful to compare).
set -euo pipefail

AGENT="${MULTICC_AGENT_BIN:-$HOME/.multicc/bin/multicc-agent}"

backend() {
  if [ "${MCU_BACKEND:-}" = legacy ]; then echo "legacy: forced"; return; fi
  [ -x "$AGENT" ] || { echo "legacy: multicc-agent not installed"; return; }
  local s
  s=$("$AGENT" status 2>/dev/null) || { echo "legacy: multicc-agent not running"; return; }
  case "$s" in
    *'"accessibility":true'*'"screenRecording":true'*|*'"screenRecording":true'*'"accessibility":true'*) echo agent ;;
    *) echo "legacy: multicc-agent lacks Accessibility or Screen Recording grant" ;;
  esac
}
is_agent() { [ "$(backend)" = agent ]; }

# Stable legacy scroll binary: Homebrew bin on Apple silicon or Intel.
scroll_bin() {
  local d
  for d in "$(brew --prefix 2>/dev/null)/bin" /opt/homebrew/bin /usr/local/bin; do
    [ -x "$d/_cu_scroll" ] && { echo "$d/_cu_scroll"; return 0; }
  done
  return 1
}

need() { command -v "$1" >/dev/null || { echo "mcu: missing $1 (legacy backend)" >&2; exit 1; }; }

# Prints the agent's reply either way; a refusal exits 1 with the reason in it.
agent_call() { "$AGENT" "$@"; }

agent_only() {
  is_agent || { echo "mcu: '$1' needs MultiCC Agent ($(backend)); fall back to snap + click X Y" >&2; exit 1; }
}

cmd="${1:-}"; shift || true
case "$cmd" in
  backend) backend ;;
  status) agent_call status ;;

  see|click-el|rclick-el|dclick-el|click-text|set|type-el|resume|release)
    agent_only "$cmd"; agent_call "$cmd" "$@" ;;

  press|key)
    if is_agent; then agent_call press "$@"
    else
      case "${1:?chord}" in
        *+*) echo "mcu: chords need MultiCC Agent; legacy only has single keys" >&2; exit 1 ;;
      esac
      need cliclick; cliclick "kp:$1"
    fi
    ;;

  snap)
    OUT="${1:?output path required}"
    case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac
    if is_agent; then agent_call snap "$OUT" >/dev/null; else need screencapture; screencapture -x "$OUT"; fi
    # Resize pixels -> logical points so the model's coordinates are directly
    # clickable. Logical width comes from the desktop bounds (main display).
    PW=$(sips -g pixelWidth "$OUT" | awk '/pixelWidth/{print $2}')
    PH=$(sips -g pixelHeight "$OUT" | awk '/pixelHeight/{print $2}')
    LW=$(osascript -e 'tell application "Finder" to get item 3 of (get bounds of window of desktop)' 2>/dev/null || echo "$PW")
    LH=$(( PH * LW / PW ))
    [ "$LW" = "$PW" ] || sips -z "$LH" "$LW" "$OUT" --out "$OUT" >/dev/null
    if [ -n "${2:-}" ]; then
      sips "$OUT" --cropToHeightWidth "${3:?H}" "$2" --cropOffset "${5:-0}" "${4:-0}" --out "$OUT" >/dev/null
    fi
    echo "snap[$(backend | cut -d: -f1)]: ${LW}x${LH}${2:+ -> crop ${2}x${3} at ${4:-0},${5:-0}} -> $OUT"
    ;;

  click|dclick|rclick|move)
    X="${1:?X}"; Y="${2:?Y}"
    if is_agent; then agent_call "$cmd" "$X" "$Y"
    else
      need cliclick
      case "$cmd" in click) cliclick "c:$X,$Y" ;; dclick) cliclick "dc:$X,$Y" ;; rclick) cliclick "rc:$X,$Y" ;; move) cliclick "m:$X,$Y" ;; esac
    fi
    ;;

  scroll)
    X="${1:?X}"; Y="${2:?Y}"; N="${3:?N}"
    if is_agent; then agent_call scroll "$X" "$Y" "$N"
    elif S=$(scroll_bin); then "$S" "$X" "$Y" "$N"
    else echo "mcu: no scroll tool; run scripts/init.sh (legacy) or install multicc-agent" >&2; exit 1
    fi
    ;;

  type)
    TEXT="$*"; [ -n "$TEXT" ] || { echo "mcu: text required" >&2; exit 1; }
    if is_agent; then agent_call type "$TEXT"
    else
      # Clipboard + Cmd-V: plain keystroke garbles non-ASCII.
      need cliclick; printf '%s' "$TEXT" | pbcopy; cliclick kd:cmd t:v ku:cmd
    fi
    ;;

  ""|help|-h|--help) sed -n '2,26p' "$0" ;;
  *) echo "mcu: unknown command $cmd" >&2; exit 2 ;;
esac
