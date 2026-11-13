#!/usr/bin/env bash
set -euo pipefail

# CI-only: use an emulator that can actually execute AVX/F16C. Ubuntu 22.04's
# QEMU 6.2 masked those IvyBridge features; avoid a floating emulator version.
# Extract the static emulator from a pinned linux/amd64 image without starting
# its binfmt installer or registering any host-wide emulation handlers.
destination="${1:?usage: setup-linux-cpu-emulator.sh ABSOLUTE_DESTINATION}"
[[ "$destination" = /* ]] || { echo 'destination must be absolute' >&2; exit 1; }
[[ "$(uname -s)-$(uname -m)" = Linux-x86_64 ]] || {
  echo 'CPU emulator setup requires Linux x64' >&2; exit 1;
}
image='tonistiigi/binfmt:qemu-v9.2.2@sha256:f8110364b792daf4500535f060c2146585723e620bf8a354be23655e0c07f03d'
container=''
trap 'if [[ -n "$container" ]]; then docker rm -v "$container" >/dev/null; fi' EXIT
mkdir -p "$destination"
container="$(docker create --platform linux/amd64 "$image")"
docker cp "$container:/usr/bin/qemu-x86_64" "$destination/qemu-x86_64"
chmod 755 "$destination/qemu-x86_64"
version="$("$destination/qemu-x86_64" --version)"
[[ "$version" = 'qemu-x86_64 version 9.2.2'* ]] || {
  echo "unexpected emulator version: $version" >&2; exit 1;
}
printf '%s\n' "$image" > "$destination/qemu-x86_64.image"
printf '%s\n' "$version"
sha256sum "$destination/qemu-x86_64"
