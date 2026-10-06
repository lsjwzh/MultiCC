#!/bin/sh
# Linux Agent 一致性测试：真 X server 里跑真 agent，用真窗口当靶子。
#
#   DISPLAY=:99 conformance.sh
#
# 需要 DISPLAY 已经就绪（Dockerfile.verify 用 xvfb-run 起）。自己起 Xvfb 会把
# 「屏幕多大、有没有扩展」变成脚本里的分支，反而更难复现。
#
# 为什么值得写这么多断言：这个 agent 的失败大多是**静默**的 —— 事件发出去了
# 但落在空处、截图成功了但是全黑、中文字符丢了但回 ok。只看 ok:true 一个都
# 抓不到。所以凡是能落到真窗口上的，一律拿真窗口的观测结果对账。
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
AGENT=${MULTICC_AGENT_BIN:-$HERE/multicc-agent-linux}
TARGET=${MULTICC_TARGET_BIN:-$HERE/multicc-linux-target}

[ -x "$AGENT" ] || { echo "找不到 agent 可执行文件：${AGENT}" >&2; exit 2; }
[ -x "$TARGET" ] || { echo "找不到靶子可执行文件：${TARGET}" >&2; exit 2; }
[ -n "${DISPLAY:-}" ] || { echo "需要 DISPLAY（建议 xvfb-run -a $0）" >&2; exit 2; }

WORK=$(mktemp -d "${TMPDIR:-/tmp}/multicc-linux-conf.XXXXXX")
# socket 放在**下一层**目录：那一层得由 agent 自己 mkdir 0700，下面才谈得上
# 断言「目录权限是 agent 建的」。直接放在 mktemp 的目录里就等于在测 mktemp。
SOCK="$WORK/agent/agent.sock"
TLOG="$WORK/target.log"
ALOG="$WORK/agent.log"
PASS=0; FAIL=0
cleanup() {
  [ -n "${T2PID:-}" ] && kill "$T2PID" 2>/dev/null || true
  [ -n "${TPID:-}" ] && kill "$TPID" 2>/dev/null || true
  [ -n "${APID:-}" ] && kill "$APID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

ok()  { PASS=$((PASS + 1)); printf '  \033[32m✅\033[0m %s\n' "$1"; }
no()  { FAIL=$((FAIL + 1)); printf '  \033[31m❌\033[0m %s\n' "$1"; printf '     实得: %s\n' "$2"; }
sect(){ printf '\n\033[1m%s\033[0m\n' "$1"; }

# 一次 op 的完整往返。--raw 直接发这段 JSON，所以脚本里能构造任意请求，
# 也能构造正常客户端永远不会发的畸形请求。
req() { "$AGENT" --socket "$SOCK" --raw "$1" 2>&1 || true; }

# 断言响应里含某个片段。
has() { # 名称 响应 片段
  case "$2" in
    *"$3"*) ok "$1" ;;
    *) no "$1" "$2" ;;
  esac
}

# 断言响应里**不**含某个片段。
lacks() {
  case "$2" in
    *"$3"*) no "$1" "$2" ;;
    *) ok "$1" ;;
  esac
}

# 等日志里出现某行（最多 3 秒）。日志文件是参数：靶子二号有自己的一份。
waits_in() { # 文件 片段
  i=0
  while [ "$i" -lt 30 ]; do
    if grep -qF "$2" "$1" 2>/dev/null; then return 0; fi
    sleep 0.1
    i=$((i + 1))
  done
  return 1
}

seen() { # 名称 片段
  if waits_in "$TLOG" "$2"; then ok "$1"; else no "$1" "靶子日志里一直没有「${2}」"; fi
}

# 断言靶子没看见某行（等一小会儿再判负，给异步留时间）。坐标各测试都不重复，
# 所以「没见过」是真的没见过，不是被别的测试写的。
unseen() {
  sleep 0.4
  if grep -qF "$2" "$TLOG" 2>/dev/null; then no "$1" "靶子不该看到「${2}」却看到了"; else ok "$1"; fi
}

# ── 起进程 ────────────────────────────────────────────────────────────────

