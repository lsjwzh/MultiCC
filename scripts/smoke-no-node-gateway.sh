#!/bin/sh
# Smoke-test a multicc-gateway binary in `--no-node` mode: the front door must
# come up with no Node runtime anywhere on its PATH, answer a Rust-owned route,
# refuse a route it would have forwarded to Node with 503 node_runtime_absent,
# and stop with exit code 0 on SIGTERM.
#
# Usage: scripts/smoke-no-node-gateway.sh <multicc-gateway binary>
#
# POSIX sh. No Node and no Python are required: an HTTP probe uses curl when it
# exists and otherwise falls back to bash's /dev/tcp.
set -eu

fail() {
    printf 'smoke-no-node-gateway: %s\n' "$*" >&2
    exit 1
}

if [ "$#" -ne 1 ]; then
    printf 'usage: %s <multicc-gateway binary>\n' "$0" >&2
    exit 2
fi

GATEWAY=$1
case "$GATEWAY" in
    */*) ;;
    *) GATEWAY=./$GATEWAY ;;
esac
[ -x "$GATEWAY" ] || fail "$GATEWAY is not an executable file"

tmp=$(mktemp -d "${TMPDIR:-/tmp}/multicc-no-node-smoke.XXXXXX")
pid=
cleanup() {
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2> /dev/null; then
        kill -TERM "$pid" 2> /dev/null || true
        wait "$pid" 2> /dev/null || true
    fi
    rm -rf "$tmp"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$tmp/cwd" "$tmp/home" "$tmp/path"
# The front door derives its package root from <cwd>/server.js; nothing runs it.
: > "$tmp/cwd/server.js"
: > "$tmp/stdout"
: > "$tmp/stderr"

# Nothing named node may be reachable from the isolated PATH. `sh` is invoked
# by absolute path so this check fails only because node is absent, not because
# the whole PATH is empty.
sh_bin=$(command -v sh)
[ -n "$sh_bin" ] || fail "cannot locate sh to run the isolated PATH check"
if env -i PATH="$tmp/path" "$sh_bin" -c 'command -v node' > /dev/null 2>&1; then
    fail "the isolated PATH unexpectedly resolves a node executable"
fi

# MULTICC_GATEWAY_TEST_ROUTES=1 registers the documented Rust-owned probe route
# so this smoke has a route that needs neither Node nor the host port.
env -i PATH="$tmp/path" HOME="$tmp/home" TMPDIR="$tmp" \
    MULTICC_GATEWAY_TEST_ROUTES=1 \
    "$GATEWAY" serve --cwd "$tmp/cwd" --no-node --ephemeral-loopback \
    > "$tmp/stdout" 2> "$tmp/stderr" &
pid=$!

port=
tries=0
while [ "$tries" -lt 400 ]; do
    if ! kill -0 "$pid" 2> /dev/null; then
        cat "$tmp/stderr" >&2 || true
        fail "gateway exited before it reported a listening port"
    fi
    port=$(sed -n 's/.*listening on 127\.0\.0\.1:\([0-9][0-9]*\).*/\1/p' "$tmp/stderr" | head -n 1)
    [ -n "$port" ] && break
    tries=$((tries + 1))
    sleep 0.05
done
[ -n "$port" ] || fail "no listening port in the gateway log"

grep -q 'node runtime disabled (--no-node)' "$tmp/stderr" \
    || fail "missing the --no-node log line"

# http <path>: prints the status code, leaves the response body in $tmp/body.
http() {
    path=$1
    : > "$tmp/body"
    if command -v curl > /dev/null 2>&1; then
        curl -sS --max-time 10 -o "$tmp/body" -w '%{http_code}' \
            "http://127.0.0.1:$port$path"
        return
    fi
    command -v bash > /dev/null 2>&1 \
        || fail "neither curl nor bash is available for the HTTP probe"
    bash -c '
        port=$1; path=$2; out=$3
        exec 3<>"/dev/tcp/127.0.0.1/$port" || exit 1
        printf "GET %s HTTP/1.1\r\nHost: 127.0.0.1:%s\r\nConnection: close\r\n\r\n" \
            "$path" "$port" >&3
        cat <&3 > "$out.raw"
        exec 3<&-
        exec 3>&-
        awk "NR==1 { print \$2 }" "$out.raw"
        sed "1,/^.$/d" "$out.raw" > "$out"
    ' sh "$port" "$path" "$tmp/body"
}

status=$(http /__gateway_test/native)
[ "$status" = 200 ] || fail "Rust-owned route answered $status, expected 200"
grep -q 'multicc-gateway: answered by the rust front door' "$tmp/body" \
    || fail "Rust-owned route body was not the Rust answer"

status=$(http /api/not-owned-by-rust)
[ "$status" = 503 ] || fail "Node-owned route answered $status, expected 503"
grep -q 'node_runtime_absent' "$tmp/body" \
    || fail "Node-owned route body is not node_runtime_absent"
grep -q 'started without (--no-node)' "$tmp/body" \
    || fail "Node-owned route body is not the documented text"

# A real native claim still needs the authentication snapshot, and that state
# is held by the Node child, so it refuses with the same code but its own text.
status=$(http /api/claude/models)
[ "$status" = 503 ] || fail "claimed auth route answered $status, expected 503"
grep -q 'node_runtime_absent' "$tmp/body" \
    || fail "claimed auth route body is not node_runtime_absent"
grep -q 'Authentication state is held by the Node runtime' "$tmp/body" \
    || fail "claimed auth route body does not name the missing auth state"

kill -TERM "$pid"
code=0
if wait "$pid"; then
    code=0
else
    code=$?
fi
pid=
[ "$code" -eq 0 ] || fail "SIGTERM exit code was $code, expected 0"

printf '%s\n' \
    "smoke-no-node-gateway: PASS" \
    "  binary:          $GATEWAY" \
    "  isolated PATH:   $tmp/path (no node)" \
    "  listening:       127.0.0.1:$port" \
    "  rust route:      200 /__gateway_test/native" \
    "  auth route:      503 node_runtime_absent /api/claude/models (auth state lives in Node)" \
    "  node route:      503 node_runtime_absent /api/not-owned-by-rust" \
    "  SIGTERM:         exit 0"
