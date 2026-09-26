#!/bin/bash
# ============================================================================
# MultiCC — One-Click Installer (standalone package)
# ============================================================================
# MultiCC version  2.1.3
# Release channel  stable — see https://github.com/lsjwzh/MultiCC/releases
# ============================================================================
# Usage — stable release, no flags needed:
#   curl -sSL https://raw.githubusercontent.com/lsjwzh/MultiCC/v2.1.3/install.sh | bash
#
# Usage — newest release instead of this pinned one:
#   curl -sSL https://raw.githubusercontent.com/lsjwzh/MultiCC/main/install.sh | bash -s -- --version latest
#
# Or download and run it locally:
#   chmod +x install.sh && ./install.sh
#
# You do NOT need Node, npm, git, Homebrew or Xcode to run this script: it only downloads
# the standalone package for your platform, verifies its checksum and unpacks
# it; the package carries its own Node runtime and its own dependencies. The
# only tools it needs are curl (or wget), tar and a SHA-256 utility.
# MultiCC itself does need a working git at runtime (one worktree per session);
# this script checks for it at the end and prints how to install it.
#
# Options:
#   --dir <path>        Install into this directory (default: ~/MultiCC)
#   --version <v>       Release to install: v2.1.3 (default) or "latest"
#   --token <xxx>       Pre-set ACCESS_TOKEN (default: auto-generate)
#   --port <port>       Server port (default: 3000)
#   --from <path|url>   Install from a local archive/directory or URL instead
#                       of GitHub Releases (offline / air-gapped installs)
#   --no-service        Skip the start-on-login setup
#   --no-start          Install and configure only; do not start MultiCC
#   --no-open           Start MultiCC but do not open a browser
#   --help              Show this help
#
# The normal path starts MultiCC and opens the browser before this script exits.
# After install:
#   cd ~/MultiCC && ./multicc status  # show the running version and URL
#   cd ~/MultiCC && ./multicc service install  # start automatically on login
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

# MultiCC version — keep in sync with package.json when cutting a release
INSTALLER_VERSION="2.1.3"

# ── Parse flags ──────────────────────────────────────────────────────────
INSTALL_DIR=""
ACCESS_TOKEN=""
PORT="3000"
PORT_GIVEN=false
ASSUME_YES=false
NO_SERVICE=false
NO_START=false
NO_OPEN=false
COPY_LEGACY_DATA=true
ADOPT_DATA_FROM=""
VERSION=""
FROM=""

# Guard value-taking flags: under `set -u`, referencing $2 when a flag is the
# last argument aborts with an unhelpful "$2: unbound variable". Fail cleanly.
need_val() { [ "$2" -ge 2 ] || { err "Option $1 requires a value (use --help)"; exit 1; }; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)       need_val "$1" "$#"; INSTALL_DIR="$2"; shift 2 ;;
    --token)     need_val "$1" "$#"; ACCESS_TOKEN="$2"; shift 2 ;;
    --port)      need_val "$1" "$#"; PORT="$2"; PORT_GIVEN=true; shift 2 ;;
    --version|-V) need_val "$1" "$#"; VERSION="$2"; shift 2 ;;
    --from)      need_val "$1" "$#"; FROM="$2"; shift 2 ;;
    --yes|-y)     ASSUME_YES=true; shift ;;
    --no-service) NO_SERVICE=true; shift ;;
    --no-start)   NO_START=true; NO_SERVICE=true; shift ;;
    --no-open)    NO_OPEN=true; shift ;;
    --no-data)    COPY_LEGACY_DATA=false; shift ;;
    --adopt-data) need_val "$1" "$#"; ADOPT_DATA_FROM="$2"; shift 2 ;;
    --no-apk)     warn "--no-apk is no longer needed; APK builds are always on demand"; shift ;;
    # `--branch` and `--no-clone` belonged to the old git-clone installer. They
    # are kept as compatibility shims so an older published command line still
    # installs the same release instead of failing with "unknown option".
    --branch)    need_val "$1" "$#"; VERSION="$2"; shift 2 ;;
    --no-clone)  FROM="$PWD"; shift ;;
    --help|-h)
      cat << HELP
MultiCC — One-Click Installer  v${INSTALLER_VERSION} (standalone package)

Usage — stable release, no flags needed:
  curl -sSL https://raw.githubusercontent.com/lsjwzh/MultiCC/v${INSTALLER_VERSION}/install.sh | bash

Usage — newest release instead of this pinned one:
  curl -sSL https://raw.githubusercontent.com/lsjwzh/MultiCC/main/install.sh | bash -s -- --version latest

Or download and run it locally:
  chmod +x install.sh && ./install.sh

No Node, npm, git, Homebrew or Xcode required to install: the standalone
package ships its own runtime. MultiCC does need a working git to run;
the installer checks and tells you how to get it.

Options:
  --dir <path>        Install into this directory (default: ~/MultiCC)
  --version <v>       Release to install: v${INSTALLER_VERSION} (default) or "latest"
  --token <xxx>       Pre-set ACCESS_TOKEN (default: auto-generate)
  --port <port>       Server port (default: 3000)
  --from <path|url>   Install from a local archive/directory or URL instead of GitHub
  --yes               Upgrade an older installation without asking first
  --no-data           Keep an older installation's data in the backup instead of
                      bringing it across
  --adopt-data <path> Bring the data of an older installation at <path> across
                      (see "Upgrading from an older installation" below)
  --no-service        Skip the start-on-login setup
  --no-start          Install and configure only; do not start MultiCC
  --no-open           Start MultiCC but do not open a browser
  --help              Show this help

The normal path starts MultiCC and opens the browser before this script exits.

After install:
  cd ~/MultiCC && ./multicc status           # show the running version and URL
  cd ~/MultiCC && ./multicc service install  # start automatically on login

Upgrading from an older installation:
  An installation from before the standalone package is upgraded in place when it
  is the directory being installed into: it is stopped, kept as a backup (never
  deleted), and its settings and data come across.
  If it is somewhere else — the oldest installers put MultiCC wherever they were
  run from, and this one installs to ~/MultiCC — it is reported and left exactly
  as it is, and its data can be brought across as a copy with:
    --adopt-data <path>
HELP
      exit 0
      ;;
    *) err "Unknown option: $1 (use --help)"; exit 1 ;;
  esac
done

RELEASES_URL="https://github.com/lsjwzh/MultiCC/releases"
API_LATEST="https://api.github.com/repos/lsjwzh/MultiCC/releases/latest"

# Validate --port early so we never write a non-numeric PORT into the config.
case "$PORT" in
  ''|*[!0-9]*) err "Invalid --port: '$PORT' (must be a number, e.g. 3000)"; exit 1 ;;
esac

banner() {
  local channel_label
  case "$VERSION" in
    ""|"${INSTALLER_VERSION}"|"v${INSTALLER_VERSION}") channel_label="stable v${INSTALLER_VERSION}" ;;
    latest) channel_label="newest release" ;;
    *) channel_label="release v${VERSION#v}" ;;
  esac
  echo ""
  echo "${C_BOLD}${C_MAGENTA}╔══════════════════════════════════════════════════════╗${C_RESET}"
  echo "${C_BOLD}${C_MAGENTA}║${C_RESET}  MultiCC — One-Click Installer  (${channel_label})"
  echo "${C_BOLD}${C_MAGENTA}║${C_RESET}  Multi-Client Claude Code — drive one Claude Code CLI"
  echo "${C_BOLD}${C_MAGENTA}║${C_RESET}  from browser, phone, or WeChat, all at once."
  echo "${C_BOLD}${C_MAGENTA}╚══════════════════════════════════════════════════════╝${C_RESET}"
  echo ""
}

# ── Tooling ───────────────────────────────────────────────────────────────
# The whole point of the standalone package is that the target machine needs
# nothing installed. These are the last few tools that come with the OS.
require_tool() {
  local cmd="$1" hint="$2"
  command -v "$cmd" >/dev/null 2>&1 || { err "$cmd is required. $hint"; exit 1; }
}

