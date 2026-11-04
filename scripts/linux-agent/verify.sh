#!/bin/sh
# 一键验证 Linux X11 支持：先探针（三个原语），再一致性套件（op 与护栏）。
#
# 不要求本机是 Linux，也不要求装任何 X11 开发包：全在容器里跑。
#
#   ./scripts/linux-agent/verify.sh                 # 默认 1280x800x24
#   sh scripts/linux-agent/verify.sh --native       # Linux 上直接编译并在 Xvfb 验证，不需要 Docker
#   SCREEN=1920x1080x24 verify.sh                   # 换分辨率
#   MULTICC_LINUX_PROBE_IMAGE=foo verify.sh         # 换镜像名（避免和别的构建撞）
#   APT_MIRROR=mirrors.tuna.tsinghua.edu.cn/ubuntu-ports verify.sh   # 直连官方源拉不动时
#
# apt 源别用 aliyun：实测它在 gcc-11(19MB)/libllvm15(30MB) 这种大文件上是**零字节
# 挂死**（反复 Ign: 重试），而 tuna / ustc 能跑到 5MB/s。官方 ports.ubuntu.com 同样挂。
#
# 退出码 0 = 探针与一致性套件都过。
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
IMAGE=${MULTICC_LINUX_PROBE_IMAGE:-multicc-linux-agent-probe}
SCREEN=${SCREEN:-${PROBE_SCREEN:-1280x800x24}}
MIRROR=${APT_MIRROR:-}

if [ "${1:-}" = "--native" ]; then
  [ "$(uname -s)" = Linux ] || { echo '--native requires Linux' >&2; exit 2; }
  command -v xvfb-run >/dev/null || { echo 'Install Xvfb and xauth before running --native' >&2; exit 2; }
  WORK=$(mktemp -d "${TMPDIR:-/tmp}/multicc-linux-verify.XXXXXX")
  trap 'rm -rf "$WORK"' EXIT INT TERM
  MULTICC_STRICT=1 sh "$DIR/build.sh" "$WORK/multicc-agent-linux"
  cc -O2 -Wall -Wextra -Werror "$DIR/test-json.c" "$DIR/json.c" -o "$WORK/test-json"
  "$WORK/test-json"
  cc -O2 -Wall -Wextra -Werror "$DIR/probe.c" -lX11 -lXext -lXtst -o "$WORK/probe"
  export MULTICC_AGENT_BIN="$WORK/multicc-agent-linux" MULTICC_TARGET_BIN="$WORK/multicc-linux-target"
  xvfb-run -a --server-args="-screen 0 $SCREEN" "$WORK/probe"
  xvfb-run -a --server-args="-screen 0 $SCREEN" sh "$DIR/conformance.sh"
  xvfb-run -a --server-args="-screen 0 $SCREEN" sh "$DIR/install-smoke.sh"
  exit 0
fi
if [ "$#" -gt 0 ]; then echo 'Usage: verify.sh [--native]' >&2; exit 2; fi

# 下面凡是「变量紧挨着中文」的地方都写 ${VAR} 而不是 $VAR：zh_CN.UTF-8 下
# macOS 的 bash 会把多字节字符的第一个字节当成变量名的一部分，$MIRROR）直接
# 报 unbound variable（已复现，$VAR 带花括号就没事）。
LABEL=""
if [ -n "$MIRROR" ]; then LABEL="（apt 镜像 ${MIRROR}）"; fi
echo "== 构建验证台镜像：${IMAGE}${LABEL} =="
docker build --build-arg "APT_MIRROR=${MIRROR}" -f "$DIR/Dockerfile.verify" -t "$IMAGE" "$DIR"

echo
echo "== 在 Xvfb（${SCREEN}）里跑探针 + 一致性套件 =="
docker run --rm -e "SCREEN=${SCREEN}" "$IMAGE"
