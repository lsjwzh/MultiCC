---
name: multicc-computer-use
description: "通过截图、鼠标和键盘操作 macOS 原生应用（MultiCC 版 computer use）。优先走 MultiCC Agent（一个 App 持有辅助功能+屏幕录制授权，任何 CLI/任何 provider/-p 模式都能用），未安装时退回 screencapture+cliclick。仅在任务无法通过 API、专用 Skill、CDP 浏览器或文件工具完成，需要真实桌面交互时使用；不擅自扩大屏幕访问范围。"

compatibility:
  os: "macOS 11 (Big Sur) 及以上，Apple 芯片与 Intel 均可；新系统自动启用更好的实现（见「系统支持」）"
  preferred:
    - "MultiCC Agent：scripts/install-agent.sh install（仓库内），并在系统设置给「MultiCC Agent」开辅助功能 + 屏幕与系统录音"
  fallback:
    - "cliclick: brew install cliclick，并给调用链授权（见 computer-use-permissions）"
---

# MultiCC Computer Use（macOS）

> 源自第三方 oil-oil/computer-use-skill（MIT，见 LICENSE），MultiCC 改为优先走自家的 MultiCC Agent。
> 旧名 `computer-use` 已退役，MultiCC 启动时会自动清理它的旧安装。

**系统支持（分层实现）**：macOS 11 是下限，新系统自动用更好的实现，旧系统退回兼容实现，同一个 agent 程序在运行时自己判断。
- `$MCU status` 里的 `platform` 字段说明本机情况：`os`、`captureBackends`（截屏实现，按优先级；macOS 14+ 为 `screencapturekit` 进程内截屏，失败自动退回 `screencapture`，回复里 `backend`/`fellBackFrom` 说明实际用了哪个）、`settingsApp` 与 `screenRecordingPane`。
- **引导用户去开权限时，照 `platform.settingsApp` + 对应面板名说**，不要写死：macOS 13+ 是「系统设置 → 隐私与安全性」，macOS 11/12 是「系统偏好设置 → 安全性与隐私 → 隐私」（先点左下角锁解锁）；屏幕录制面板在 13+ 叫「屏幕与系统录音」、11/12 叫「屏幕录制」。
- 元素操作、点击、键盘、Esc 急停在 11–15 上用的是同一套公共接口，没有分层。
- agent 由安装脚本在本机编译（需 Xcode 命令行工具）；老系统的编译器会自动略过只有新系统才有的那部分代码。

**先确认是否真的需要本技能：**
- 网页/浏览器 → 用 CDP 浏览器技能（9222 自动化 Chrome、browser-act），更稳更省 token
- 读写文件、调 API、跑脚本 → 直接用内置工具
- 只有目标是**无 API 的本地 GUI App**（微信、飞书、Figma、模拟器等）才往下走

---

## 统一入口：scripts/mcu.sh

```bash
MCU=<skill_dir>/scripts/mcu.sh
$MCU backend     # agent = 走 MultiCC Agent；legacy: <原因> = 退回 cliclick 链（只有坐标操作）
```

### 首选：按元素操作（agent，移植自 Peekaboo）

```bash
$MCU see 飞书            # 列出该 App 前台窗口的可操作元素（App 名 / bundle id / pid:N；缺省=当前前台 App）
# snapshot ps1_… app=飞书 pid=123 window="…"
# elem_4 button "发送" @812,640 64x32
# elem_7 textfield "搜索" value="" @120,80 300x28
$MCU click-el elem_4      # 优先 AXPress：不移动鼠标、不抢前台；不支持时才真点坐标
$MCU set elem_7 关键词     # 直接写入输入框的值（读回确认）
$MCU type-el elem_7 你好   # 先聚焦再逐字输入（需要触发输入法/联想时用它）
$MCU click-text 发送       # 按文字匹配最近一次 see 里的元素
$MCU press cmd+shift+g    # 组合键；press return 3 = 连按 3 次
```

规则（照做，否则会被 agent 拒绝）：
- **一次 see 只能驱动一次操作**：任何点击/输入后，界面可能已变，下一步前必须重新 `see`（元素编号只对当次有效，10 分钟过期；窗口被移动会自动修正，被缩放则判过期）。
- 截图用来看，元素编号用来点；只有 see 不到的地方（画布、游戏、图片里的按钮）才退回 `snap` + `click X Y`。
- 输出里 `truncated=` 表示元素太多被截断，用 `see --json` 看全量或先把目标区域操作到更简单的界面。

### 回复怎么读
每个操作回 JSON：
- `"outcome":"refused","dispatched":"none"`：**什么都没发出去**。看 `reason`：
  - `stale` / `not-found` → 重新 see；`timeout` / `busy`（别的会话正在用电脑）→ 稍后重试
  - `user-stopped` → **用户按了 Esc 叫停**：立即停手、向用户说明做到哪一步并询问；只有用户明确说继续，才运行 `$MCU resume`
  - `screen-locked` → 屏幕锁着，输入会打进登录密码框：等用户回来，不要重试
  - `protected-app`（系统设置 / 密码弹窗 / 钥匙串）→ 这类必须用户亲手操作，告诉用户
  - `terminal`（往终端/VS Code 打字 = 执行 shell）→ 用你自己的 shell 工具；确需操作须征得用户同意
  - `system-surface`（控制中心/通知中心/Spotlight 等）→ 确有必要才加 allowSystem（`agent call` JSON）