DOWNLOADER=""
if command -v curl >/dev/null 2>&1; then
  DOWNLOADER="curl"
elif command -v wget >/dev/null 2>&1; then
  DOWNLOADER="wget"
fi

# Same download with either tool; -f/--fail turns an HTTP 404 into a failure
# instead of a saved HTML error page that would later fail extraction.
download() {
  local url="$1" dest="$2"
  if [ "$DOWNLOADER" = "curl" ]; then
    curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 -o "$dest" "$url"
  elif [ "$DOWNLOADER" = "wget" ]; then
    wget -O "$dest" "$url"
  else
    err "curl or wget is required to download MultiCC."
    echo "       Install curl (macOS/Linux ship it), or download the package by hand:"
    echo "       ${RELEASES_URL}"
    exit 1
  fi
}

# Prints the SHA-256 of a file, or nothing when no utility is available.
sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  else
    printf ''
  fi
}

banner

# ── Detect platform and architecture ──────────────────────────────────────
step "Checking environment"
OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM="darwin"; ok "macOS detected" ;;
  Linux)
    PLATFORM="linux"
    ok "Linux detected"
    if grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null; then
      info "WSL detected — the Linux package is installed; browser/audio/service behavior may differ"
    fi
    ;;
  MINGW*|MSYS*|CYGWIN*) PLATFORM="win32"; ok "Windows (Git Bash / MSYS) detected" ;;
  *) err "Unsupported OS: $OS"; echo "       Download a package by hand: ${RELEASES_URL}"; exit 1 ;;
esac

MACHINE="$(uname -m)"
case "$MACHINE" in
  x86_64|amd64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) err "Unsupported CPU architecture: $MACHINE"; echo "       Download a package by hand: ${RELEASES_URL}"; exit 1 ;;
esac
ok "Architecture: ${ARCH}"

# ── Resolve which release to install ──────────────────────────────────────
step "Resolving release"

# The GitHub API is only needed for `--version latest`; the common path is a
# plain URL whose tag we already know.
if [ "$VERSION" = "latest" ]; then
  if [ "$DOWNLOADER" = "" ]; then
    err "--version latest needs curl or wget."
    exit 1
  fi
  TMP_JSON="$(mktemp "${TMPDIR:-/tmp}/multicc-release.XXXXXX")"
  if download "$API_LATEST" "$TMP_JSON" 2>/dev/null; then
    VERSION="$(sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$TMP_JSON" | head -1)"
  fi
  rm -f "$TMP_JSON"
  [ -n "$VERSION" ] || { err "Could not determine the newest release (GitHub API unreachable or rate-limited)."; echo "       Install a specific version instead: --version v${INSTALLER_VERSION}"; exit 1; }
  info "Newest release: $VERSION"
elif [ -z "$VERSION" ]; then
  VERSION="v${INSTALLER_VERSION}"
elif [ "${VERSION#v}" = "$VERSION" ]; then
  VERSION="v${VERSION}"
fi

# Everything below (asset names, config defaults) uses the bare version number.
VERSION_NUMBER="${VERSION#v}"
case "$VERSION_NUMBER" in
  ''|*[!0-9.]*) err "Invalid --version: '$VERSION' (expected e.g. v${INSTALLER_VERSION} or latest)"; exit 1 ;;
esac

if [ "$PLATFORM" = "win32" ]; then
  ARCHIVE_NAME="multicc-standalone-${VERSION_NUMBER}-${PLATFORM}-${ARCH}.zip"
else
  ARCHIVE_NAME="multicc-standalone-${VERSION_NUMBER}-${PLATFORM}-${ARCH}.tar.gz"
fi
ok "MultiCC ${VERSION_NUMBER} (${PLATFORM}-${ARCH})"

# ── Install directory ─────────────────────────────────────────────────────
# A curl-piped installer inherits whichever directory the terminal happened to
# be in. Installing there is surprising and, on macOS, can put the bundle in a
# TCC-protected Downloads/Desktop directory. Use a stable per-user path instead;
# --dir remains available for operators who want another location.
INSTALL_DIR="${INSTALL_DIR:-${HOME:-$PWD}/MultiCC}"
PARENT_DIR="$(dirname "$INSTALL_DIR")"
mkdir -p "$PARENT_DIR"
INSTALL_DIR="$(cd "$PARENT_DIR" && pwd)/$(basename "$INSTALL_DIR")"
PARENT_DIR="$(dirname "$INSTALL_DIR")"

# The bundle's own command, plus the two spellings we show the user. `multicc`
# is a shell script; on Windows (Git Bash / MSYS) the wrapper is a .cmd, so the
# bundled runtime and CLI are invoked directly instead. Both routes reach the
# same code and the same config file.
MULTICC_BIN="$INSTALL_DIR/multicc"
if [ "$PLATFORM" = "win32" ]; then
  MULTICC_CMD=("$INSTALL_DIR/Resources/runtime/node.exe" "$INSTALL_DIR/Resources/launcher/standalone-cli.js")
  CMD_NAME="multicc.cmd"
else
  MULTICC_CMD=("$MULTICC_BIN")
  CMD_NAME="./multicc"
fi
START_CMD="$CMD_NAME start"

# Anything we create on the way out: the staging area and, during a replace,
# the previous installation. Never the install directory itself.
STAGE_DIR=""
OLD_DIR=""
cleanup() {
  [ -n "$STAGE_DIR" ] && [ -d "$STAGE_DIR" ] && rm -rf "$STAGE_DIR" 2>/dev/null
  return 0
}
trap cleanup EXIT

is_multicc_install() {
  # A source checkout also has a root `multicc` command. Treating that single
  # filename as an installed bundle would let the default ~/MultiCC path replace
  # a developer's repository. Require the platform's shipped manifest + runtime.
  case "$PLATFORM" in
    darwin)
      [ -f "$1/multicc" ] \
        && [ -f "$1/MultiCC.app/Contents/Resources/bundle-manifest.json" ] \
        && [ -f "$1/MultiCC.app/Contents/Resources/runtime/bin/node" ]
      ;;
    win32)
      [ -f "$1/multicc.cmd" ] \
        && [ -f "$1/Resources/bundle-manifest.json" ] \
        && [ -f "$1/Resources/runtime/node.exe" ]
      ;;
    *)
      [ -f "$1/multicc" ] \
        && [ -f "$1/Resources/bundle-manifest.json" ] \
        && [ -f "$1/Resources/runtime/bin/node" ]
      ;;
  esac
}

# ── Installations from before the standalone package ──────────────────────
# The guard below used to reject every one of these outright, and that is a
# real trap: each of them WAS a valid MultiCC installation, put there by a
# published installer, and its own launcher said so. Three shapes exist in the
# wild, all of them installed by something the user was told to run:
#   * a source checkout — the old installer placed the repository itself at the
#     install path and installed its dependencies there, so the directory IS
#     the project: root `multicc`, package.json, node_modules, and (when the
#     installer wrote it) a .env still holding the ACCESS_TOKEN in use;
#   * a hand-unpacked portable release — MultiCC.app or Resources/ carrying the
#     shipped manifest, but no root launcher, which only came with the later
#     bundle layout;
#   * a bundle that was unpacked, trimmed or left half-installed — launcher and
#     its own runtime, with no manifest at all.
# What every one of them lacks is the full triple is_multicc_install() wants.
#
# Being generous here would undo the protection that function was deliberately
# tightened for (a developer's checkout must not be replaced by the default
# ~/MultiCC path). So identity is checked, not just file names: MultiCC's own
# package.json, a manifest that only a shipped bundle carries, or the app /
# runtime layout no unrelated project would have. A directory holding a file
# that merely happens to be called `multicc` still gets the old refusal.
has_multicc_manifest() {
  [ -f "$1/MultiCC.app/Contents/Resources/bundle-manifest.json" ] \
    || [ -f "$1/Resources/bundle-manifest.json" ]
}

