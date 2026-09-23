#!/bin/bash
# ============================================================================
# MultiCC — One-Click Installer (standalone package)
# ============================================================================
# MultiCC version  2.0.7
# Release channel  stable — see https://github.com/lsjwzh/MultiCC/releases
# ============================================================================
# Usage — stable release, no flags needed:
#   curl -sSL https://raw.githubusercontent.com/lsjwzh/MultiCC/v2.0.7/install.sh | bash
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
#   --version <v>       Release to install: v2.0.7 (default) or "latest"
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
INSTALLER_VERSION="2.0.7"

# ── Parse flags ──────────────────────────────────────────────────────────
INSTALL_DIR=""
ACCESS_TOKEN=""
PORT="3000"
NO_SERVICE=false
NO_START=false
NO_OPEN=false
VERSION=""
FROM=""

# Guard value-taking flags: under `set -u`, referencing $2 when a flag is the
# last argument aborts with an unhelpful "$2: unbound variable". Fail cleanly.
need_val() { [ "$2" -ge 2 ] || { err "Option $1 requires a value (use --help)"; exit 1; }; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)       need_val "$1" "$#"; INSTALL_DIR="$2"; shift 2 ;;
    --token)     need_val "$1" "$#"; ACCESS_TOKEN="$2"; shift 2 ;;
    --port)      need_val "$1" "$#"; PORT="$2"; shift 2 ;;
    --version|-V) need_val "$1" "$#"; VERSION="$2"; shift 2 ;;
    --from)      need_val "$1" "$#"; FROM="$2"; shift 2 ;;
    --no-service) NO_SERVICE=true; shift ;;
    --no-start)   NO_START=true; NO_SERVICE=true; shift ;;
    --no-open)    NO_OPEN=true; shift ;;
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
  --no-service        Skip the start-on-login setup
  --no-start          Install and configure only; do not start MultiCC
  --no-open           Start MultiCC but do not open a browser
  --help              Show this help

The normal path starts MultiCC and opens the browser before this script exits.

After install:
  cd ~/MultiCC && ./multicc status           # show the running version and URL
  cd ~/MultiCC && ./multicc service install  # start automatically on login
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

if [ -e "$INSTALL_DIR" ] && [ ! -d "$INSTALL_DIR" ]; then
  err "$INSTALL_DIR exists and is not a directory."
  exit 1
fi
if [ -d "$INSTALL_DIR" ] && ! is_multicc_install "$INSTALL_DIR"; then
  if [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
    err "$INSTALL_DIR already exists and does not look like a MultiCC installation."
    echo "       Nothing was deleted. Pick another location with --dir, or move that directory away."
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
if [ -d "$INSTALL_DIR" ] && is_multicc_install "$INSTALL_DIR"; then
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
  if [ -n "$OLD_DIR" ] && [ -d "$OLD_DIR" ]; then
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

if [ -n "$ACCESS_TOKEN" ]; then
  "${MULTICC_CMD[@]}" config set ACCESS_TOKEN "$ACCESS_TOKEN" >/dev/null && ok "ACCESS_TOKEN saved"
elif EXISTING_TOKEN="$("${MULTICC_CMD[@]}" config get ACCESS_TOKEN 2>/dev/null)" && [ -n "$EXISTING_TOKEN" ]; then
  ACCESS_TOKEN="$EXISTING_TOKEN"
  info "Keeping the existing ACCESS_TOKEN"
else
  ACCESS_TOKEN="$(gen_token)"
  [ -n "$ACCESS_TOKEN" ] || ACCESS_TOKEN="multicc-$(date +%s)"
  "${MULTICC_CMD[@]}" config set ACCESS_TOKEN "$ACCESS_TOKEN" >/dev/null && ok "ACCESS_TOKEN generated"
fi
"${MULTICC_CMD[@]}" config set PORT "$PORT" >/dev/null && ok "PORT set to $PORT"

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
