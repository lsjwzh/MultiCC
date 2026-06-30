#!/bin/bash
# ============================================================================
# MultiCC — One-Click Install Script
# ============================================================================
# MultiCC version  1.0.0
# Release channel  stable — see https://github.com/lsjwzh/MultiCC/releases
# ============================================================================
# Usage:
#   Stable release:
#     curl -sSL https://raw.githubusercontent.com/lsjwzh/MultiCC/v1.0.0/install.sh | bash
#   Latest (main branch, may be ahead of the latest stable release):
#     curl -sSL https://raw.githubusercontent.com/lsjwzh/MultiCC/main/install.sh | bash
#
# Or download and run locally:
#   chmod +x install.sh && ./install.sh
#
# Options:
#   --dir <path>       Install into this directory (default: ./MultiCC)
#   --token <xxx>      Pre-set ACCESS_TOKEN (default: auto-generate)
#   --port <port>      Server port (default: 3000)
#   --no-service       Skip launchd/systemd service installation
#   --no-clone         Use current directory; don't git clone
#   --branch <name>    Git branch to clone (default: main)
#   --help             Show this help
#
# After install:
#   cd MultiCC && ./multicc start     # start server
#   cd MultiCC && ./multicc install   # install as background service (macOS)
# ============================================================================

set -euo pipefail

# ── Color helpers ─────────────────────────────────────────────────────────
if [ -t 1 ] && command -v tput >/dev/null 2>&1 && [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
  C_BOLD="$(tput bold)"
  C_RED="$(tput setaf 1)"
  C_GREEN="$(tput setaf 2)"
  C_YELLOW="$(tput setaf 3)"
  C_BLUE="$(tput setaf 4)"
  C_MAGENTA="$(tput setaf 5)"
  C_CYAN="$(tput setaf 6)"
  C_RESET="$(tput sgr0)"
else
  C_BOLD="" C_RED="" C_GREEN="" C_YELLOW="" C_BLUE="" C_MAGENTA="" C_CYAN="" C_RESET=""
fi

info()    { echo "${C_BLUE}[i]${C_RESET} $*"; }
ok()      { echo "${C_GREEN}[OK]${C_RESET} $*"; }
warn()    { echo "${C_YELLOW}[!]${C_RESET} $*"; }
err()     { echo "${C_RED}[ERROR]${C_RESET} $*"; }
step()    { echo ""; echo "${C_BOLD}${C_CYAN}>> $*${C_RESET}"; }

# Generate a random 20-char alphanumeric token. Must be SIGPIPE-safe: under
# `set -euo pipefail`, a `... | head -c 20` pipeline makes the upstream command
# exit 141 (SIGPIPE) once head closes the pipe, which would otherwise abort the
# whole script. Prefer openssl; the trailing `|| true` neutralizes that exit.
gen_token() {
  local t=""
  if command -v openssl >/dev/null 2>&1; then
    t="$(openssl rand -base64 32 2>/dev/null | LC_ALL=C tr -dc 'A-Za-z0-9' | head -c 20)" || true
  fi
  if [ -z "$t" ]; then
    t="$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom 2>/dev/null | head -c 20)" || true
  fi
  printf '%s' "$t"
}

# Safely upsert a KEY=VALUE line into .env without using sed. The value may
# contain characters that are special to sed's replacement (/, &, \) — e.g. a
# user-supplied --token — so a `sed "s/.../$VALUE/"` rewrite would corrupt the
# command or abort the script under `set -e`. We instead drop any existing line
# for KEY and append the literal new line. KEY is always a fixed literal here.
set_env_var() {
  local key="$1" val="$2" file="$3" tmp
  tmp="$(mktemp "${file}.XXXXXX")" || { err "Could not create temp file next to $file"; exit 1; }
  if [ -f "$file" ]; then
    grep -v "^${key}=" "$file" > "$tmp" 2>/dev/null || true
  fi
  printf '%s=%s\n' "$key" "$val" >> "$tmp"
  mv "$tmp" "$file"
}

banner() {
  echo ""
  echo "${C_BOLD}${C_MAGENTA}╔══════════════════════════════════════════════════════╗${C_RESET}"
  echo "${C_BOLD}${C_MAGENTA}║${C_RESET}  MultiCC — One-Click Installer"
  echo "${C_BOLD}${C_MAGENTA}║${C_RESET}  Multi-Client Claude Code — drive one Claude Code CLI"
  echo "${C_BOLD}${C_MAGENTA}║${C_RESET}  from browser, phone, or WeChat, all at once."
  echo "${C_BOLD}${C_MAGENTA}╚══════════════════════════════════════════════════════╝${C_RESET}"
  echo ""
}

# MultiCC version — keep in sync with package.json when cutting a release
INSTALLER_VERSION="1.0.0"

# ── Parse flags ──────────────────────────────────────────────────────────
INSTALL_DIR=""
ACCESS_TOKEN=""
PORT="3000"
NO_SERVICE=false
NO_CLONE=false
BRANCH="main"

# Guard value-taking flags: under `set -u`, referencing $2 when a flag is the
# last argument aborts with an unhelpful "$2: unbound variable". Fail cleanly.
need_val() { [ "$2" -ge 2 ] || { err "Option $1 requires a value (use --help)"; exit 1; }; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)       need_val "$1" "$#"; INSTALL_DIR="$2"; shift 2 ;;
    --token)     need_val "$1" "$#"; ACCESS_TOKEN="$2"; shift 2 ;;
    --port)      need_val "$1" "$#"; PORT="$2"; shift 2 ;;
    --no-service) NO_SERVICE=true; shift ;;
    --no-clone)  NO_CLONE=true; shift ;;
    --branch)    need_val "$1" "$#"; BRANCH="$2"; shift 2 ;;
    --help|-h)
      cat << HELP