is_legacy_multicc_install() {
  [ -d "$1" ] || return 1
  is_multicc_install "$1" && return 1
  # A shipped bundle, in a layout older than the one today's check describes.
  has_multicc_manifest "$1" && return 0
  { [ -f "$1/multicc" ] || [ -f "$1/multicc.cmd" ]; } || return 1
  if [ -f "$1/package.json" ] \
    && grep -qE '"name"[[:space:]]*:[[:space:]]*"multicc"' "$1/package.json" 2>/dev/null; then
    return 0
  fi
  [ -d "$1/MultiCC.app" ] || [ -d "$1/Resources/runtime" ]
}

# ── An older installation that is somewhere else entirely ─────────────────
# Not every old installation is at the path this run installs into. The oldest
# installer put MultiCC wherever it happened to be run from — $PWD/MultiCC by
# default, $PWD itself with --no-clone — while this release installs to
# ~/MultiCC, so an installation that predates the standalone package is
# routinely somewhere else on the machine. Two things remember where: the login
# service it registered, which still names the directory it starts from, and the
# directory this run was started in. Both are only candidates — each still has
# to pass the same identity check as an old installation at the target path, so
# a directory that merely looks similar is never touched.

# The directory the machine's own login service starts MultiCC from, if one is
# registered. That service is the strongest evidence available: it is the OS
# saying "MultiCC is installed here".
legacy_service_dir() {
  local plist unit dir=""
  case "$PLATFORM" in
    darwin)
      plist="$HOME/Library/LaunchAgents/com.multicc.server.plist"
      [ -f "$plist" ] || return 1
      # ProgramArguments carries "<node> <dir>/server.js"; the directory in
      # front of server.js is the installation the login job starts.
      dir="$(sed -n 's:.*<string>\([^<]*\)/server\.js</string>.*:\1:p' "$plist" 2>/dev/null | head -1)"
      ;;
    linux)
      unit="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/multicc.service"
      [ -f "$unit" ] || return 1
      # ExecStart=<node> [flags] <dir>/server.js — the directory is the last
      # word before the script, whatever runtime or flags come first.
      dir="$(sed -n 's/^[[:space:]]*ExecStart=.*[[:space:]]\(\/[^[:space:]]*\)\/server\.js.*/\1/p' "$unit" 2>/dev/null | head -1)"
      ;;
    *) return 1 ;;
  esac
  [ -n "$dir" ] || return 1
  printf '%s' "$dir"
}

# Candidate directories, most trustworthy first. Paths may contain spaces, so
# this is read one line at a time rather than split into words.
legacy_elsewhere_candidates() {
  local dir
  dir="$(legacy_service_dir || true)"
  [ -n "$dir" ] && printf '%s\n' "$dir"
  printf '%s\n' "$PWD/MultiCC" "$PWD"
  return 0
}

# The first candidate that really is a pre-standalone installation. Sets
# LEGACY_ELSEWHERE (empty when there is none) instead of printing, so the loop
# runs in this shell and the answer survives it.
LEGACY_ELSEWHERE=""
detect_legacy_elsewhere() {
  local install_dir="$1" candidate
  LEGACY_ELSEWHERE=""
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    candidate="$(cd "$candidate" 2>/dev/null && pwd)" || continue
    [ "$candidate" = "$install_dir" ] && continue
    is_legacy_multicc_install "$candidate" || continue
    LEGACY_ELSEWHERE="$candidate"
    break
  done < <(legacy_elsewhere_candidates)
  return 0
}

# Whether that installation is running right now, from the pid file its own
# launcher kept. A running installation is still writing the files a copy would
# read, so it is worth saying out loud before offering one.
legacy_install_running() {
  local pid_file="$1/.multicc.pid" pid
  [ -f "$pid_file" ] || return 1
  pid="$(tr -dc '0-9' < "$pid_file" 2>/dev/null | head -1)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null
}

# Values the old installation was configured with. Filled in by
# prepare_legacy_upgrade() and applied after the new package is in place, so a
# user coming from an old install keeps the token their phone/bookmarks and the
# port they reach it on. The old installer wrote these into the install
# directory's own .env (data and configuration moved to the per-user data
# directory later), so that file is the only place left to read them from.
LEGACY_DIR=""
LEGACY_ENV_FILE=""
LEGACY_TOKEN=""
LEGACY_PORT=""
# Whether the old installation's data is copied into the new data directory.
# Starts from the --no-data flag and can still be declined at the prompt.
LEGACY_DATA_COPY="$COPY_LEGACY_DATA"
# Set when a real old installation's data was deliberately left in the backup,
# so the summary can say where it is and where it would have to go.
LEGACY_DATA_LEFT_BEHIND=false

# An older installation that is NOT the directory this run installs into. It is
# never moved, stopped, renamed or written to: the only thing taken from it is a
# copy of the data, and only when the user asked for it (--adopt-data) or said
# yes to the question. ADOPT_EXPLICIT records which of the two it was, because
# the answer changes what may happen without a terminal to ask on.
ADOPT_DIR=""
ADOPT_COPY="$COPY_LEGACY_DATA"
ADOPT_EXPLICIT=false
ADOPT_DATA_LEFT_BEHIND=false

read_legacy_env() {
  local env_file="$1/.env"
  LEGACY_ENV_FILE="$env_file"
  [ -f "$env_file" ] || return 0
  LEGACY_TOKEN="$(grep -E '^ACCESS_TOKEN=' "$env_file" 2>/dev/null | head -1 | cut -d= -f2- || true)"
  LEGACY_PORT="$(grep -E '^PORT=' "$env_file" 2>/dev/null | head -1 | cut -d= -f2- || true)"
}

# Every state artifact a pre-standalone installation kept in its own directory.
# The names come from src/paths.js: for those releases the data root WAS the
# package root, so this is what sat next to the code. Listing them one by one
# instead of copying the directory wholesale is deliberate — the same directory
# also held the source checkout, node_modules, .git and the bundle itself, and
# none of that is data. Anything not on this list is either rebuilt on demand
# (caches, the search index) or already lived outside the install directory:
# detached jobs, voice runtimes and sample workspaces went to ~/.multicc even
# then (src/paths.js detachedDir/voiceRuntimesDir/sampleWorkspacesDir), which is
# why they keep working across this upgrade untouched.
legacy_data_items() {
  printf '%s\n' \
    sessions.json directories.json .journal chat_history \
    aux_runs events bridges artifacts \
    notes.json token_usage.json token_daily.json token_by_role.json \
    providers.json shares.json fleet-shares.json external-fleets.json \
    push_subscriptions.json push_notification_receipts.json \
    tunnel-config.json tunnel-repair-ledger.json aux-config.json goal-config.json \
    provider-defaults.json provider-relay-shares.json \
    provider-limit-cache.db provider-limit-cache.json quota-bar-cache.json \
    scheduled_tasks.json cron_fanout_migration.json docs_registry.json secrets.json \
    task_board.json task-runs.sqlite task-shells.sqlite search-index.sqlite \
    task-short-codes.json ui-layout.json air-pins.json \
    orchestration.sqlite orchestration.json voice_examples.json whisper_vocab.json \
    memories
}

# True when the old installation actually has any of it, so a user who upgraded
# from a fresh checkout is never asked about data that does not exist.
legacy_data_present() {
  local item
  for item in $(legacy_data_items); do
    [ -e "$1/$item" ] && return 0
  done
  return 1
}

# Size in KB, for telling the user what they are about to copy. Integer shell
# arithmetic only: awk is not guaranteed to be here (the checksum step already
# warns when it is missing) and this must not become a new hard dependency.
legacy_data_size() {
  local item size total=0
  for item in $(legacy_data_items); do
    [ -e "$1/$item" ] || continue
    size="$(du -sk "$1/$item" 2>/dev/null | awk '{print $1}' 2>/dev/null || true)"
    case "$size" in ''|*[!0-9]*) continue ;; esac
    total=$((total + size))
  done
  printf '%s' "$total"
}