"$AGENT" --socket "$SOCK" --verbose serve >"$ALOG" 2>&1 &
APID=$!
i=0
while [ "$i" -lt 50 ]; do
  [ -S "$SOCK" ] && break
  sleep 0.1
  i=$((i + 1))
done
if [ ! -S "$SOCK" ]; then
  echo "agent 没起来，日志：" >&2
  cat "$ALOG" >&2
  exit 1
fi

# 靶子放在 (400,300)，200×200，纯色 #2ba67a —— 颜色是有意选的：截图断言靠
# 「这一像素等于这个值」，JPEG 的有损会把它抹掉，所以那条断言一律用 PNG。
"$TARGET" 400 300 200 200 2ba67a >"$TLOG" 2>&1 &
TPID=$!
if ! waits_in "$TLOG" "READY"; then
  echo "靶子窗口没起来，日志：" >&2
  cat "$TLOG" >&2
  exit 1
fi
printf '靶子窗口就绪（400,300 200×200 #2ba67a），socket：%s\n' "$SOCK"

# ── 1. 环境与状态 ────────────────────────────────────────────────────────

sect "1. 状态与自述"

R=$(req '{"op":"status","session":"cli"}')
has "status 回 ok" "$R" '"ok":true'
has "status 报 X11 后端" "$R" '"backend":"x11"'
has "status 报屏幕尺寸" "$R" '"screen":{'
has "status 报未锁屏" "$R" '"screenLocked":false'
has "status 报无租约持有者" "$R" '"leaseHolder":null'
has "status 上有 DISPLAY" "$R" '"display":'

SW=$(printf '%s' "$R" | sed -n 's/.*"width":\([0-9]*\).*/\1/p')
if [ -n "$SW" ] && [ "$SW" -gt 300 ]; then ok "屏幕宽度合理（${SW}）"; else no "屏幕宽度合理" "$R"; fi

has "ping 回 pong" "$(req '{"op":"ping"}')" '"pong":true'
has "未知 op 被拒" "$(req '{"op":"nonsense"}')" '"error":"unknown-op"'
has "缺 op 被拒" "$(req '{"session":"cli"}')" '"error":"op-required"'
has "畸形 JSON 被拒" "$(req '{"op":')" '"ok":false'
has "畸形 JSON 之后还活着" "$(req '{"op":"ping"}')" '"pong":true'

# socket 权限：X11 没有权限模型，这个 0600 + 同 uid 检查就是全部的边界。
PERM=$(stat -c '%a' "$SOCK" 2>/dev/null || echo '?')
DIRPERM=$(stat -c '%a' "$WORK/agent" 2>/dev/null || echo '?')
[ "$PERM" = "600" ] && ok "socket 权限 0600" || no "socket 权限 0600" "实得 ${PERM}"
[ "$DIRPERM" = "700" ] && ok "socket 目录权限 0700" || no "socket 目录权限 0700" "实得 ${DIRPERM}"

# ── 2. 截图 ──────────────────────────────────────────────────────────────

sect "2. 截图（含「不是黑帧」的像素断言）"

FULL="$WORK/full.png"
R=$(req "{\"op\":\"snap\",\"session\":\"cli\",\"path\":\"$FULL\"}")
has "snap 回 ok" "$R" '"ok":true'
has "snap 报整屏尺寸" "$R" "\"width\":${SW}"
[ -s "$FULL" ] && ok "snap 落盘且非空" || no "snap 落盘且非空" "$(ls -l "$FULL" 2>&1)"

# 这一条是整个套件里最重要的一条：容器 / 无头环境里 MIT-SHM 会「成功」地
# 返回全黑帧，agent 会一路 ok。只有真去解像素才抓得住。
if "$TARGET" --png-has-color "$FULL" 2ba67a; then
  ok "整屏截图里真的有靶子窗口的颜色（不是黑帧）"
else
  no "整屏截图里真的有靶子窗口的颜色（不是黑帧）" "PNG 里找不到 #2ba67a"
fi

