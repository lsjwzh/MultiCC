#!/bin/sh
# Start this checkout's Rust front door in `--no-node` mode: no Node child is
# spawned, Rust-owned routes answer, and every route still served by the Node
# server answers 503 node_runtime_absent. This is intentionally not the default
# entry point: the chat lane, turn worker and other unmigrated routes need
# `--node` (docs/backend-rust-exit-plan.md).
#
# Usage: scripts/start-rust-only.sh [additional multicc-gateway serve options]
#   e.g. scripts/start-rust-only.sh --stdin-lifeline
set -eu

root=$(
    CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd
)

bin=${MULTICC_GATEWAY_BIN:-$root/native/target/release/multicc-gateway}
if [ ! -x "$bin" ]; then
    cat >&2 <<EOF
start-rust-only: multicc-gateway not found at $bin
build it first:
  cargo build --locked --release --manifest-path native/Cargo.toml -p multicc-gateway
or point MULTICC_GATEWAY_BIN at an existing binary.
EOF
    exit 1
fi

exec "$bin" serve --cwd "$root" --no-node "$@"