human_size() {
  if [ "$1" -ge 1048576 ]; then
    printf '%s GB' "$(( $1 / 1048576 ))"
  elif [ "$1" -ge 1024 ]; then
    printf '%s MB' "$(( $1 / 1024 ))"
  else
    printf '%s KB' "$1"
  fi
}

# Something to say about an older installation that is not the one being
# replaced, and — when the user is there to say yes — consent to copy its data.
#
# It is never started, stopped, renamed or written to. What it does give up is
# the login service: the label (com.multicc.server) is the same one this release
# installs, so installing the service takes the old installation's place at
# login. It keeps running until then and can still be started by hand.
#
# The copy is offered, never assumed. With no terminal to ask on (the documented
# `curl … | bash`) a directory the user did not name is reported and left alone,
# with the one flag that includes it printed — `--yes` still counts as an answer
# because it is the same default the question offers.
prepare_adopt() {
  local dir="$1" answer="" data_kb
  [ -n "$dir" ] || return 0
  [ -d "$dir" ] || return 0
  if ! legacy_data_present "$dir"; then
    info "Another MultiCC installation is on this machine, at $dir (it holds no data)"
    ADOPT_COPY=false
    return 0
  fi

  data_kb="$(legacy_data_size "$dir")"
  echo ""
  echo "  ${C_BOLD}Another MultiCC installation is on this machine:${C_RESET}"
  echo "    $dir"
  echo "  It is not the directory being installed into, so nothing in it is changed."
  echo "  It holds about $(human_size "$data_kb") of data: sessions, chat history, the"
  echo "  task boards, memories and provider settings. Its own token and port are not"
  echo "  taken — what data is copied, nothing else; this installation is configured"
  echo "  on its own."
  if legacy_install_running "$dir"; then
    echo "  ${C_YELLOW}It also looks like it is still running${C_RESET} — it keeps writing those files,"
    echo "  so a copy taken now is a snapshot of this moment; stop it first for a clean one."
  fi

  # Named on the command line: the user has already decided.
  if [ "$ADOPT_EXPLICIT" = true ]; then
    if [ "$ADOPT_COPY" = false ]; then
      ADOPT_DATA_LEFT_BEHIND=true
      warn "Both --adopt-data and --no-data were given — nothing was copied."
      return 0
    fi
    ok "Bringing your data across from $dir"
    return 0
  fi

  if [ "$ADOPT_COPY" = false ]; then
    ADOPT_DATA_LEFT_BEHIND=true
    echo "  Its data stays where it is (--no-data). Include it later with:"
    echo "    ${C_CYAN}--adopt-data '$dir'${C_RESET}"
    return 0
  fi
  if [ "$ASSUME_YES" = true ]; then
    ok "Bringing your data across from $dir"
    return 0
  fi
  if [ -r /dev/tty ]; then
    echo "  Copy it into this installation, so your history is here? The original stays"
    echo "  where it is, as a second MultiCC you can keep or delete afterwards."
    # No answer is not a yes. `[ -r /dev/tty ]` only inspects the device node's
    # permissions, so it is true on a machine with no controlling terminal too,
    # where the read fails at once — and this default is the one no one chose.
    # An empty answer still means "yes": that is the enter key.
    read -r -p "  ${C_YELLOW}>>${C_RESET} Bring it across? [Y/n] " answer </dev/tty || answer="__no_terminal__"
    case "${answer:-y}" in
      y|Y|"")
        ok "Bringing your data across from $dir"
        return 0
        ;;
      __no_terminal__)
        ADOPT_COPY=false
        ADOPT_DATA_LEFT_BEHIND=true
        ;;
      *)
        ADOPT_COPY=false
        ADOPT_DATA_LEFT_BEHIND=true
        info "Left where it is — this installation starts without it"
        echo "       Include it later with: --adopt-data '$dir'"
        return 0
        ;;
    esac
  fi
  ADOPT_COPY=false
  ADOPT_DATA_LEFT_BEHIND=true
  echo "  Nothing was copied: this installation starts without it. To include it, re-run"
  echo "  with:"
  echo "    ${C_CYAN}--adopt-data '$dir'${C_RESET}"
  return 0
}

# The data directory the standalone launcher hands the server is
# `<userData>/data`, where userData is whatever directory the CLI keeps
# multicc.env in (desktop/lib/desktop-env.js: dataRoot = join(userData, 'data')).
# Asking the CLI keeps this correct on every platform instead of re-deriving it
# from ~/Library/Application Support here.
legacy_data_target() {
  local env_file
  env_file="$("${MULTICC_CMD[@]}" config path 2>/dev/null || true)"
  [ -n "$env_file" ] || return 1
  printf '%s/data' "$(dirname "$env_file")"
}

# Copy the old data out of the backup into the new data directory. The source is
# read, never written, and the destination is only ever an empty directory: if
# something is already in there it is either a second MultiCC or a first run of
# the new server, and both are newer than the source. The source directory is
# passed in so the same code serves both an installation that was replaced and
# one that is being left where it is.
bring_legacy_data_across() {
  local src="$1" target item copied=0 failed=0
  [ -n "$src" ] || return 0
  [ -d "$src" ] || return 0

  if ! target="$(legacy_data_target)"; then
    warn "Could not work out where this release keeps its data; nothing was copied."
    echo "       Your data is untouched in $src."
    return 0
  fi
  if [ -d "$target" ] && [ -n "$(ls -A "$target" 2>/dev/null)" ]; then
    warn "This release already has data of its own — nothing was copied."
    echo "       $target"
    echo "       Your old data is untouched in $src."
    return 0
  fi
  if ! mkdir -p "$target" 2>/dev/null; then
    warn "Could not create $target; nothing was copied."
    echo "       Your data is untouched in $src."
    return 0
  fi

  for item in $(legacy_data_items); do
    [ -e "$src/$item" ] || continue
    [ -e "$target/$item" ] && continue
    if cp -Rp "$src/$item" "$target/$item" 2>/dev/null; then
      copied=$((copied + 1))
    else
      failed=$((failed + 1))
      warn "Could not copy $item"
    fi
  done

  if [ "$copied" -eq 0 ] && [ "$failed" -eq 0 ]; then
    rmdir "$target" 2>/dev/null || true
    info "No data from the previous installation needed bringing across"
    return 0
  fi
  ok "Brought your data across: $copied item(s) into $target"
  if [ "$failed" -gt 0 ]; then
    warn "$failed item(s) could not be copied and are still only in $src."
  fi
  echo "       Sessions, chat history, tasks and memories are read from there now."
  echo "       The backup keeps its own copy — nothing was moved or deleted, so it is"
  echo "       safe to delete $src once the new installation looks right."
  return 0
}

