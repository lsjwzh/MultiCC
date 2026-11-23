#!/bin/sh
# Assemble a fresh service directory from a completed Cargo build.
set -eu
dest=${1:?usage: stage-rust-runtime.sh NEW_DIRECTORY [CARGO_RELEASE_DIRECTORY]}
bins=${2:-native/target/release}
version=$(sed -n 's/^  "version": "\([0-9][0-9A-Za-z.+-]*\)",.*$/\1/p' package.json)
test -n "$version"
mkdir "$dest"
trap 'rm -rf -- "$dest"' EXIT
trap 'exit 1' HUP INT TERM
mkdir "$dest/bin"
suffix=
if [ -f "$bins/multicc-gateway.exe" ]; then suffix=.exe; fi
for bin in multicc-gateway multicc-writer restart-supervisor multicc-cdpd multicc-remote; do
    install -m 755 "$bins/$bin$suffix" "$dest/bin/$bin$suffix"
done
cp -R public "$dest/public"
# noVNC uses browser ESM. Its upstream npm manifest is only for development.
rm -f "$dest/public/vendor/novnc/package.json"
for ui in plugins/*/ui plugins/*/public; do
    [ -d "$ui" ] || continue
    mkdir -p "$dest/${ui%/*}"
    cp -R "$ui" "$dest/$ui"
done
printf '{"version":"%s"}\n' "$version" > "$dest/multicc-release.json"
unexpected=$(find "$dest" \( -name package.json -o -name node_modules -o -name '*.node' \
    -o -name node -o -name node.exe -o -name npm -o -name npm.cmd \) -print)
if [ -n "$unexpected" ]; then
    printf 'Unexpected Node runtime files in service directory:\n%s\n' "$unexpected" >&2
    exit 1
fi
trap - EXIT HUP INT TERM
