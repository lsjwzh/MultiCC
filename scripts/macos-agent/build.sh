#!/bin/sh
# Compile MultiCCAgent.swift into one (optionally universal) binary.
#
#   build.sh OUT [ARCH...]      ARCH = arm64 | x86_64 (default: this Mac's)
#
# Used by install-agent.sh (host arch, on the user's Mac) and by the release
# build (arm64 + x86_64, so the package ships a binary and users need no
# Xcode command line tools).
#
# Deployment target macOS 11 (Big Sur) is the floor; newer systems get newer
# code paths chosen at run time (see "Platform tiers" in the source). Newer
# frameworks are weak-linked so the one binary still launches on 11, and only
# when this SDK has them (an older SDK compiles those blocks out).
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/MultiCCAgent.swift"
OUT="${1:?usage: build.sh OUT [ARCH...]}"
shift
[ $# -gt 0 ] || set -- "$(uname -m)"

# `xcrun` on a Mac without the command line tools opens the "install developer
# tools" dialog instead of failing; ask xcode-select first.
xcode-select -p >/dev/null 2>&1 || { echo "build.sh: Xcode command line tools not installed" >&2; exit 3; }

SDK="$(xcrun --show-sdk-path 2>/dev/null || true)"
WEAK=""
for fw in ScreenCaptureKit; do
  [ -d "$SDK/System/Library/Frameworks/$fw.framework" ] && WEAK="$WEAK -Xlinker -weak_framework -Xlinker $fw"
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/multicc-agent-build.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
SLICES=""
for arch in "$@"; do
  case "$arch" in arm64|x86_64) ;; *) echo "build.sh: unsupported arch $arch" >&2; exit 2 ;; esac
  # shellcheck disable=SC2086
  xcrun swiftc -O -target "$arch-apple-macos11.0" $WEAK -o "$WORK/$arch" "$SRC"
  SLICES="$SLICES $WORK/$arch"
done
# shellcheck disable=SC2086
if [ $# -eq 1 ]; then cp "$WORK/$1" "$OUT"; else lipo -create $SLICES -output "$OUT"; fi
chmod 0755 "$OUT"