# Stop a pre-standalone installation and take its directory out of the way,
# without ever deleting it. Called only after the new package has been
# downloaded and verified, so a failed download leaves the old install alone.
prepare_legacy_upgrade() {
  local dir="$1" stamp answer=""
  stamp="$(date +%Y%m%d%H%M%S)"
  LEGACY_DIR="$dir.legacy-$stamp"

  read_legacy_env "$dir"
  if [ -n "$LEGACY_TOKEN" ]; then
    info "Found the ACCESS_TOKEN of your previous installation — it will be kept"
  fi

  # Ask before touching a directory we did not create. The old installers ran
  # from a git checkout, and someone who deliberately cloned MultiCC into this
  # path should not have it renamed out from under them without a word. Without
  # a terminal (the documented `curl … | bash` path) there is nobody to ask, and
  # the move is reversible anyway: the directory is renamed, never removed.
  if [ "$ASSUME_YES" = false ] && [ -r /dev/tty ]; then
    echo ""
    echo "  ${C_BOLD}An older MultiCC installation was found at:${C_RESET}"
    echo "    $dir"
    echo "  It will be stopped and kept as:"
    echo "    $LEGACY_DIR"
    echo "  Nothing is deleted — your data, sessions and chat history are untouched."
    read -r -p "  ${C_YELLOW}>>${C_RESET} Upgrade it in place? [Y/n] " answer </dev/tty || answer=""
    case "${answer:-y}" in
      y|Y|"") ;;
      *)
        err "Upgrade cancelled. Nothing was changed."
        echo "       Install somewhere else with --dir, or move that directory away yourself."
        exit 1
        ;;
    esac
  fi

  # 1. Take the old login service out first. Its label (com.multicc.server) is
  #    the same one the standalone package installs, and it points at this
  #    directory: leave it loaded and it will keep trying to start a launcher
  #    that has been renamed away, while the new service fights it for the port.
  #    `uninstall` is the old script's own command: it unloads the login job and
  #    stops the server. Running it is best-effort — that launcher is a shell
  #    script that wants a system Node runtime, which may be long gone by now —
  #    so a failure falls through to a direct launchctl unload. Neither path may
  #    abort the upgrade: a leftover process is something the next `multicc
  #    stop` can still deal with, a half-moved installation is not.
  local stopped=false
  if [ -x "$dir/multicc" ]; then
    if (cd "$dir" && ./multicc uninstall) >/dev/null 2>&1; then
      stopped=true
      ok "Stopped the previous installation and removed its auto-start service"
    fi
  fi
  if [ "$stopped" = false ]; then
    # The old login job has to go whatever else happens: it points at this
    # directory, and KeepAlive means launchd would keep restarting a launcher
    # that is about to be renamed away.
    if [ "$PLATFORM" = "darwin" ]; then
      local plist="$HOME/Library/LaunchAgents/com.multicc.server.plist"
      if [ -f "$plist" ]; then
        launchctl unload "$plist" 2>/dev/null || true
        rm -f "$plist"
        info "Removed the previous auto-start service"
      fi
    elif [ "$PLATFORM" = "linux" ]; then
      # The old installer never wrote this unit, it printed one for the user to
      # paste — so it is removed only when it is really there, and the user is
      # told, because they may have written it by hand.
      local unit="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/multicc.service"
      if [ -f "$unit" ]; then
        systemctl --user disable --now multicc >/dev/null 2>&1 || true
        rm -f "$unit"
        info "Removed the previous auto-start service"
      fi
    fi
    if [ -x "$dir/multicc" ]; then
      (cd "$dir" && ./multicc stop) >/dev/null 2>&1 && ok "Stopped the previous installation" || true
    fi
  fi

  # 2. Move it aside. `mv` on the same filesystem is atomic and cheap even for
  #    a source checkout with node_modules in it, and it keeps every byte of the
  #    old configuration recoverable if something about the new package is not
  #    wanted after all.
  if ! mv "$dir" "$LEGACY_DIR"; then
    err "Could not move the previous installation out of the way."
    echo "       Move $dir away yourself and re-run the installer."
    exit 1
  fi
  ok "Previous installation kept at $LEGACY_DIR"
  if [ -n "$LEGACY_TOKEN" ]; then
    echo "       Its settings were read from $LEGACY_DIR/.env and are being reused."
  fi
  if [ "$stopped" = false ]; then
    warn "Could not stop the previous instance automatically."
    echo "       If it is still running it holds the old port, and the new installation will"
    echo "       come up on the next free one — check 'multicc status' before pointing anyone at it."
  fi

  # The old releases kept their data inside the install directory: sessions,
  # chat history, tasks and memories all lived next to the code. This release
  # reads them from a per-user data directory instead, so without an explicit
  # copy the upgrade starts empty even though every byte is still on disk. The
  # copy itself happens later, once the new package is in place and before the
  # server has run for the first time — here we only find out how much there is
  # and let the user opt out.
  if ! legacy_data_present "$LEGACY_DIR"; then
    LEGACY_DATA_COPY=false
  elif [ "$LEGACY_DATA_COPY" = true ]; then
    local data_kb
    data_kb="$(legacy_data_size "$LEGACY_DIR")"
    if [ "$ASSUME_YES" = false ] && [ -r /dev/tty ]; then
      echo ""
      echo "  Your previous installation also holds about $(human_size "$data_kb") of data:"
      echo "  sessions, chat history, the task boards, memories and provider settings."
      echo "  It stays in the backup either way; bringing it across means the new"
      echo "  installation starts with your history instead of empty."
      read -r -p "  ${C_YELLOW}>>${C_RESET} Bring it across? [Y/n] " answer </dev/tty || answer=""
      case "${answer:-y}" in
        y|Y|"") ;;
        *) LEGACY_DATA_COPY=false ;;
      esac
    fi
  fi
  if [ "$LEGACY_DATA_COPY" = false ] && legacy_data_present "$LEGACY_DIR"; then
    LEGACY_DATA_LEFT_BEHIND=true
    warn "Your data stays in the backup: $LEGACY_DIR"
    echo "       This release reads a per-user data directory, so it starts empty."
    echo "       Nothing was deleted — every session and every byte is still in there,"
    echo "       and whatever should be used can still be copied by hand: the rest of"
    echo "       this run prints exactly which directory to copy it into."
  fi
  return 0
}

if [ -e "$INSTALL_DIR" ] && [ ! -d "$INSTALL_DIR" ]; then
  err "$INSTALL_DIR exists and is not a directory."
  exit 1
fi
LEGACY_PENDING=false
if [ -d "$INSTALL_DIR" ] && ! is_multicc_install "$INSTALL_DIR"; then
  if is_legacy_multicc_install "$INSTALL_DIR"; then
    LEGACY_PENDING=true
  elif [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
    err "$INSTALL_DIR already exists and does not look like a MultiCC installation."
    echo "       Nothing was deleted. Pick another location with --dir, or move that directory away."
    exit 1
  fi
fi
if [ "$LEGACY_PENDING" = true ]; then
  info "An older MultiCC installation was found at $INSTALL_DIR"
  echo "       It predates the standalone package. It will be stopped and kept as a"
  echo "       backup next to the new installation; nothing in it is deleted."
fi

# Whether this run replaces an installation that is already here. An upgrade in
# place already has whatever history matters; only a first install goes looking
# for a second installation elsewhere on the machine (see the data step below).
TARGET_HAD_INSTALL=false
if [ "$LEGACY_PENDING" = false ] && [ -d "$INSTALL_DIR" ] && is_multicc_install "$INSTALL_DIR"; then
  TARGET_HAD_INSTALL=true
fi

# --adopt-data: an old installation the user named. Checked here, before
# anything is downloaded, so a wrong path costs nothing.
if [ -n "$ADOPT_DATA_FROM" ]; then
  if [ "$LEGACY_PENDING" = true ]; then
    warn "--adopt-data was ignored: $INSTALL_DIR is itself an older installation,"
    echo "       and it is that installation's data which is being brought across."
  elif [ -d "$ADOPT_DATA_FROM" ] && is_legacy_multicc_install "$ADOPT_DATA_FROM"; then
    ADOPT_DIR="$(cd "$ADOPT_DATA_FROM" && pwd)"
    ADOPT_EXPLICIT=true
    info "Using the data of the older installation at $ADOPT_DIR"
  else
    err "--adopt-data: not a pre-standalone MultiCC installation: $ADOPT_DATA_FROM"
    echo "       Point it at a directory that is one — its own multicc launcher and"
    echo "       package.json are what identify it."
    exit 1
  fi
fi

# The staging area must share a filesystem with the install directory: it is
# what makes the final step a rename instead of a 100 MB copy.
STAGE_DIR="$PARENT_DIR/.multicc-installing-$$"
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"

# ── Obtain the package ────────────────────────────────────────────────────
step "Downloading the standalone package"

ARCHIVE="$STAGE_DIR/$ARCHIVE_NAME"
CHECKSUM_FILE=""
VERIFY=true

if [ -n "$FROM" ]; then
  case "$FROM" in
    *.tar.gz|*.tgz|*.zip)
      if [ -f "$FROM" ]; then
        info "Using local package: $FROM"
        cp "$FROM" "$ARCHIVE"
        ARCHIVE_NAME="$(basename "$FROM")"
        # A local file has no published sidecar to check against.
        [ -f "$FROM.sha256" ] && CHECKSUM_FILE="$FROM.sha256"
        [ -n "$CHECKSUM_FILE" ] || VERIFY=false
      elif echo "$FROM" | grep -qE '^https?://'; then
        info "Downloading package: $FROM"
        download "$FROM" "$ARCHIVE"
        VERIFY=false
      else
        err "--from: no such file: $FROM"
        exit 1
      fi
      ;;
    *)
      if [ -d "$FROM" ]; then
        info "Using local package directory: $FROM"
        ARCHIVE=""
        VERIFY=false
      else
        err "--from must be an existing .tar.gz/.zip file, a directory, or an http(s) URL"
        exit 1
      fi
      ;;
  esac
