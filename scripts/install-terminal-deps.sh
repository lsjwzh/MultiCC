#!/bin/bash
# Shared by the installer, service install, and explicit on-demand repair.
set -euo pipefail

if command -v tmux >/dev/null 2>&1; then
  tmux -V
  exit 0
fi

echo 'Installing tmux (required for terminal sessions and CLI login)...'
case "$(uname -s)" in
  Darwin)
    brew_cmd="$(command -v brew || true)"
    if [ -z "$brew_cmd" ]; then
      for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
        if [ -x "$candidate" ]; then brew_cmd="$candidate"; break; fi
      done
    fi
    if [ -z "$brew_cmd" ]; then
      echo 'Homebrew is required. Install Homebrew, then run ./multicc install-terminal.' >&2
      exit 1
    fi
    if ! HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 "$brew_cmd" install tmux; then
      echo 'Homebrew reported an error; checking whether tmux itself was installed.' >&2
    fi
    # Include the package manager prefix when launched with a restricted PATH.
    export PATH="$(dirname "$brew_cmd"):$PATH"
    ;;
  Linux)
    elevate=()
    if [ "$EUID" -ne 0 ]; then
      if ! command -v sudo >/dev/null 2>&1; then
        echo 'Installing tmux requires root or sudo.' >&2; exit 1
      fi
      elevate=(sudo)
    fi
    if command -v apt-get >/dev/null 2>&1; then
      "${elevate[@]}" apt-get update
      "${elevate[@]}" apt-get install -y tmux
    elif command -v dnf >/dev/null 2>&1; then
      "${elevate[@]}" dnf install -y tmux
    elif command -v yum >/dev/null 2>&1; then
      "${elevate[@]}" yum install -y tmux
    elif command -v pacman >/dev/null 2>&1; then
      "${elevate[@]}" pacman -S --needed --noconfirm tmux
    elif command -v apk >/dev/null 2>&1; then
      "${elevate[@]}" apk add tmux
    else
      echo 'Install tmux with your system package manager, then retry.' >&2; exit 1
    fi
    ;;
  *) echo 'Terminal sessions require tmux on macOS or Linux/WSL.' >&2; exit 1 ;;
esac

if ! command -v tmux >/dev/null 2>&1; then
  echo 'tmux installation did not produce an executable in PATH.' >&2
  exit 1
fi
tmux -V