# 裁一块**不含**窗口的区域：能证明 crop 真的生效了，而不是被忽略后整屏落盘。
CROP="$WORK/crop.png"
R=$(req "{\"op\":\"snap\",\"session\":\"cli\",\"path\":\"$CROP\",\"crop\":{\"x\":0,\"y\":0,\"width\":64,\"height\":64}}")
has "snap+crop 回 ok" "$R" '"ok":true'
has "snap+crop 回裁剪框" "$R" '"crop":{'
has "snap+crop 的宽是 64" "$R" '"width":64'
if "$TARGET" --png-has-color "$CROP" 2ba67a; then
  no "裁掉的区域里没有窗口颜色" "64×64 的裁剪图里竟然有 #2ba67a，crop 可能没生效"
else
  ok "裁掉的区域里没有窗口颜色（crop 真的生效）"
fi

has "相对路径被拒" "$(req '{"op":"snap","session":"cli","path":"tmp/x.png"}')" '"error":"bad-path"'
has "带 .. 的路径被拒" "$(req '{"op":"snap","session":"cli","path":"/tmp/../etc/x.png"}')" '"error":"bad-path"'
has "缺 path 被拒" "$(req '{"op":"snap","session":"cli"}')" '"error":"path-required"'
R=$(req "{\"op\":\"snap\",\"session\":\"cli\",\"path\":\"$WORK/oob.png\",\"crop\":{\"x\":99999,\"y\":0,\"width\":10,\"height\":10}}")
has "越界裁剪被拒" "$R" '"ok":false'

# JPEG 也要能编出来（真实前端走的就是这条：quality 60、体积小）。
JPG="$WORK/full.jpg"
R=$(req "{\"op\":\"snap\",\"session\":\"cli\",\"path\":\"$JPG\",\"jpeg\":true,\"quality\":60}")
has "JPEG 截图回 ok" "$R" '"ok":true'
[ -s "$JPG" ] && ok "JPEG 落盘且非空" || no "JPEG 落盘且非空" "$(ls -l "$JPG" 2>&1)"
# 编码失败绝不能弄死进程（libjpeg 默认错误处理是 exit()）。
HEX=$(head -c 2 "$JPG" | od -An -tx1 | tr -d ' \n')
[ "$HEX" = "ffd8" ] && ok "JPEG 魔数正确（ffd8）" || no "JPEG 魔数正确（ffd8）" "$HEX"

# ── 3. 护栏 ──────────────────────────────────────────────────────────────

sect "3. 护栏（越权 / 缺会话 / 锁屏 / 急停）"

has "click 缺 allowSystem 被拒" \
  "$(req '{"op":"click","session":"conf","x":450,"y":350}')" '"error":"not-allowed"'
has "type 缺 allowSystem 被拒" \
  "$(req '{"op":"type","session":"conf","allowTerminal":true,"text":"x"}')" '"error":"not-allowed"'
has "click 缺 session 被拒" \
  "$(req '{"op":"click","allowSystem":true,"x":450,"y":350}')" '"error":"session-required"'
has "click 缺坐标被拒" \
  "$(req '{"op":"click","session":"conf","allowSystem":true}')" '"error":"x-and-y-required"'
has "type 缺 text 被拒" \
  "$(req '{"op":"type","session":"conf","allowSystem":true,"allowTerminal":true}')" '"error":"text-required"'
has "press 缺 keys 被拒" \
  "$(req '{"op":"press","session":"conf","allowSystem":true,"allowTerminal":true}')" '"error":"keys-required"'

unseen "被拒绝的点击没有落到靶子上" "BTN 1 press 50,50"

# ── 4. 注入：点击 / 拖动 / 滚轮 ──────────────────────────────────────────

sect "4. 注入到真窗口"

# (450,350) 是全局坐标；靶子窗口左上角在 (400,300)，期望落成局部 (50,50)。
# 这一条同时钉死了「逻辑点 == 像素」这个 X11 前提：如果哪里偷偷乘了缩放系数，
# 局部坐标立刻就不是 50,50。
R=$(req '{"op":"click","session":"conf","allowSystem":true,"x":450,"y":350}')
has "click 回 ok" "$R" '"ok":true'
seen "点击落在窗口内 (50,50)" "BTN 1 press 50,50"
seen "点击有抬起" "BTN 1 release 50,50"

