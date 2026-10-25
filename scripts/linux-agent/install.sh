#!/bin/sh
# 安装 / 卸载 Linux 桌面 Agent（multicc-agent-linux）。不要 root：它跑在用户自己的
# 图形会话里，那正是点击与截图必须发生的地方。
#
#   install.sh install      编译（或用 MULTICC_AGENT_BIN 给的现成二进制）→ 装好 → 登录自启 → 立刻拉起
#   install.sh uninstall    停掉、删自启项与二进制
#   install.sh status       装没装、是不是当前源码编的、在不在跑、Esc 急停在不在
#
# 布局（与 macOS 那份 scripts/install-agent.sh 对齐，脚本和技能只认这几个路径）：
#   ~/.multicc/agent/                       0700：二进制、source.sha256、agent.log
#   ~/.multicc/bin/multicc-agent            客户端软链（CLI 镜像，mcu.sh 等脚本调它）
#   ~/.config/autostart/multicc-agent.desktop   XDG 自启项（登录图形会话时拉起）
#   $XDG_RUNTIME_DIR/multicc-agent/agent.sock    socket（agent 自己建，0700 目录 + 0600）
#
# 为什么用 XDG autostart 而不是 systemd --user 单元：agent 必须拿到**这个图形会话**的
# DISPLAY / XAUTHORITY。systemd 用户实例只有在桌面环境主动 import-environment 时才有
# 这两个变量（GNOME/KDE 会，XFCE/i3/多数轻量 WM 不会），而 XDG autostart 由会话本身
# 拉起，天然继承。代价：i3/dwm 这类不读 autostart 的 WM 要自己在配置里加一行 exec
# （install 结束时会打印）。
#
# 只支持 X11 会话：Wayland 下 agent 会起来，但所有请求都回 wayland-session（见
# docs/desktop-agent-protocol.md 的 Wayland 一节）。这里装的时候就先提醒一声。
#
# 变量紧挨着中文时一律写 ${VAR}：zh_CN.UTF-8 下有的 sh 会把多字节字符的第一个字节
# 当成变量名的一部分（已复现）。
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
MHOME=${MULTICC_HOME:-$HOME/.multicc}
ADIR=${MULTICC_AGENT_DIR:-$MHOME/agent}
BIN="$ADIR/multicc-agent-linux"
STAMP="$ADIR/source.sha256"
LOG="$ADIR/agent.log"
LINK=${MULTICC_AGENT_LINK:-$MHOME/bin/multicc-agent}
AUTOSTART_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/autostart
DESKTOP="$AUTOSTART_DIR/multicc-agent.desktop"
SOURCES="agent.h agent.c json.c x11.c image.c"