MultiCC — One-Click Install Script  v${INSTALLER_VERSION}

Usage — stable release:
  curl -sSL https://raw.githubusercontent.com/lsjwzh/MultiCC/v${INSTALLER_VERSION}/install.sh | bash

Usage — latest (main branch, may be ahead of stable):
  curl -sSL https://raw.githubusercontent.com/lsjwzh/MultiCC/main/install.sh | bash

Or download and run locally:
  chmod +x install.sh && ./install.sh

Options:
  --dir <path>       Install into this directory (default: ./MultiCC)
  --token <xxx>      Pre-set ACCESS_TOKEN (default: auto-generate)
  --port <port>      Server port (default: 3000)
  --no-service       Skip launchd/systemd service installation
  --no-clone         Use current directory; don't git clone
  --branch <name>    Git branch to clone (default: main)
  --help             Show this help

After install:
  cd MultiCC && ./multicc start     # start server
  cd MultiCC && ./multicc install   # install as background service (macOS)
HELP
      exit 0
      ;;
    *) err "Unknown option: $1 (use --help)"; exit 1 ;;
  esac
done


REPO_URL="https://github.com/lsjwzh/MultiCC.git"

# Validate --port early so we never write a non-numeric PORT into .env.
case "$PORT" in
  ''|*[!0-9]*) err "Invalid --port: '$PORT' (must be a number, e.g. 3000)"; exit 1 ;;
esac

banner

# ── Check OS ──────────────────────────────────────────────────────────────
step "Checking environment"
OS="$(uname -s)"
if [ "$OS" = "Darwin" ]; then
  ok "macOS detected"
  IS_MACOS=true
  IS_LINUX=false
elif [ "$OS" = "Linux" ]; then
  ok "Linux detected"
  IS_MACOS=false
  IS_LINUX=true
  if grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null; then
    info "WSL detected — Linux install path is used; browser/audio/service behavior may differ from native Linux"
  fi
else
  warn "Unsupported OS: $OS — may still work but is untested"
  IS_MACOS=false
  IS_LINUX=false
fi

# ── Detect Node.js ────────────────────────────────────────────────────────
# server.js does `require('chokidar')`, and chokidar 5 is ESM-only. Loading a
# pure-ESM package via require() without a flag was only backported to Node
# 20.19.0 (20.x line) and 22.12.0 (22.x line). On Node 18 or 20.0–20.18 the
# server crashes at startup with ERR_REQUIRE_ESM, so we gate here on the exact
# floor (≥20.19.0) instead of letting users discover it only at `start`.
NODE_MIN_MAJOR=20
NODE_MIN_MINOR=19