- `"outcome":"dispatched_unverified"` / `"confirmed_change"`：已送达。**不要盲目重试**，先 see 或 snap 看结果。
- `"outcome":"indeterminate"`：可能已执行也可能没有，先看屏幕再决定。

### 安全机制（agent 自带）
- **Esc 急停**：操作进行中或刚操作完 20 秒内，用户按 Esc，agent 立即停止并拒绝后续所有输入，直到 resume。`status` 里 `escMonitor:false` 表示急停没装上（缺输入监控授权），要告诉用户。
- **一次一个会话**：同一时间只有一个 MultiCC 会话能操作键鼠（最后操作后保持 2 分钟，`$MCU release` 可提前释放）。
- 锁屏、系统设置、密码弹窗一律拒绝；终端里打字需要用户同意。

### 坐标操作（agent / legacy 都可用）

| 命令 | 作用 |
|------|------|
| `$MCU snap /tmp/s.png` | 截主屏，**已缩到逻辑分辨率**，图上坐标可直接点击 |
| `$MCU snap /tmp/s.png W H x y` | 截图后裁剪（省 token）；点击坐标 = 图内坐标 + (x, y) |
| `$MCU click X Y` / `dclick` / `rclick` / `move` | 鼠标操作（逻辑坐标） |
| `$MCU scroll X Y N` | 滚动，N<0 向下、N>0 向上；聊天类 App 必须用它，别用键盘 |
| `$MCU type 文本` | 输入到当前焦点，中文直接可用 |

**backend 不是 agent 时**：
- 告诉用户可以在 MultiCC 仓库跑 `scripts/install-agent.sh install`，再到「隐私与安全性」给 **MultiCC Agent** 开辅助功能、输入监控（Esc 急停用）和屏幕与系统录音（后者需在列表点 + 手动添加 `~/Applications/MultiCC Agent.app`），授权后 `launchctl kickstart -k gui/$(id -u)/com.multicc.agent`。
- 当下仍可用 legacy：先跑 `bash <skill_dir>/scripts/init.sh`（检查依赖、打印进程名），授权问题用 **computer-use-permissions** 技能。legacy 没有 see/元素操作，也没有上面的安全机制。

> 多显示器只保证主屏坐标。

## 感知-行动循环

```
1. $MCU see <App>（首选）或 $MCU snap 截图 → Read（优先裁剪）
2. 选目标：元素编号 > AX 元素名（osascript）> 截图坐标
3. 执行一次操作，读回复的 outcome
4. sleep 0.3~1.5s 等渲染 → 再 see / snap 确认
5. 重复直到完成
```

---

## 按键（legacy）

agent 下用 `$MCU press cmd+shift+g` / `$MCU press return`，下面是没有 agent 时的 cliclick 写法。

```bash
cliclick kp:return   kp:esc   kp:tab   kp:delete   kp:arrow-down   kp:page-down
```

> ⚠️ `kp:` 只收特殊键名；普通字母必须用 `t:`（`kp:g`、`kp:cmd-w` 都会报 Invalid key）。
> 组合键要拆成修饰键按下/抬起：⌘⇧G = `cliclick kd:cmd kd:shift t:G ku:shift ku:cmd`；
> ⌘V = `cliclick kd:cmd t:v ku:cmd`。中文/路径输入走剪贴板 + ⌘V 最稳。

---

## 激活应用

```bash
osascript -e 'tell application "Feishu" to activate'
sleep 0.8
```

进程名必须用系统名，初始化时已打印进程列表。常见易错对：
- 飞书 → `Feishu`（不是 `Lark`）
- 微信 → `WeChat`

> ⚠️ 不要用 `set frontmost to true`——会报错 -10006。
> `activate` 已足够，如需置前可加 `set bounds of front window to {…}`。

---

## 点击 UI 元素（比坐标更准）

比截图估坐标更可靠的方式：通过 Accessibility 元素名直接点击。

```bash
# 按名称点击按钮
osascript -e 'tell application "System Events" to tell process "App" to click button "OK" of window 1'

# 先查有哪些可点元素
osascript -e 'tell application "System Events" to tell process "App" to get every UI element of window 1'
```

---

## 等待窗口就绪

```bash
osascript << 'EOF'
tell application "App" to activate
tell application "System Events"
    tell process "App"
        set w to 0
        repeat until (count of windows) > 0 or w > 10
            delay 0.3
            set w to w + 0.3
        end repeat
    end tell
end tell
EOF
```

> 授权失效排查：`$MCU status` 显示 accessibility/screenRecording 为 false，而系统设置里开关是开的——说明 agent 被重签过（ad-hoc 签名时每次重编都会这样）。**关再开没用**，要在列表里选中 MultiCC Agent 点 − 删掉再 + 加回（或 `tccutil reset Accessibility com.multicc.agent` 后重开）。本机用 Developer ID 签名后重编不再失效。
