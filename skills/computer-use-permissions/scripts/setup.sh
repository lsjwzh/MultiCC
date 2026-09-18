#!/bin/bash
# computer-use 权限设置：弹出辅助功能设置页 + Finder 高亮待授权二进制
# 用法: bash ~/.claude/skills/computer-use-permissions/scripts/setup.sh
set -u

BIN_DIR="/opt/homebrew/bin"
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CU_TMP=$(ls -dt /var/folders/*/*/T/computer-use.* 2>/dev/null | head -1)

echo "== computer-use 辅助功能权限设置 =="

# 1) cliclick
if [ -x "$BIN_DIR/cliclick" ]; then
  echo "[ok] cliclick: $BIN_DIR/cliclick ($(basename -- $BIN_DIR/cliclick) 已存在)"
else
  echo "[缺失] cliclick 未安装，执行: brew install cliclick"
  brew install cliclick 2>&1 | tail -2
fi

# 2) _cu_scroll 稳定版（优先临时目录复制，其次本技能源码编译，最后 computer-use 技能源码）
if [ ! -x "$BIN_DIR/_cu_scroll" ]; then
  if [ -n "$CU_TMP" ] && [ -f "$CU_TMP/_cu_scroll" ]; then
    cp "$CU_TMP/_cu_scroll" "$BIN_DIR/_cu_scroll" && chmod +x "$BIN_DIR/_cu_scroll"
    echo "[ok] 已从 computer-use 临时目录复制 _cu_scroll"
  elif [ -f "$SKILL_DIR/scripts/scroll.swift" ]; then
    swiftc -O -o "$BIN_DIR/_cu_scroll" "$SKILL_DIR/scripts/scroll.swift" 2>/dev/null
    echo "[ok] 已从本技能 scroll.swift 编译 _cu_scroll"
  elif [ -f "$HOME/.claude/skills/computer-use/scripts/scroll.swift" ]; then
    swiftc -O -o "$BIN_DIR/_cu_scroll" "$HOME/.claude/skills/computer-use/scripts/scroll.swift" 2>/dev/null
    echo "[ok] 已从 computer-use 技能源码编译 _cu_scroll"
  fi
fi
[ -x "$BIN_DIR/_cu_scroll" ] && echo "[ok] _cu_scroll: $BIN_DIR/_cu_scroll" || echo "[失败] _cu_scroll 未能就位"

# 3) node 路径
NODE_BIN=$(command -v node || echo /opt/homebrew/bin/node)
echo "[info] node: $NODE_BIN"

# 待授权清单
ITEMS=("$BIN_DIR/cliclick" "$BIN_DIR/_cu_scroll")

# 4) 弹出「隐私与安全性 → 辅助功能」设置页
open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
sleep 1

# 5) Finder 高亮各二进制（方便拖拽进列表）
for it in "${ITEMS[@]}"; do
  [ -e "$it" ] && open -R "$it"
done
[ -e "$NODE_BIN" ] && open -R "$NODE_BIN"

cat <<'EOF'

------------------------------------------------------------
待添加到「辅助功能」的项目（如果列表里已有且开关为开，跳过即可）:
  /opt/homebrew/bin/cliclick
  /opt/homebrew/bin/_cu_scroll
  node 的完整路径（见上方 [info] 行）

操作步骤:
  1. 设置页点列表下方的「+」（需要 Touch ID / 密码验证）
  2. 文件框里按 ⌘⇧G，粘贴上面任一完整路径（含文件名），回车，点「打开」
     —— 或者直接把 Finder 里高亮的文件拖进设置列表
  3. 每个项目重复一次；添加后确认开关是「开」

提示: 授权绑定二进制路径，不要添加 /var/folders/.../computer-use.* 里的临时副本。
------------------------------------------------------------
EOF