# 0 (true) if major.minor is older than the required floor.
node_too_old() {
  [ "$1" -lt "$NODE_MIN_MAJOR" ] && return 0
  [ "$1" -gt "$NODE_MIN_MAJOR" ] && return 1
  [ "$2" -lt "$NODE_MIN_MINOR" ]
}

print_node_install_hint() {
  echo ""
  if [ "$IS_MACOS" = true ]; then
    echo "  Install: brew install node       # Homebrew ships a current (>= 20.19) Node"
  else
    echo "  Install:"
    echo "    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -   # recommended (>= 20.19)"
    echo "    sudo apt-get install -y nodejs"
  fi
  echo "  Or visit: https://nodejs.org/en/download   (pick an LTS >= 20.19)"
}

if command -v node >/dev/null 2>&1; then
  NODE_VERSION="$(node --version | sed 's/^v//')"
  NODE_MAJOR="$(echo "$NODE_VERSION" | cut -d. -f1)"
  NODE_MINOR="$(echo "$NODE_VERSION" | cut -d. -f2)"
  if node_too_old "$NODE_MAJOR" "$NODE_MINOR"; then
    err "Node.js v${NODE_VERSION} found, but v${NODE_MIN_MAJOR}.${NODE_MIN_MINOR}.0+ is required."
    echo "  (the server depends on chokidar 5, whose require(ESM) support landed in Node 20.19 / 22.12)"
    print_node_install_hint
    exit 1
  fi
  ok "Node.js v${NODE_VERSION}"
else
  err "Node.js is not installed (v${NODE_MIN_MAJOR}.${NODE_MIN_MINOR}.0+ is required)."
  print_node_install_hint
  exit 1
fi

# ── Detect npm ────────────────────────────────────────────────────────────
if command -v npm >/dev/null 2>&1; then
  ok "npm $(npm --version)"
else
  err "npm not found — should come with Node.js. Please reinstall."
  exit 1
fi

# ── Detect git ────────────────────────────────────────────────────────────
if command -v git >/dev/null 2>&1; then
  ok "git $(git --version | awk '{print $3}')"
else
  err "git is not installed."
  if [ "$IS_MACOS" = true ]; then
    echo "  Run: xcode-select --install"
  else
    echo "  Run: sudo apt-get install -y git"
  fi
  exit 1
fi

# ── Detect tmux (recommended, not required) ───────────────────────────────
if command -v tmux >/dev/null 2>&1; then
  ok "tmux $(tmux -V 2>/dev/null | awk '{print $2}')"
else
  warn "tmux not found — terminal mode won't work (chat mode is unaffected)"
  if [ "$IS_MACOS" = true ]; then
    echo "       Install: brew install tmux"
  else
    echo "       Install: sudo apt-get install -y tmux"
  fi
fi

# ── Detect OpenSSL (recommended, not required at install time) ─────────────
if command -v openssl >/dev/null 2>&1; then
  ok "$(openssl version 2>/dev/null | head -1)"
else
  warn "openssl not found — HTTPS certificate generation may fail when the server starts"
  if [ "$IS_MACOS" = true ]; then
    echo "       Install: brew install openssl"
  elif [ "$IS_LINUX" = true ]; then
    echo "       Install: sudo apt-get install -y openssl"
  else
    echo "       Install OpenSSL using your OS package manager."
  fi
fi

# ── Detect AI coding CLIs (recommended, not required for install) ──────────
detect_cli() {
  local cmd="$1"
  local label="$2"
  local login_hint="$3"
  local found version

  if found="$(command -v "$cmd" 2>/dev/null)"; then
    version="$("$cmd" --version 2>/dev/null | head -1 || true)"
    if [ -n "$version" ]; then
      ok "$label CLI found: $found ($version)"
    else
      ok "$label CLI found: $found"
    fi
  else
    warn "$label CLI not found — sessions using $cmd will fail until it is installed and logged in"
    echo "       $login_hint"
  fi
}

detect_cli "claude" "Claude Code" "Install/login first, then verify with: claude --version"
detect_cli "codex" "Codex" "Optional unless you create Codex sessions; verify with: codex --version"

if command -v flutter >/dev/null 2>&1; then
  FLUTTER_VERSION="$(flutter --version 2>/dev/null | head -1 | sed 's/^Flutter //' || true)"
  ok "Flutter ${FLUTTER_VERSION:-found}"