else
  URL="${RELEASES_URL}/download/${VERSION}/${ARCHIVE_NAME}"
  info "From: ${URL}"
  if ! download "$URL" "$ARCHIVE"; then
    err "Download failed."
    echo ""
    echo "  Things to check:"
    echo "    - Is this release published with assets for ${PLATFORM}-${ARCH}?"
    echo "      ${RELEASES_URL}/tag/${VERSION}"
    echo "    - Network/proxy access to github.com."
    echo "    - Or install a package you downloaded by hand: ./install.sh --from <file>"
    exit 1
  fi
  ok "Downloaded $ARCHIVE_NAME ($(du -h "$ARCHIVE" 2>/dev/null | awk '{print $1}'))"
  # The published sidecar is the whole reason a download is trustworthy; a
  # release without it is a broken release, not a soft warning.
  if download "${URL}.sha256" "$STAGE_DIR/${ARCHIVE_NAME}.sha256" 2>/dev/null; then
    CHECKSUM_FILE="$STAGE_DIR/${ARCHIVE_NAME}.sha256"
  else
    err "The release has no ${ARCHIVE_NAME}.sha256 sidecar — refusing to install an unverifiable package."
    echo "       Report it at ${RELEASES_URL}, or install a local package with --from."
    exit 1
  fi
fi

# ── Verify and unpack ─────────────────────────────────────────────────────
if [ "$VERIFY" = true ] && [ -n "$CHECKSUM_FILE" ]; then
  step "Verifying the download"
  EXPECTED="$(awk 'NR==1{print $1}' "$CHECKSUM_FILE")"
  ACTUAL="$(sha256_of "$ARCHIVE")"
  if [ -z "$ACTUAL" ]; then
    warn "No shasum/sha256sum/openssl found — skipping checksum verification"
  elif [ "$ACTUAL" != "$EXPECTED" ]; then
    err "Checksum mismatch — the download is corrupt or tampered with."
    echo "       expected: $EXPECTED"
    echo "       actual:   $ACTUAL"
    exit 1
  else
    ok "Checksum verified ($ACTUAL)"
  fi
fi

