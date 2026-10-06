#!/bin/sh
# 编译 Linux 桌面 Agent。
#
#   build.sh [OUT]          默认 OUT = 本目录下的 multicc-agent-linux
#
# 顺带把一致性测试的靶子窗口（test-target.c）也编出来，落在同一个目录，
# 于是「编译」和「验证」各自只有一条命令。靶子只是测试夹具，不随发行包走。
#
# 依赖是五个系统库，没有可携带的第三方包：
#   X11 Xext Xtst Xss z jpeg
# 缺哪个就照下面 APT/DNF/PACMAN 的提示装。刻意不做「缺 Xss 就自动降级成
# 不检测锁屏」——那会让「锁屏检测悄悄失效」变成没人发现的默认状态。
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OUT=${1:-$HERE/multicc-agent-linux}
TARGET="$(dirname -- "$OUT")/multicc-linux-target"

AGENT_SRC=""
for s in agent.c json.c x11.c image.c; do AGENT_SRC="$AGENT_SRC $HERE/$s"; done
LIBS="-lX11 -lXext -lXtst -lXss -lz -ljpeg"

# 变量紧挨着中文时一律写 ${VAR}：zh_CN.UTF-8 下 macOS 的 sh 会把多字节字符的
# 第一个字节当成变量名的一部分（$OUT）直接报 unbound variable。
CC=${CC:-cc}
CFLAGS="-O2 -Wall -Wextra -pthread"
if [ -n "${MULTICC_STRICT:-}" ]; then CFLAGS="$CFLAGS -Werror"; fi

missing=""
for h in X11/Xlib.h X11/extensions/XShm.h X11/extensions/XTest.h X11/extensions/scrnsaver.h zlib.h jpeglib.h; do
  [ -f "/usr/include/$h" ] || missing="$missing $h"
done
if [ -n "$missing" ]; then
  echo "build.sh: 缺少头文件：${missing}" >&2
  echo "  Debian/Ubuntu: apt install build-essential libx11-dev libxext-dev libxtst-dev libxss-dev zlib1g-dev libjpeg-turbo8-dev" >&2
  echo "  Fedora/RHEL:   dnf install gcc libX11-devel libXext-devel libXtst-devel libXScrnSaver-devel zlib-devel libjpeg-turbo-devel" >&2
  echo "  Arch:          pacman -S base-devel libx11 libxext libxtst libxss zlib libjpeg-turbo" >&2
  exit 3
fi

echo "== 编译 Agent → ${OUT} =="
# shellcheck disable=SC2086
$CC $CFLAGS -o "$OUT" $AGENT_SRC $LIBS
chmod 0755 "$OUT"

if [ -f "$HERE/test-target.c" ]; then
  echo "== 编译测试靶子 → ${TARGET} =="
  # shellcheck disable=SC2086
  $CC $CFLAGS -o "$TARGET" "$HERE/test-target.c" $LIBS
  chmod 0755 "$TARGET"
fi

echo "完成。"