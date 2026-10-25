#!/bin/sh
# install.sh 的冒烟测试：在一个干净的 HOME 里装 → 验 → 重装 → 卸，全程不碰真用户目录。
#
#   DISPLAY=:99 install-smoke.sh
#
# 盯的是「装好了却用不了」那一类半安装：二进制在但没执行位、自启项写坏了 Exec、
# 客户端软链没建、重装时把正在跑的旧进程留下来占着 socket。
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
[ -n "${DISPLAY:-}" ] || { echo "需要 DISPLAY" >&2; exit 2; }

T=$(mktemp -d "${TMPDIR:-/tmp}/multicc-install-smoke.XXXXXX")
export HOME="$T/home" XDG_CONFIG_HOME="$T/home/.config" XDG_RUNTIME_DIR="$T/run"
mkdir -p "$HOME" "$XDG_RUNTIME_DIR"; chmod 0700 "$XDG_RUNTIME_DIR"
BIN="$HOME/.multicc/agent/multicc-agent-linux"
LINK="$HOME/.multicc/bin/multicc-agent"
DESK="$XDG_CONFIG_HOME/autostart/multicc-agent.desktop"
cleanup() { sh "$HERE/install.sh" uninstall >/dev/null 2>&1 || true; rm -rf "$T"; }
trap cleanup EXIT INT TERM

PASS=0; FAIL=0
ok() { PASS=$((PASS + 1)); printf '  \033[32m✅\033[0m %s\n' "$1"; }
no() { FAIL=$((FAIL + 1)); printf '  \033[31m❌\033[0m %s\n' "$1"; [ -z "${2:-}" ] || printf '     实得: %s\n' "$2"; }
check() { if eval "$2"; then ok "$1"; else no "$1" "${3:-}"; fi; }

printf '\n\033[1m安装链路冒烟（HOME=%s）\033[0m\n' "$HOME"

OUT=$(sh "$HERE/install.sh" install 2>&1) || { no "install 成功退出" "$OUT"; }
check "二进制装好且可执行" '[ -x "$BIN" ]'
check "客户端软链指向二进制" '[ "$(readlink "$LINK")" = "$BIN" ]'
check "装完立刻在跑（ping 通）" '"$LINK" ping >/dev/null 2>&1' "$OUT"
check "自启项存在" '[ -f "$DESK" ]'
check "自启项的 Exec 指向装好的二进制" 'grep -q "^Exec=.*$BIN" "$DESK"' "$(cat "$DESK" 2>/dev/null)"
# 自启项的 Exec 要能真的跑起来：照着它的写法手动执行一遍（先停掉 install 拉起的那个）。
EXEC=$(sed -n 's/^Exec=//p' "$DESK")
pkill -f "^$BIN serve" 2>/dev/null || true; sleep 0.3
sh -c "$EXEC" & sleep 0.6
check "按自启项的 Exec 能拉起 agent" '"$LINK" ping >/dev/null 2>&1'
check "status 报与当前源码一致" 'sh "$HERE/install.sh" status | grep -q "与当前源码一致"'

OUT=$(sh "$HERE/install.sh" install 2>&1) || true
check "源码没变时重装不重编" 'printf "%s" "$OUT" | grep -q "不重编"' "$OUT"
N=$(pgrep -cf "^$BIN serve" 2>/dev/null || true)
check "重装后只有一个 agent 进程（旧的被停掉）" '[ "${N:-0}" -eq 1 ]' "进程数 ${N}"

sh "$HERE/install.sh" uninstall >/dev/null 2>&1 || true
check "卸载后二进制没了" '[ ! -e "$BIN" ]'
check "卸载后自启项没了" '[ ! -e "$DESK" ]'
sleep 0.3
check "卸载后进程停了" '! pgrep -f "^$BIN serve" >/dev/null 2>&1'

printf '\n\033[1m安装冒烟：%d 通过，%d 失败\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