else
  info "Flutter not found — only needed if you build the Android/iOS app yourself; server install is unaffected"
fi

# ── Determine install directory ───────────────────────────────────────────
if [ "$NO_CLONE" = true ]; then
  INSTALL_DIR="${INSTALL_DIR:-$PWD}"
  step "Using current directory (--no-clone)"
  if [ ! -f "$INSTALL_DIR/package.json" ]; then
    err "No package.json found in $INSTALL_DIR. Are you in the MultiCC repo?"
    exit 1
  fi
  ok "Directory: $INSTALL_DIR"
else
  INSTALL_DIR="${INSTALL_DIR:-$PWD/MultiCC}"
  step "Preparing install directory"
  if [ -d "$INSTALL_DIR/.git" ]; then
    ok "Directory $INSTALL_DIR already exists (git repo)"
    echo "     Updating from branch $BRANCH..."
    git -C "$INSTALL_DIR" fetch origin "$BRANCH" 2>/dev/null || warn "Could not fetch — using existing checkout"
    git -C "$INSTALL_DIR" checkout "$BRANCH" 2>/dev/null || true
    git -C "$INSTALL_DIR" pull origin "$BRANCH" 2>/dev/null || warn "Could not pull — using existing checkout"
  elif [ -d "$INSTALL_DIR" ]; then
    warn "Directory $INSTALL_DIR exists but is not a git repo"
    echo "     Remove it or use --dir to pick another path."
    exit 1
  else
    info "Cloning $REPO_URL (branch: $BRANCH)..."
    if git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR" 2>&1; then
      ok "Clone complete"
    else
      err "Clone failed. Check your internet connection and the repo URL."
      exit 1
    fi
  fi
fi

cd "$INSTALL_DIR"

# ── Install dependencies ──────────────────────────────────────────────────
step "Installing npm dependencies"
info "Running npm install (full package.json; no devDependencies are required today, but this avoids omitting future runtime install hooks)"
if npm install 2>&1; then
  ok "Dependencies installed"
else
  err "npm install failed."
  echo ""
  echo "  Common causes:"
  echo "    - Network or npm registry connectivity issues"
  echo "    - Disk space or permission problems"
  echo "    - node-pty prebuild not available for your platform (rare; falls back to compilation)"
  echo ""
  if [ "$IS_MACOS" = true ]; then
    echo "  If it's a native compilation error, install build tools:"
    echo "    xcode-select --install"
  elif [ "$IS_LINUX" = true ]; then
    echo "  If it's a native compilation error, install build tools:"
    echo "    sudo apt-get update && sudo apt-get install -y build-essential python3 make g++"
  fi
  echo ""
  echo "  Diagnostic workaround:"
  echo "    npm install --ignore-scripts"
  echo "  better-sqlite3 is installed on-demand when you use the cc-switch import)"
  exit 1
fi

# ── Setup .env ────────────────────────────────────────────────────────────
step "Configuring access token"

if [ -n "$ACCESS_TOKEN" ]; then
  # Token provided via --token
  true
elif [ -f .env ] && grep -q '^ACCESS_TOKEN=' .env 2>/dev/null; then
  ACCESS_TOKEN="$(grep '^ACCESS_TOKEN=' .env | head -1 | cut -d= -f2-)"
  if [ -z "$ACCESS_TOKEN" ]; then
    ACCESS_TOKEN="$(gen_token)"
  else
    info "Reusing existing ACCESS_TOKEN from .env"
  fi
else
  ACCESS_TOKEN="$(gen_token)"
fi

if [ -z "$ACCESS_TOKEN" ]; then
  ACCESS_TOKEN="multicc-$(date +%s)"
  warn "Could not generate random token; using fallback"
fi

if [ -f .env ]; then
  set_env_var "ACCESS_TOKEN" "$ACCESS_TOKEN" .env
  set_env_var "PORT" "$PORT" .env
else
  cat > .env << EOF
# MultiCC configuration
ACCESS_TOKEN=$ACCESS_TOKEN
# Server port
PORT=$PORT
EOF
fi
# .env holds the access token (a secret); keep it owner-only.
chmod 600 .env 2>/dev/null || warn "Could not chmod 600 .env — review its permissions manually"
ok "ACCESS_TOKEN configured"
ok "PORT set to $PORT"

