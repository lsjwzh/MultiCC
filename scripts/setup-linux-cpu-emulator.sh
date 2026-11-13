#!/usr/bin/env bash
set -euo pipefail

# CI-only: use an emulator that can actually execute AVX/F16C. Ubuntu 22.04's
# QEMU 6.2 masked those IvyBridge features; avoid a floating emulator version.
# Extract the Ubuntu 24.04 package without installing packages or registering
# host-wide binfmt handlers. The amd64 tonistiigi image omits qemu-x86_64.
destination="${1:?usage: setup-linux-cpu-emulator.sh ABSOLUTE_DESTINATION}"
[[ "$destination" = /* ]] || { echo 'destination must be absolute' >&2; exit 1; }
[[ "$(uname -s)-$(uname -m)" = Linux-x86_64 ]] || {
  echo 'CPU emulator setup requires Linux x64' >&2; exit 1;
}
package_url='https://archive.ubuntu.com/ubuntu/pool/universe/q/qemu/qemu-user_8.2.2+ds-0ubuntu1.18_amd64.deb'
package_sha256='9655f3e7e50af597e1b845822c47af9231f9f1bcb8c99e586db9da775d70c041'
package_dir="$(mktemp -d)"
trap 'rm -rf "$package_dir"' EXIT
mkdir -p "$destination"
curl --fail --location --silent --show-error --retry 3 --max-time 120 \
  "$package_url" --output "$package_dir/qemu-user.deb"
printf '%s  %s\n' "$package_sha256" "$package_dir/qemu-user.deb" | sha256sum --check --status
dpkg-deb --extract "$package_dir/qemu-user.deb" "$package_dir/extracted"
install -m 755 "$package_dir/extracted/usr/bin/qemu-x86_64" "$destination/qemu-x86_64"
version="$("$destination/qemu-x86_64" --version)"
[[ "$version" = 'qemu-x86_64 version 8.2.2'* ]] || {
  echo "unexpected emulator version: $version" >&2; exit 1;
}
printf '{"kind":"ubuntu-deb","version":"1:8.2.2+ds-0ubuntu1.18","url":"%s","sha256":"%s"}\n' \
  "$package_url" "$package_sha256" > "$destination/qemu-x86_64.source.json"
printf '%s\n' "$version"
sha256sum "$destination/qemu-x86_64"