say() { printf '%s\n' "$*"; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Linux" ] || die "只在 Linux 上用（macOS 用 scripts/install-agent.sh）"

source_sum() {
  # shellcheck disable=SC2086
  (cd "$HERE" && cat $SOURCES) | sha256sum | cut -d' ' -f1
}

# 正在跑的 agent 进程（只认我们装的那个路径，别误杀用户别处编的调试版）。
running_pids() { pgrep -u "$(id -u)" -f "^$BIN( |$)" 2>/dev/null || true; }

stop_agent() {
  pids=$(running_pids)
  [ -n "$pids" ] || return 0
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  i=0
  while [ "$i" -lt 20 ] && [ -n "$(running_pids)" ]; do sleep 0.1; i=$((i + 1)); done
  pids=$(running_pids)
  # shellcheck disable=SC2086
  [ -z "$pids" ] || kill -9 $pids 2>/dev/null || true
}

session_note() {
  if [ "${XDG_SESSION_TYPE:-}" = "wayland" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; then
    say "注意：当前是 Wayland 会话。远程屏幕只支持 X11 会话 —— 注销后在登录界面选「Xorg / X11」"
    say "      （Ubuntu 是齿轮里的「Ubuntu on Xorg」）。在 Wayland 下 agent 会如实回 wayland-session。"
  fi
}

start_agent() {
  if [ -z "${DISPLAY:-}" ]; then
    say "当前 shell 没有 DISPLAY（多半是 SSH 进来的）：下次登录图形会话时会自动拉起。"
    return 0
  fi
  # setsid + nohup：脱离当前终端，关掉终端不带走 agent。
  setsid nohup "$BIN" serve >>"$LOG" 2>&1 </dev/null &
  i=0
  while [ "$i" -lt 30 ]; do
    if "$BIN" ping >/dev/null 2>&1; then say "agent 已在运行。"; return 0; fi
    sleep 0.1
    i=$((i + 1))
  done
  say "agent 拉起了但没应答 ping，看日志：${LOG}"
  tail -n 5 "$LOG" 2>/dev/null || true
  return 1
}

do_install() {
  mkdir -p "$ADIR" "$(dirname -- "$LINK")" "$AUTOSTART_DIR"
  chmod 0700 "$ADIR"
  sum=$(source_sum)

  if [ -n "${MULTICC_AGENT_BIN:-}" ]; then
    # 现成二进制（例如发行包里预编好的）：不校验来源哈希，调用方自己负责。
    [ -x "$MULTICC_AGENT_BIN" ] || die "MULTICC_AGENT_BIN 不可执行：${MULTICC_AGENT_BIN}"
    tmp="$ADIR/.multicc-agent-linux.new"
    cp "$MULTICC_AGENT_BIN" "$tmp"
    sum="prebuilt"
  elif [ -x "$BIN" ] && [ "$(cat "$STAMP" 2>/dev/null || true)" = "$sum" ]; then
    tmp=""
    say "二进制已是当前源码编的（${sum%"${sum#????????????}"}），不重编。"
  else
    tmp="$ADIR/.multicc-agent-linux.new"
    # build.sh 缺头文件时会打印各发行版的安装命令并以 3 退出。
    sh "$HERE/build.sh" "$tmp" || die "编译失败（缺依赖时上面有安装命令）"
    # 测试靶子是 build.sh 的副产物，不随安装走。
    rm -f "$ADIR/multicc-linux-target"
  fi

  stop_agent
  if [ -n "$tmp" ]; then
    chmod 0755 "$tmp"
    mv -f "$tmp" "$BIN"   # 同目录 rename：不会出现「半个二进制」
    printf '%s\n' "$sum" >"$STAMP"
  fi
  ln -sfn "$BIN" "$LINK"

  # Exec 里不能直接写重定向，借 sh -c；路径作为参数传，避免引号里再套引号。
  cat >"$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=MultiCC Agent
Comment=MultiCC remote screen agent (X11)
Exec=sh -c 'exec "\$0" serve >>"\$1" 2>&1' "$BIN" "$LOG"
NoDisplay=true
Terminal=false
X-GNOME-Autostart-enabled=true
X-GNOME-Autostart-Delay=2
EOF
  say "已安装：${BIN}"
  say "登录自启：${DESKTOP}"
  say "（i3 / dwm 等不读 XDG autostart 的窗口管理器，请在配置里加一行：exec ${BIN} serve）"
  session_note
  start_agent
}

do_uninstall() {
  stop_agent
  rm -f "$DESKTOP" "$BIN" "$STAMP"
  if [ -L "$LINK" ] && [ "$(readlink "$LINK")" = "$BIN" ]; then rm -f "$LINK"; fi
  say "已卸载（日志保留在 ${LOG}）。"
}

do_status() {
  if [ -x "$BIN" ]; then
    want=$(source_sum)
    have=$(cat "$STAMP" 2>/dev/null || echo '?')
    if [ "$have" = "$want" ]; then say "二进制：已安装，与当前源码一致"
    elif [ "$have" = "prebuilt" ]; then say "二进制：已安装（预编译版）"
    else say "二进制：已安装，但不是当前源码编的 —— 跑一次 install 更新"; fi
  else
    say "二进制：未安装"
  fi
  [ -f "$DESKTOP" ] && say "登录自启：已配置" || say "登录自启：未配置"
  if [ -n "$(running_pids)" ]; then
    say "进程：在运行"
    "$BIN" status 2>/dev/null || true
  else
    say "进程：未运行"
  fi
  session_note
}

case "${1:-}" in
  install) do_install ;;
  uninstall) do_uninstall ;;
  status) do_status ;;
  *) say "用法：$0 install | uninstall | status"; exit 2 ;;
esac
