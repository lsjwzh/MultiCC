#!/bin/bash
# multicc-computer-use 的 legacy 链（cliclick / _cu_scroll / node）权限设置：弹出辅助功能设置页 + Finder 高亮待授权二进制
# 已装 MultiCC Agent 且授权的机器不需要本脚本（只需给 MultiCC Agent 一个 App 授权）。
# 用法: bash <skill_dir>/scripts/setup.sh
set -u

# Homebrew prefix: /opt/homebrew on Apple silicon, /usr/local on Intel (most
# macOS 11 machines).
if command -v brew >/dev/null 2>&1; then BIN_DIR="$(brew --prefix)/bin"
elif [ "$(uname -m)" = arm64 ]; then BIN_DIR=/opt/homebrew/bin
else BIN_DIR=/usr/local/bin
fi
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CU_TMP=$(ls -dt /var/folders/*/*/T/*computer-use.* 2>/dev/null | head -1)

echo "== multicc-computer-use (legacy) 辅助功能权限设置 =="

# 1) cliclick
if [ -x "$BIN_DIR/cliclick" ]; then
  echo "[ok] cliclick: $BIN_DIR/cliclick ($(basename -- $BIN_DIR/cliclick) 已存在)"
else
  echo "[缺失] cliclick 未安装，执行: brew install cliclick"
  brew install cliclick 2>&1 | tail -2
fi

# 2) _cu_scroll 稳定版（优先临时目录复制，其次本技能源码编译，最后 multicc-computer-use 技能源码）
if [ ! -x "$BIN_DIR/_cu_scroll" ]; then
  if [ -n "$CU_TMP" ] && [ -f "$CU_TMP/_cu_scroll" ]; then
    cp "$CU_TMP/_cu_scroll" "$BIN_DIR/_cu_scroll" && chmod +x "$BIN_DIR/_cu_scroll"
    echo "[ok] 已从 multicc-computer-use 临时目录复制 _cu_scroll"
  elif [ -f "$SKILL_DIR/scripts/scroll.swift" ]; then
    swiftc -O -o "$BIN_DIR/_cu_scroll" "$SKILL_DIR/scripts/scroll.swift" 2>/dev/null
    echo "[ok] 已从本技能 scroll.swift 编译 _cu_scroll"
  elif [ -f "$(dirname "$SKILL_DIR")/multicc-computer-use/scripts/scroll.swift" ]; then
    swiftc -O -o "$BIN_DIR/_cu_scroll" "$(dirname "$SKILL_DIR")/multicc-computer-use/scripts/scroll.swift" 2>/dev/null
    echo "[ok] 已从 multicc-computer-use 技能源码编译 _cu_scroll"
  fi
fi
[ -x "$BIN_DIR/_cu_scroll" ] && echo "[ok] _cu_scroll: $BIN_DIR/_cu_scroll" || echo "[失败] _cu_scroll 未能就位"

# 3) node 路径
NODE_BIN=$(command -v node || echo "$BIN_DIR/node")
echo "[info] node: $NODE_BIN"

# 待授权清单
ITEMS=("$BIN_DIR/cliclick" "$BIN_DIR/_cu_scroll")

# 4) 弹出辅助功能设置页（macOS 13+ 叫「系统设置 → 隐私与安全性」，11/12 叫「系统偏好设置 → 安全性与隐私 → 隐私」）
open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
sleep 1

# 5) Finder 高亮各二进制（方便拖拽进列表）
for it in "${ITEMS[@]}"; do
  [ -e "$it" ] && open -R "$it"
done
[ -e "$NODE_BIN" ] && open -R "$NODE_BIN"

cat <<EOF

------------------------------------------------------------
待添加到「辅助功能」的项目（如果列表里已有且开关为开，跳过即可）:
  $BIN_DIR/cliclick
  $BIN_DIR/_cu_scroll
  node 的完整路径（见上方 [info] 行）

操作步骤:
  1. 设置页点列表下方的「+」（需要 Touch ID / 密码验证；macOS 11/12 先点左下角锁解锁）
  2. 文件框里按 ⌘⇧G，粘贴上面任一完整路径（含文件名），回车，点「打开」
     —— 或者直接把 Finder 里高亮的文件拖进设置列表
  3. 每个项目重复一次；添加后确认开关是「开」

提示: 授权绑定二进制路径，不要添加 /var/folders/.../multicc-computer-use.* 里的临时副本。
------------------------------------------------------------
EOF
