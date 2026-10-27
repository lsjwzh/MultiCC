#!/bin/sh
# MultiCC — install a self-contained git on macOS without the Command Line Tools
#
#   curl -fsSL https://raw.githubusercontent.com/lsjwzh/MultiCC/main/install-git.sh | sh
#
# Why this exists: /usr/bin/git on macOS is only a Command Line Tools shim. Until
# the tools (≈1-2 GB, an Apple dialog, a long wait) are installed, every call
# pops an install prompt and fails. MultiCC ships its own Node runtime, so git is
# the only thing it still needs from the tools — and git alone does not need
# them. This installs the portable git that GitHub Desktop bundles
# (github.com/desktop/dugite-native): prebuilt, linked only against system
# libraries, no sudo, nothing outside the install directory.
#
# Layout (default ~/.multicc/git):
#   dist/     the unpacked dugite-native release
#   bin/git   a wrapper — the release is built with prefix "/", so on its own it
#             looks for its helpers in //libexec/git-core and every https remote
#             fails. The wrapper points GIT_EXEC_PATH / GIT_TEMPLATE_DIR at dist/.
#
# The MultiCC server puts <dir>/bin on its own PATH at startup
# (src/portable-git.js); add it to your shell's PATH to use this git yourself.
set -eu

DUGITE_TAG="v2.56.0-2"
DUGITE_ASSET_PREFIX="dugite-native-v2.56.0-a44aeca-macOS"
SHA256_ARM64="1110de343de11cc6f469b782b60f36217b9199b5e06875dd65baa26dd60563c7"
SHA256_X64="52cc663281e1ec2f1d76ba781193ca4847e62dbbf767f6c99ec9ec5b978a7659"
# A mirror of the GitHub release directory may be given for networks where
# github.com downloads crawl; the pinned checksums still apply.
BASE_URL="${MULTICC_GIT_MIRROR:-https://github.com/desktop/dugite-native/releases/download/${DUGITE_TAG}}"

DIR="${MULTICC_PORTABLE_GIT_DIR:-${HOME}/.multicc/git}"
ARCHIVE=""
FORCE=false

usage() {
  cat << EOF
Install a portable git for MultiCC (macOS, no Command Line Tools needed).

Usage: install-git.sh [--dir <path>] [--force]
  --dir <path>      Install directory (default: ~/.multicc/git)
  --force           Reinstall even when this version is already present
  --archive <file>  Use a local release archive instead of downloading
                    (checksum is still verified for the pinned release)
Environment:
  MULTICC_GIT_MIRROR  Base URL to download the release assets from
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) [ $# -ge 2 ] || { echo "--dir needs a value" >&2; exit 2; }; DIR="$2"; shift 2 ;;
    --archive) [ $# -ge 2 ] || { echo "--archive needs a value" >&2; exit 2; }; ARCHIVE="$2"; shift 2 ;;
    --force) FORCE=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "[install-git] $*"; }
die() { printf '%s\n' "[install-git] error: $*" >&2; exit 1; }

if [ "$(uname -s)" != "Darwin" ]; then
  die "this installer is for macOS. On Linux install git with your package manager (e.g. sudo apt install git)."
fi
case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64; SHA256="$SHA256_ARM64" ;;
  x86_64) ARCH=x64; SHA256="$SHA256_X64" ;;
  *) die "unsupported CPU: $(uname -m)" ;;
esac
# A Rosetta shell reports x86_64 on Apple silicon; the native build is better.
if [ "$ARCH" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  ARCH=arm64; SHA256="$SHA256_ARM64"
fi
ASSET="${DUGITE_ASSET_PREFIX}-${ARCH}.tar.gz"

# Already there and working: nothing to do. The marker names the release, so a
# newer installer replaces an older git instead of keeping it forever.
if [ "$FORCE" = false ] && [ -x "$DIR/bin/git" ] \
  && [ "$(cat "$DIR/.release" 2>/dev/null || true)" = "${DUGITE_TAG}-${ARCH}" ] \
  && "$DIR/bin/git" --version >/dev/null 2>&1; then
  say "already installed: $("$DIR/bin/git" --version) at $DIR"
  exit 0
fi

mkdir -p "$(dirname "$DIR")"
# Stage next to the target so the final swap is a same-filesystem rename, and a
# failed download never leaves a half-unpacked git where a working one was.
STAGE="$(mktemp -d "${DIR}.installing.XXXXXX")"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT INT TERM

if [ -n "$ARCHIVE" ]; then
  cp "$ARCHIVE" "$STAGE/git.tar.gz"
else
  say "downloading git ${DUGITE_TAG} (${ARCH}, ~65 MB)…"
  curl -fL --progress-bar --retry 3 --retry-delay 2 --connect-timeout 20 \
    -o "$STAGE/git.tar.gz" "${BASE_URL}/${ASSET}" \
    || die "download failed: ${BASE_URL}/${ASSET}"
fi

ACTUAL="$(shasum -a 256 "$STAGE/git.tar.gz" | awk '{print $1}')"
if [ "${MULTICC_GIT_SKIP_VERIFY:-}" != 1 ] && [ "$ACTUAL" != "$SHA256" ]; then
  die "checksum mismatch for ${ASSET}: expected ${SHA256}, got ${ACTUAL}"
fi

mkdir -p "$STAGE/root/dist" "$STAGE/root/bin"
tar -xzf "$STAGE/git.tar.gz" -C "$STAGE/root/dist" || die "could not unpack ${ASSET}"
[ -x "$STAGE/root/dist/bin/git" ] || die "${ASSET} does not contain bin/git"

# The wrapper resolves dist/ relative to itself, so the directory can be moved
# (or reached through a symlink to bin/git) without reinstalling.
cat > "$STAGE/root/bin/git" << 'WRAPPER'
#!/bin/sh
# MultiCC portable git (install-git.sh). Points git at its own helpers and
# templates; the bundled build otherwise looks for them under //libexec.
self="$0"
while [ -L "$self" ]; do
  link="$(readlink "$self")"
  case "$link" in /*) self="$link" ;; *) self="$(dirname "$self")/$link" ;; esac
done
root="$(cd "$(dirname "$self")/../dist" && pwd -P)"
GIT_EXEC_PATH="$root/libexec/git-core"
GIT_TEMPLATE_DIR="$root/share/git-core/templates"
export GIT_EXEC_PATH GIT_TEMPLATE_DIR
exec "$root/bin/git" "$@"
WRAPPER
chmod 755 "$STAGE/root/bin/git"
printf '%s\n' "${DUGITE_TAG}-${ARCH}" > "$STAGE/root/.release"

VERSION="$("$STAGE/root/bin/git" --version 2>&1)" || die "the unpacked git does not run: $VERSION"

# Swap: keep the previous install until the new one is in place.
if [ -e "$DIR" ]; then
  mv "$DIR" "$STAGE/previous"
fi
if ! mv "$STAGE/root" "$DIR"; then
  [ -e "$STAGE/previous" ] && mv "$STAGE/previous" "$DIR"
  die "could not move the new git into $DIR"
fi

say "installed ${VERSION} at $DIR"
say "MultiCC picks it up automatically. To use it in your own terminal, add:"
say "  export PATH=\"$DIR/bin:\$PATH\""