step "Unpacking"
UNPACK_DIR="$STAGE_DIR/unpacked"
mkdir -p "$UNPACK_DIR"
if [ -n "$ARCHIVE" ]; then
  case "$ARCHIVE_NAME" in
    *.zip)
      if command -v unzip >/dev/null 2>&1; then
        unzip -q -o "$ARCHIVE" -d "$UNPACK_DIR"
      elif command -v powershell >/dev/null 2>&1; then
        powershell -NoProfile -NonInteractive -Command \
          "Expand-Archive -LiteralPath '$(cygpath -w "$ARCHIVE" 2>/dev/null || echo "$ARCHIVE")' -DestinationPath '$(cygpath -w "$UNPACK_DIR" 2>/dev/null || echo "$UNPACK_DIR")' -Force"
      else
        err "unzip is required to unpack $ARCHIVE_NAME"
        exit 1
      fi
      # The archive carries the bundle's own top-level directory; shed it so the
      # install directory is the bundle root and not a bundle inside a bundle.
      ENTRY_COUNT="$(find "$UNPACK_DIR" -mindepth 1 -maxdepth 1 -exec printf x \; | wc -c | tr -d ' ')"
      if [ "$ENTRY_COUNT" = "1" ]; then
        INNER="$(find "$UNPACK_DIR" -mindepth 1 -maxdepth 1 -print -quit)"
        if [ -d "$INNER" ]; then
          for entry in "$INNER"/* "$INNER"/.[!.]*; do
            [ -e "$entry" ] || continue
            mv "$entry" "$UNPACK_DIR/"
          done
          rmdir "$INNER" 2>/dev/null || true
        fi
      fi
      ;;
    *)
      require_tool tar "It ships with macOS and Linux."
      tar -xzf "$ARCHIVE" -C "$UNPACK_DIR" --strip-components=1
      ;;
  esac
else
  # --from <directory>: copy it, following no links out of it.
  (cd "$FROM" && tar -cf - .) | (cd "$UNPACK_DIR" && tar -xf -)
fi

# Refuse to install something that is not a complete MultiCC bundle — a
# truncated download would otherwise only fail later, at `multicc start`.
case "$PLATFORM" in
  darwin) RUNTIME_REL="MultiCC.app/Contents/Resources/runtime/bin/node" ;;
  win32)  RUNTIME_REL="Resources/runtime/node.exe" ;;
  *)      RUNTIME_REL="Resources/runtime/bin/node" ;;
esac
if [ ! -f "$UNPACK_DIR/$RUNTIME_REL" ] || { [ ! -f "$UNPACK_DIR/multicc" ] && [ ! -f "$UNPACK_DIR/multicc.cmd" ]; }; then
  err "The package is incomplete (missing multicc or $RUNTIME_REL)."
  echo "       Delete $STAGE_DIR and retry; if it persists, report it at ${RELEASES_URL}."
  exit 1
fi
ok "Package unpacked"

# macOS: an archive that arrived over the network hands its "downloaded" flag to
# everything inside it, and Gatekeeper then runs the bundle from a random
# read-only AppTranslocation path. Permissions granted to a process running from
# there are recorded against a path that changes on the next launch, so they can
# never stick (the visible symptom is git failing with "Operation not permitted"
# inside Desktop/Documents/Downloads no matter what the user authorizes). The
# user already chose to install this checksum-verified package, so clear the flag
# now instead of letting them debug AppTranslocation later.
if [ "$PLATFORM" = "darwin" ] && command -v xattr >/dev/null 2>&1; then
  xattr -dr com.apple.quarantine "$UNPACK_DIR" 2>/dev/null || true
  info "Removed the macOS download flag — without this, permissions you grant are forgotten on every launch"
fi

# ── Install (replace any previous version) ────────────────────────────────
step "Installing to $INSTALL_DIR"
if [ "$LEGACY_PENDING" = true ]; then
  # Reached only after the new package has been downloaded and verified, so a
  # failed download never disturbs an installation that still works.
  prepare_legacy_upgrade "$INSTALL_DIR"
elif [ -d "$INSTALL_DIR" ] && is_multicc_install "$INSTALL_DIR"; then
  info "Existing installation found — replacing it (your data is kept)"
  # A running server would keep serving from the directory we are about to
  # replace, so ask it to stop first. Failure to stop is not fatal: the new
  # files still land, the old process just has to be restarted by hand.
  if [ -x "$MULTICC_BIN" ] || [ "$PLATFORM" = "win32" ]; then
    "${MULTICC_CMD[@]}" stop >/dev/null 2>&1 && ok "Stopped the running instance" || true
  fi
  OLD_DIR="$INSTALL_DIR.old-$$"
  rm -rf "$OLD_DIR"
  mv "$INSTALL_DIR" "$OLD_DIR"
elif [ -d "$INSTALL_DIR" ]; then
  # An existing empty directory: `mv src dst` would nest the package inside it.
  rmdir "$INSTALL_DIR" 2>/dev/null || {
    err "$INSTALL_DIR is not empty and does not look like a MultiCC installation."
    exit 1
  }
fi

if ! mv "$UNPACK_DIR" "$INSTALL_DIR"; then
  err "Could not move the package into place."
  # Whatever was moved aside goes back, so a failed install never leaves someone
  # with neither the new installation nor the working old one. For a legacy
  # upgrade that means the backup stops being a backup and becomes the install
  # again — which is the right trade when the alternative is nothing at all.
  if [ -n "$LEGACY_DIR" ] && [ -d "$LEGACY_DIR" ]; then
    mv "$LEGACY_DIR" "$INSTALL_DIR" 2>/dev/null \
      && warn "Your previous installation was put back at $INSTALL_DIR."
  elif [ -n "$OLD_DIR" ] && [ -d "$OLD_DIR" ]; then
    mv "$OLD_DIR" "$INSTALL_DIR" 2>/dev/null && warn "The previous installation was restored."
  fi
  exit 1
fi
[ -n "$OLD_DIR" ] && rm -rf "$OLD_DIR"
chmod +x "$INSTALL_DIR/multicc" 2>/dev/null || true
ok "Installed MultiCC ${VERSION_NUMBER}"

# ── Check git ─────────────────────────────────────────────────────────────
# MultiCC gives every session its own git worktree, so git has to actually work
# here. The package ships its own Node runtime, but it cannot ship git. On macOS
# /usr/bin/git is only a Command Line Tools shim: it exists even when the tools
# do not, and every call then pops an install dialog and exits non-zero — which
# surfaces much later as "无法将目录初始化为 git 仓库" the first time a directory
# is added. `xcode-select -p` answers the question without triggering that
# dialog, so it is asked first and `git --version` only runs behind it.
step "Checking git"
# What is required is a working git, NOT the Command Line Tools — a git from
# Homebrew, MacPorts or git-scm.com is just as good, and nagging those users to
# install Xcode tools they do not need would be wrong. So the tools are only
# consulted when the only git on PATH is /usr/bin/git, which on macOS is the
# shim. Any other path is a real binary and can be asked for its version safely.
GIT_MISSING=false
GIT_NEEDS_CLT=false
GIT_PATH="$(command -v git 2>/dev/null || true)"
if [ -z "$GIT_PATH" ]; then
  GIT_MISSING=true
  # Written as a full `if`, not `[ ... ] && ...`: under `set -e` the && form
  # exits non-zero on every non-macOS host and would abort the installer.
  if [ "$PLATFORM" = "darwin" ]; then GIT_NEEDS_CLT=true; fi
elif [ "$PLATFORM" = "darwin" ] && [ "$GIT_PATH" = "/usr/bin/git" ] && ! xcode-select -p >/dev/null 2>&1; then
  # Only the shim is present and it has nothing behind it. Do not run it: that
  # is what pops the install dialog in the middle of an install script.
  GIT_MISSING=true
  GIT_NEEDS_CLT=true
elif ! "$GIT_PATH" --version >/dev/null 2>&1; then
  GIT_MISSING=true
fi
if [ "$GIT_MISSING" = true ]; then
  if [ "$GIT_NEEDS_CLT" = true ]; then
    warn "git does not work yet — macOS Command Line Tools are not installed."
    echo "       MultiCC needs a working git (every session gets its own worktree)."
    echo "       Fix it with one command, then confirm in the dialog it opens:"
    echo "         ${C_CYAN}xcode-select --install${C_RESET}"
    echo "       Already have Xcode? Point the tools at it instead:"
    echo "         ${C_CYAN}sudo xcode-select --switch /Applications/Xcode.app${C_RESET}"
    echo "       Any other git works too (Homebrew, git-scm.com) — the tools are"
    echo "       just the shortest route."
  elif [ "$PLATFORM" = "darwin" ]; then
    warn "git is on PATH but does not run: ${GIT_PATH}"
    echo "       MultiCC needs a working git (every session gets its own worktree)."
    echo "       Reinstall it, e.g. 'brew install git' or from https://git-scm.com."
  else
    warn "git was not found on PATH."
    echo "       MultiCC needs a working git (every session gets its own worktree)."
    echo "       Install it with your package manager, e.g. 'sudo apt install git'."
  fi
  echo "       Installation continues — MultiCC starts fine, but adding a"
  echo "       directory will fail until git works."
else
  ok "git is available"
fi

# ── Configure ─────────────────────────────────────────────────────────────
# The command is the bundle's own CLI, so the config lands wherever the CLI
# (and therefore the launcher and the server) reads it: the per-user data
# directory, never inside the package. That is what makes replacing the
# package safe.
step "Configuring"
if [ ! -x "$MULTICC_BIN" ] && [ "$PLATFORM" != "win32" ]; then
  err "The bundled multicc command is missing at $MULTICC_BIN"
  exit 1
fi

# A pre-standalone installation kept its settings in the install directory's own
# .env, and that file holds more than the token and the port: the push (VAPID)
# key pair and any ASR credentials the server generated on its first start live
# there too, and silently dropping them breaks notifications that used to work.
# So the whole file is carried across — never over one that already has content,
# which is what a second installation would be looking at.
if [ -n "$LEGACY_ENV_FILE" ] && [ -f "$LEGACY_ENV_FILE" ]; then
  TARGET_ENV="$("${MULTICC_CMD[@]}" config path 2>/dev/null || true)"
  if [ -n "$TARGET_ENV" ] && [ ! -s "$TARGET_ENV" ]; then
    mkdir -p "$(dirname "$TARGET_ENV")" 2>/dev/null || true
    if cp "$LEGACY_ENV_FILE" "$TARGET_ENV" 2>/dev/null; then
      chmod 600 "$TARGET_ENV" 2>/dev/null || true
      info "Kept the settings from your previous installation"
    fi
  fi
fi

# Order matters. An explicit --token wins; otherwise the token the previous
# (pre-standalone) installation was configured with is the one the user's
# bookmarks, phone and other devices already carry, so it is preferred over a
# token that happens to sit in the data directory already.
if [ -z "$ACCESS_TOKEN" ] && [ -n "$LEGACY_TOKEN" ]; then
  ACCESS_TOKEN="$LEGACY_TOKEN"
fi
if [ "$PORT_GIVEN" = false ] && [ -n "$LEGACY_PORT" ]; then
  PORT="$LEGACY_PORT"
fi

if [ -n "$ACCESS_TOKEN" ]; then
  "${MULTICC_CMD[@]}" config set ACCESS_TOKEN "$ACCESS_TOKEN" >/dev/null \
    && ok "ACCESS_TOKEN saved${LEGACY_TOKEN:+ (kept from the previous installation)}"
elif EXISTING_TOKEN="$("${MULTICC_CMD[@]}" config get ACCESS_TOKEN 2>/dev/null)" && [ -n "$EXISTING_TOKEN" ]; then
  ACCESS_TOKEN="$EXISTING_TOKEN"
  info "Keeping the existing ACCESS_TOKEN"
else
  ACCESS_TOKEN="$(gen_token)"
  [ -n "$ACCESS_TOKEN" ] || ACCESS_TOKEN="multicc-$(date +%s)"
  "${MULTICC_CMD[@]}" config set ACCESS_TOKEN "$ACCESS_TOKEN" >/dev/null && ok "ACCESS_TOKEN generated"
fi
"${MULTICC_CMD[@]}" config set PORT "$PORT" >/dev/null && ok "PORT set to $PORT"

# ── Bring an older installation's data across ─────────────────────────────
# Runs before the server has ever started: the destination has to be empty for
# the copy to be safe, and the first start is what makes it non-empty.
LEGACY_DATA_DEST=""
if [ "$LEGACY_PENDING" = true ]; then
  step "Bringing your data across"
  if [ "$LEGACY_DATA_COPY" = true ]; then
    bring_legacy_data_across "$LEGACY_DIR"
  else
    info "Skipped — the previous installation's data stays in $LEGACY_DIR"
  fi
else
  # Nothing was replaced here, which is not the same as there being nothing to
  # bring across: an installation from before the standalone package is usually
  # somewhere else on the machine (see detect_legacy_elsewhere). Only a first
  # install looks — an upgrade in place already has the history that matters,
  # and an installation named with --adopt-data is used whatever this is.
  if [ -z "$ADOPT_DIR" ] && [ "$TARGET_HAD_INSTALL" = false ]; then
    detect_legacy_elsewhere "$INSTALL_DIR"
    ADOPT_DIR="$LEGACY_ELSEWHERE"
  fi
  if [ -n "$ADOPT_DIR" ]; then
    prepare_adopt "$ADOPT_DIR"
    if [ "$ADOPT_COPY" = true ]; then
      step "Bringing your data across"
      bring_legacy_data_across "$ADOPT_DIR"
    fi
  fi
fi
# Resolved for the summary whatever the answer was: a "no" is only useful if the
# user leaves knowing where their history is and where it would have to go.
LEGACY_DATA_DEST="$(legacy_data_target 2>/dev/null || true)"

# ── Start on login (optional) ─────────────────────────────────────────────
if [ "$NO_SERVICE" = false ]; then
  step "Start automatically on login"
  if [ -r /dev/tty ]; then
    echo "  MultiCC can start in the background at login and restart if it crashes."
    read -r -p "  ${C_YELLOW}>>${C_RESET} Set that up now? [Y/n] " REPLY </dev/tty || REPLY="n"
    case "${REPLY:-y}" in
      y|Y|"") SERVICE_REPLY=yes ;;
      *) SERVICE_REPLY=no ;;
    esac
  else
    SERVICE_REPLY=no
    info "Not a terminal — skipping. Run '${START_CMD} service install' later to add it."
  fi
  if [ "$SERVICE_REPLY" = "yes" ]; then
    case "$PLATFORM" in
      darwin|linux|win32)
        if "${MULTICC_CMD[@]}" service install; then
          ok "Auto-start installed"
        else
          warn "Auto-start setup failed — start MultiCC with: ${START_CMD}"
        fi
        ;;
      *)
        info "Auto-start is not supported here — start MultiCC with: ${START_CMD}"
        ;;
    esac
  fi
fi

# ── Start now ─────────────────────────────────────────────────────────────
# Installation is only "one click" if the user reaches a working UI before the
# command returns. This call is safe even when service install already started
# the instance: `multicc start` reuses it and opens the existing URL.
START_OK=false
ACTUAL_URL=""
if [ "$NO_START" = false ]; then
  step "Starting MultiCC"
  START_ARGS=(start)
  [ "$NO_OPEN" = true ] && START_ARGS+=(--no-open)
  if "${MULTICC_CMD[@]}" "${START_ARGS[@]}"; then
    START_OK=true
    ACTUAL_URL="$("${MULTICC_CMD[@]}" url 2>/dev/null || true)"
    if [ "$NO_OPEN" = true ]; then
      ok "MultiCC is ready${ACTUAL_URL:+ at $ACTUAL_URL}"
    else
      ok "MultiCC is ready${ACTUAL_URL:+ at $ACTUAL_URL}; the browser has been opened"
    fi
  else
    warn "MultiCC was installed, but it did not become ready."
    echo "       Run '$CMD_NAME log -f' in $INSTALL_DIR to see the startup error."
  fi
else
  info "Installed without starting (--no-start)"
fi

# ── Done ──────────────────────────────────────────────────────────────────
echo ""
echo "${C_BOLD}${C_GREEN}╔══════════════════════════════════════════════════════╗${C_RESET}"
if [ "$NO_START" = false ] && [ "$START_OK" = false ]; then
  echo "${C_BOLD}${C_GREEN}║${C_RESET}  ${C_BOLD}Installation Complete — startup needs attention${C_RESET}"
else
  echo "${C_BOLD}${C_GREEN}║${C_RESET}  ${C_BOLD}Installation Complete!${C_RESET}"
fi
echo "${C_BOLD}${C_GREEN}╚══════════════════════════════════════════════════════╝${C_RESET}"
echo ""
if [ "$START_OK" = true ]; then
  echo "  ${C_BOLD}MultiCC is running:${C_RESET}"
  echo "    ${C_CYAN}${ACTUAL_URL:-http://localhost:${PORT}}${C_RESET}"
elif [ "$NO_START" = true ]; then
  echo "  ${C_BOLD}Start MultiCC:${C_RESET}"
  echo "    cd $INSTALL_DIR && $START_CMD"
else
  echo "  ${C_BOLD}Retry startup:${C_RESET}"
  echo "    cd $INSTALL_DIR && $START_CMD"
  echo "    cd $INSTALL_DIR && $CMD_NAME log -f"
fi
if [ "$PORT" != "3000" ]; then
  echo "    (port is taken? it moves forward automatically; 'multicc url' prints the real one)"
fi
echo ""
if [ -n "$ACCESS_TOKEN" ]; then
  echo "  ${C_BOLD}Access Token:${C_RESET}  ${C_YELLOW}${ACCESS_TOKEN}${C_RESET}"
  echo "  (Other devices on your LAN append ?token=${ACCESS_TOKEN} to the URL)"
else
  echo "  ${C_BOLD}Access Token:${C_RESET}  ${C_YELLOW}stored in the data directory${C_RESET} — see 'multicc config list'"
fi
echo "  LAN access and Tailscale Funnel are configured in /manage; nothing is exposed by default."
echo ""
echo "  ${C_BOLD}Everyday commands${C_RESET} (run them from $INSTALL_DIR):"
echo "    $CMD_NAME start      # start in the background and open the browser"
echo "    $CMD_NAME status     # is it running, and where"
echo "    $CMD_NAME log -f     # watch the logs"
echo "    $CMD_NAME stop       # stop gracefully"
echo "    $CMD_NAME update     # install the newest release (your data is untouched)"
echo "    $CMD_NAME help       # everything else"
echo ""
echo "  Sessions, providers and chat history live outside this directory,"
echo "  so replacing or updating the package never touches them."
echo ""
if [ "$LEGACY_DATA_LEFT_BEHIND" = true ]; then
  echo "  ${C_BOLD}${C_YELLOW}Your previous sessions are still in the backup${C_RESET}"
  echo "    Backup:       $LEGACY_DIR"
  echo "    This release: ${LEGACY_DATA_DEST:-<whatever the line under '$CMD_NAME config path' points at>/data}"
  echo "    To use them, stop MultiCC, copy what you want out of the backup into the"
  echo "    directory above, and start it again. Nothing was deleted."
  echo ""
fi
if [ "$ADOPT_DATA_LEFT_BEHIND" = true ] && [ -n "$ADOPT_DIR" ]; then
  echo "  ${C_BOLD}${C_YELLOW}Another MultiCC installation still holds data for you${C_RESET}"
  echo "    Old install:  $ADOPT_DIR"
  echo "    This release: ${LEGACY_DATA_DEST:-<the directory under '$CMD_NAME config path'>/data}"
  echo "    Nothing in it was changed, and it was not moved or stopped. To use that"
  echo "    data here, re-run this installer with --adopt-data '$ADOPT_DIR', or copy"
  echo "    what you want into the directory above and start MultiCC again."
  echo ""
fi
# Repeated here because the check above scrolls past behind the service prompt
# and the startup output — this is the last thing on screen, and it is the one
# thing standing between a finished install and a working first session.
if [ "$GIT_MISSING" = true ]; then
  if [ "$PLATFORM" = "darwin" ]; then
    echo "  ${C_BOLD}${C_YELLOW}One thing left: install git${C_RESET}"
    echo "    ${C_CYAN}xcode-select --install${C_RESET}"
    echo "    Until that finishes, adding a directory fails with a git error."
  else
    echo "  ${C_BOLD}${C_YELLOW}One thing left: install git${C_RESET}"
    echo "    MultiCC needs git on PATH; adding a directory fails until it is there."
  fi
  echo ""
fi
ok "Happy building!"
echo ""

# A downloaded and configured bundle that cannot boot is not a successful
# one-command install. Keep the files in place for diagnosis, but signal failure
# to automation and copy/paste installers.
if [ "$NO_START" = false ] && [ "$START_OK" = false ]; then
  exit 1
fi