# ── Make manager script executable ────────────────────────────────────────
chmod +x multicc 2>/dev/null || true

# ── Install as background service ─────────────────────────────────────────
if [ "$NO_SERVICE" = false ]; then
  step "Background service"

  if [ "$IS_MACOS" = true ]; then
    echo ""
    echo "  ${C_BOLD}Install as a launchd service?${C_RESET}"
    echo "  This auto-starts MultiCC on login and restarts on crash."
    echo ""
    read -r -p "  ${C_YELLOW}>>${C_RESET} Install? [Y/n] " REPLY </dev/tty || REPLY="y"
    if [ "${REPLY:-y}" = "y" ] || [ "${REPLY:-y}" = "Y" ] || [ -z "${REPLY:-}" ]; then
      ./multicc install
      ok "Service installed — MultiCC will start automatically on login"
    else
      info "Skipped. Run './multicc install' later to set up auto-start."
    fi
  else
    info "Linux detected — set up a systemd user service manually:"
    echo ""
    echo "  mkdir -p ~/.config/systemd/user"
    echo "  cat > ~/.config/systemd/user/multicc.service <<'UNIT'"
    echo "  [Unit]"
    echo "  Description=MultiCC Server"
    echo "  After=network.target"
    echo "  [Service]"
    echo "  ExecStart=$(which node) $PWD/server.js"
    echo "  WorkingDirectory=$PWD"
    echo "  Restart=always"
    echo "  RestartSec=5"
    echo "  [Install]"
    echo "  WantedBy=default.target"
    echo "  UNIT"
    echo "  systemctl --user daemon-reload"
    echo "  systemctl --user enable --now multicc"
    echo ""
  fi
else
  info "Skipping service install (--no-service)"
fi

# ── Done ──────────────────────────────────────────────────────────────────
# Detect LAN IP for the access URL
LAN_IP=""
if command -v ip >/dev/null 2>&1; then
  LAN_IP="$(ip -4 addr show scope global 2>/dev/null | grep inet | head -1 | awk '{print $2}' | cut -d/ -f1)"
elif command -v ifconfig >/dev/null 2>&1; then
  LAN_IP="$(ifconfig 2>/dev/null | grep 'inet ' | grep -v 127.0.0.1 | head -1 | awk '{print $2}')"
fi
[ -z "$LAN_IP" ] && LAN_IP="<your-lan-ip>"

echo ""
echo "${C_BOLD}${C_GREEN}╔══════════════════════════════════════════════════════╗${C_RESET}"
echo "${C_BOLD}${C_GREEN}║${C_RESET}  ${C_BOLD}Installation Complete!${C_RESET}"
echo "${C_BOLD}${C_GREEN}╚══════════════════════════════════════════════════════╝${C_RESET}"
echo ""
echo "  ${C_BOLD}Start the server:${C_RESET}"
echo "    cd $INSTALL_DIR && node server.js"
echo ""
echo "  ${C_BOLD}Or use the service manager:${C_RESET}"
echo "    cd $INSTALL_DIR && ./multicc start"
echo ""
echo "  ${C_BOLD}Access URLs:${C_RESET}"
echo "    Local:      ${C_CYAN}http://localhost:${PORT}${C_RESET}"
echo "    LAN:        ${C_CYAN}http://${LAN_IP}:${PORT}${C_RESET}"
echo "    Chat:       ${C_CYAN}http://localhost:${PORT}/chat${C_RESET}"
echo "    Dashboard:  ${C_CYAN}http://localhost:${PORT}/manage${C_RESET}"
echo ""
echo "  ${C_BOLD}Access Token:${C_RESET}  ${C_YELLOW}${ACCESS_TOKEN}${C_RESET}"
echo "  (Other devices append ?token=${ACCESS_TOKEN} to the URL)"
echo ""

if [ "$NO_SERVICE" = true ]; then
  echo "  ${C_YELLOW}Run later to install as background service:${C_RESET}"
  echo "    cd $INSTALL_DIR && ./multicc install"
  echo ""
fi

echo "  ${C_BOLD}More commands:${C_RESET}"
echo "    ./multicc status          # check if running"
echo "    ./multicc log             # tail live logs"
echo "    ./multicc restart         # restart server"
echo "    ./multicc uninstall       # remove auto-start"
echo ""
ok "Happy building!"
echo ""
