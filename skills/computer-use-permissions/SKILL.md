---
name: computer-use-permissions
description: 为 multicc-computer-use 的 legacy 链（cliclick / _cu_scroll / node）授予 macOS 辅助功能权限；已安装并授权 MultiCC Agent 时不需要。运行 setup.sh 会同时弹出「系统设置 → 隐私与安全性 → 辅助功能」页面和 Finder（高亮待授权的二进制），方便用户拖拽或 ⌘⇧G 添加。含 Touch ID 之后的自动导航与验证流程。
---

# multicc-computer-use（legacy 链）权限设置技能

> 优先方案是 MultiCC Agent：只给「MultiCC Agent」一个 App 开辅助功能 + 屏幕与系统录音，任何 CLI 都能用、换 node 版本不失效。`multicc-computer-use/scripts/mcu.sh backend` 输出 `agent` 时本技能无需执行。

给本机 multicc-computer-use 的 legacy 工具链（源自第三方 oil-oil/computer-use-skill）授予 macOS 辅助功能（Accessibility）权限。

## 背景（为什么需要这个流程）

- multicc 等无 GUI 祖先的守护进程里，`screencapture`（屏幕录制权限）通常已继承可用；但 **cliclick / _cu_scroll 是裸二进制，合成鼠标键盘/滚动事件需要各自单独授权辅助功能**。
- `node` 也建议授权（multicc 重启后 osascript System Events 窗口查询对整链生效）。
- 授权按**二进制路径**绑定，所以工具必须放在稳定路径：Homebrew 的 bin 目录，下文记作 `$BREW_BIN`（Apple 芯片是 `/opt/homebrew/bin`，Intel Mac——多数 macOS 11 机器——是 `/usr/local/bin`；`echo $(brew --prefix)/bin` 可查）。multicc-computer-use 技能的 init.sh 每次会往 `/var/folders/.../T/multicc-computer-use.*` 编译临时副本——那个永远没权限，**不要授权临时副本**，让用户始终添加 `$BREW_BIN` 下的稳定版。

## 使用流程

### 第 1 步：运行 setup.sh（弹出设置页 + Finder）

```bash
bash <skill_dir>/scripts/setup.sh   # skill_dir 即本技能所在目录
```

脚本会：
1. 确保 `$BREW_BIN` 下有 `cliclick`（缺失时提示 brew install）和 `_cu_scroll`（缺失时从本技能 `scripts/scroll.swift` 现场编译，或从 multicc-computer-use 技能的临时目录复制）；
2. `open` 辅助功能设置锚点页面；
3. 对每个二进制 `open -R` 在 Finder 里高亮显示；
4. 打印待授权清单。

### 第 2 步：指导用户（或自动化）添加

告知用户：需要为清单里的每个二进制点「+」添加，**点「+」后的 Touch ID / 密码验证无法自动化，必须由用户手动完成**。

用户完成 Touch ID、文件选择框弹出后，可以全自动完成剩下的（2026-09-18 实测通过的序列）：

```bash
# 检测文件选择框弹出（node 已授权时 System Events 可用；macOS 11/12 把 "System Settings" 换成 "System Preferences"）
osascript -e 'tell application "System Events" to tell process "System Settings" to get name of every sheet of window 1'
osascript -e 'tell application "System Events" to tell (first process whose frontmost is true) to get name of every window'
# 出现「打开」窗口即文件选择框已弹出

# ⌘⇧G → 粘贴完整路径（含文件名）→ 回车
BREW_BIN="$(brew --prefix)/bin"
osascript -e "set the clipboard to \"$BREW_BIN/_cu_scroll\""
"$BREW_BIN/cliclick" kd:cmd kd:shift t:G ku:shift ku:cmd; sleep 0.8
"$BREW_BIN/cliclick" kd:cmd t:v ku:cmd; sleep 0.5
"$BREW_BIN/cliclick" kp:return; sleep 1
# 截图 + 视觉分析定位「打开」按钮坐标，cliclick 点击
```

注意 cliclick 键盘细节：`kp:` 只收特殊键名（return/esc/page-down…）；普通字母必须用 `t:`（`kp:g` 报 Invalid key）；组合键写成 `kd:cmd kd:shift t:G ku:shift ku:cmd`。

也可以让用户手动：把 Finder 里高亮的文件**拖进**辅助功能列表，或在文件选择框里按 `⌘⇧G` 粘贴完整路径（必须含文件名，目录浏览看不到 /opt/homebrew 或 /usr/local）。

### 第 3 步：验证（不要信自报状态）

- **cliclick**：`cliclick p` exit 0 不代表事件被接受。决定性测试：点击 Dock 图标后查 `osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'` 是否切换。
- **_cu_scroll**：TextEdit 打开 300 行长文档，`_cu_scroll 500 400 -8` 前后对窗口文本区裁剪截图比 MD5，变了才是真生效。
- **node**：需重启使用它的守护进程（如 multicc）后，System Events 窗口/sheet 查询可用即生效。

## 权限生效语义（排障用）

- cliclick / _cu_scroll：授权**即时生效**，无需重启任何进程。
- node：授权后要对整链生效需重启宿主进程（multicc 需用户手动 POST /api/restart）。
- 屏幕录制（screencapture）：与辅助功能是两个独立 TCC 类别；multicc 进程链一般已可用。