R=$(req '{"op":"click","session":"conf","allowSystem":true,"x":420,"y":320,"button":"right"}')
has "右键回 ok" "$R" '"ok":true'
seen "右键用的是 button 3" "BTN 3 press 20,20"

R=$(req '{"op":"click","session":"conf","allowSystem":true,"x":430,"y":330,"count":2}')
has "双击回 ok" "$R" '"ok":true'
N=$(grep -cF "BTN 1 press 30,30" "$TLOG" 2>/dev/null || true)
[ "$N" -eq 2 ] && ok "双击真的按了两次" || no "双击真的按了两次" "按下 ${N} 次"

R=$(req '{"op":"scroll","session":"conf","allowSystem":true,"x":450,"y":350,"amount":3}')
has "滚轮回 ok" "$R" '"ok":true'
seen "滚轮向上" "SCROLL up"
has "反向滚轮回 ok" \
  "$(req '{"op":"scroll","session":"conf","allowSystem":true,"x":450,"y":350,"amount":-3}')" '"ok":true'
seen "滚轮向下" "SCROLL down"

R=$(req '{"op":"drag","session":"conf","allowSystem":true,"x":450,"y":350,"x2":550,"y2":400,"ms":200}')
has "拖动回 ok" "$R" '"ok":true'
seen "拖动起点按下" "BTN 1 press 50,50"
# 终点那一帧必须真的到过：只看 release 的坐标的话，「按住 → 直接挪到终点 →
# 松开」和「一步一步挪过去」在靶子上长得一样，而后者才是拖拽。
seen "拖动过程经过终点" "MOV 150,100"
seen "拖动终点抬起" "BTN 1 release 150,100"

# ── 5. 键盘：ASCII + 中文 ────────────────────────────────────────────────

sect "5. 键盘（含中文：临时键映射那条链路）"

R=$(req '{"op":"type","session":"conf","allowSystem":true,"allowTerminal":true,"text":"ab"}')
has "输入 ASCII 回 ok" "$R" '"ok":true'
seen "收到 a" "KEY U+0061"
seen "收到 b" "KEY U+0062"

# 中文走的是「临时改键映射 → 按一下 → 整串完再还原」。如果映射还原得太早，
# 接收方反查 keysym 时就已经查不到了 —— 这一条专门盯这个时序。
R=$(req '{"op":"type","session":"conf","allowSystem":true,"allowTerminal":true,"text":"你好"}')
has "输入中文回 ok" "$R" '"ok":true'
seen "收到 你（U+4F60）" "KEY U+4F60"
seen "收到 好（U+597D）" "KEY U+597D"

R=$(req '{"op":"type","session":"conf","allowSystem":true,"allowTerminal":true,"text":"A1! "}')
has "输入大小写与符号回 ok" "$R" '"ok":true'
seen "收到大写 A" "KEY U+0041"
seen "收到数字 1" "KEY U+0031"
seen "收到感叹号" "KEY U+0021"
seen "收到空格" "KEY U+0020"

has "press 组合键回 ok" \
  "$(req '{"op":"press","session":"conf","allowSystem":true,"allowTerminal":true,"keys":"ctrl+shift+a"}')" '"ok":true'
seen "组合键打出大写 A" "KEY U+0041"
has "press 功能键回 ok" \
  "$(req '{"op":"press","session":"conf","allowSystem":true,"allowTerminal":true,"keys":"Return"}')" '"ok":true'
seen "收到 Return 键" "KEYSYM 0xff0d"
has "未知按键名被拒" \
  "$(req '{"op":"press","session":"conf","allowSystem":true,"allowTerminal":true,"keys":"nosuchkey"}')" '"ok":false'

# ── 6. 租约 / 急停 / 收尾 ────────────────────────────────────────────────

sect "6. 租约、急停、解锁"

has "别的会话拿不到租约" \
  "$(req '{"op":"click","session":"other","allowSystem":true,"x":460,"y":360}')" '"error":"busy"'
unseen "被 busy 挡掉的点击没落到靶子上" "BTN 1 press 60,60"

has "release 回 ok" "$(req '{"op":"release","session":"conf"}')" '"ok":true'
# 换一个会话接手：同一个会话去点，区分不出「租约释放了」和「本来就还是我的」。
R=$(req '{"op":"click","session":"other","allowSystem":true,"x":470,"y":370}')
has "释放后别的会话可以接手" "$R" '"ok":true'
seen "接手后的点击落到靶子上" "BTN 1 press 70,70"

# 反方向先立住：agent 自己发 Escape（远端用户按 Esc 关弹窗）**不算**急停。
# 这一条是修「一次点击/打字后面的真急停被吞掉」时立的 —— 那时的写法是注入期间
# 把 prev 一律置 1，代价就是接下来那次真按下不成边沿。两个方向都得钉死。
has "press Escape 自己回 ok" \
  "$(req '{"op":"press","session":"other","allowSystem":true,"allowTerminal":true,"keys":"Escape"}')" '"ok":true'
sleep 0.3
has "agent 自己按 Escape 不算急停" "$(req '{"op":"status","session":"cli"}')" '"halted":false'

# 用户自己按 Esc = 急停。从另一个进程发，才不会被 agent 当成自己的注入。
# 紧跟在上一条 press 之后，形状就是当初漏判的那个：注入刚结束，人按下 Esc。
"$TARGET" --key Escape
sleep 0.3
has "Esc 之后 status 报已急停" "$(req '{"op":"status","session":"cli"}')" '"halted":true'
has "急停之后拒绝注入" \
  "$(req '{"op":"click","session":"other","allowSystem":true,"x":480,"y":380}')" '"error":"user-stopped"'
unseen "急停后点击确实没落到靶子上" "BTN 1 press 80,80"
has "resume 回 ok" "$(req '{"op":"resume","session":"other"}')" '"ok":true'
has "resume 之后恢复注入" \
  "$(req '{"op":"click","session":"other","allowSystem":true,"x":490,"y":390}')" '"ok":true'
seen "恢复后的点击落到靶子上" "BTN 1 press 90,90"

has "unlock 明确回不支持" "$(req '{"op":"unlock","session":"cli"}')" '"error":"unlock-unsupported"'
has "release 收尾" "$(req '{"op":"release","session":"other"}')" '"ok":true'

# ── 7. 敏感窗口：只挡打字，不挡点击 ──────────────────────────────────────

sect "7. 敏感窗口（唯一一条「拒绝」与「允许」同时要被验的规则）"

# 这一条特意放在最后：靶子二号会自己抢走焦点，前面那些靠焦点的测试就跑不了。
# 放在末尾就不必再把焦点还回去（没有窗口管理器，焦点还不了）。
T2LOG="$WORK/t2.log"
"$TARGET" 700 450 100 100 c0392b gnome-control-center >"$T2LOG" 2>&1 &
T2PID=$!
waits_in "$T2LOG" "READY" || no "靶子二号起来了" "t2.log 里没有 READY"

has "敏感窗口里打字被拒" \
  "$(req '{"op":"type","session":"other","allowSystem":true,"allowTerminal":true,"text":"secret"}')" \
  '"error":"protected-app"'
has "敏感窗口里组合键被拒" \
  "$(req '{"op":"press","session":"other","allowSystem":true,"allowTerminal":true,"keys":"Return"}')" \
  '"ok":false'

# 但点击要放行 —— 拒绝得太宽会变成「控制中心面板点不动」这种没人能解释的故障。
R=$(req '{"op":"click","session":"other","allowSystem":true,"x":760,"y":530}')
has "敏感窗口里点击仍然放行" "$R" '"ok":true'
if waits_in "$T2LOG" "BTN 1 press 60,80"; then
  ok "放行的点击确实落到敏感窗口上"
else
  no "放行的点击确实落到敏感窗口上" "t2.log 里没有这一行"
fi
kill "$T2PID" 2>/dev/null || true
T2PID=

# ── 汇总 ─────────────────────────────────────────────────────────────────

printf '\n\033[1m汇总：%d 通过，%d 失败\033[0m\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf '\n--- agent 日志尾部 ---\n'
  tail -n 30 "$ALOG" || true
  printf '\n--- 靶子日志尾部 ---\n'
  tail -n 30 "$TLOG" || true
  exit 1
fi
printf 'Linux Agent 一致性测试全部通过。\n'
