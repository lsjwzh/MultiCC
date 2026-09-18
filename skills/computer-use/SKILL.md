---
name: computer-use
description: "通过截图、鼠标和键盘操作 macOS 原生应用。仅在任务无法通过 API、专用 Skill 或文件工具完成，需要真实桌面交互时使用。网页任务优先使用浏览器工具，文件读写和代码执行使用对应工具；不擅自扩大屏幕访问范围。"

compatibility:
  required:
    - "cliclick: brew install cliclick"
    - "macOS 辅助功能权限（System Settings → Privacy → Accessibility）"
    - "macOS 屏幕录制权限（System Settings → Privacy → Screen Recording）"
---

> **权限授权**：cliclick / _cu_scroll / node 是裸二进制，需逐个添加辅助功能授权——
> 用 **computer-use-permissions** 技能（setup.sh 一键弹出设置页 + Finder 高亮，含验证方法）。
> 授权绑定二进制路径：init.sh 每次编译的临时 `_cu_scroll` 永远没有权限，
> 已授权的稳定版在 `/opt/homebrew/bin/_cu_scroll`，滚动优先直接用它。

# Computer Use（macOS）

**工具组合**：`screencapture` + `cliclick` + `osascript` + Swift CGEvent（滚动）

> **先确认是否真的需要本 skill：**
> - 操作网页/浏览器 → 用 **agent-browser** skill，更稳定、更省 token
> - 读写文件、调用 API、执行脚本 → 直接用内置工具
> - 只有目标是**无 API 可用的本地 GUI App**（微信、飞书、Figma 等原生应用）时，才继续往下走

---

## 第一步：运行初始化脚本（每次任务开始执行一次）

```bash
bash <skill_dir>/scripts/init.sh
```

初始化输出独立工具目录。将输出中的路径记录为 `CU_DIR`；每个任务使用自己的目录，结束后只清理该任务目录。依赖或屏幕几何读取失败时停止，绝不猜缩放系数。

初始化做了三件事：
1. 检测 Retina 缩放因子，写入 `"$CU_DIR"/_cu_scale`
2. 编译 Swift CGEvent 滚动工具到 `"$CU_DIR"/_cu_scroll`
3. 安装截图辅助脚本 `"$CU_DIR"/_cu_snap.sh`，并打印当前可见进程名

初始化后可用的命令：
| 命令 | 作用 |
|------|------|
| `"$CU_DIR"/_cu_snap.sh out.png` | 截全屏（自动缩到逻辑分辨率） |
| `"$CU_DIR"/_cu_snap.sh out.png W H x y` | 截图后裁剪到 W×H 区域（节省 token） |
| `"$CU_DIR"/_cu_scroll x y amount` | 滚动（amount < 0 向下，> 0 向上） |
| `cat "$CU_DIR"/_cu_scale` | 读取缩放因子 |

> 临时目录可能被系统清理，工具失效时重新初始化。多显示器跨屏操作前需分别核对坐标映射；当前辅助脚本不证明任意跨屏坐标正确。

---

## 感知-行动循环

```
1. _cu_snap 截图 → Read 读取
   └─ 优先裁剪到目标区域：只截需要看的部分，大幅减少 token 消耗
2. 定位目标
   └─ 优先：AX 元素名（osascript）
   └─ 其次：截图坐标（cu_snap 输出已是逻辑坐标，直接用于 cliclick）
3. 执行操作
4. sleep 0.3~1.5s 等渲染 → 再截图确认
5. 重复直到完成
```

---

## 截图

```bash
"$CU_DIR"/_cu_snap.sh /tmp/s.png              # 全屏
"$CU_DIR"/_cu_snap.sh /tmp/s.png 900 600 0 300  # 裁剪：宽900 高600 从(x=0,y=300)开始
```

未裁剪、未额外缩放的主屏截图坐标可直接作为逻辑坐标。裁剪后必须把裁剪起点加回：`屏幕坐标 = 图内坐标 + (x_offset, y_offset)`。例如裁剪起点 `(0, 300)`、图内目标 `(40, 50)`，点击应为 `(40, 350)`。多屏或宿主再次缩放图片时，先核对显示器原点与缩放比例，不能套用主屏坐标。

---

## 鼠标操作

```bash
cliclick c:960,490     # 单击
cliclick dc:960,490    # 双击
cliclick rc:960,490    # 右键
cliclick p             # 打印当前坐标（调试）
```

> ⚠️ `cliclick dd:x,y` 是开始拖拽，不是滚动。

---

## 滚动

```bash
# 向下滚到底部
for i in $(seq 1 8); do "$CU_DIR"/_cu_scroll 750 400 -20; sleep 0.05; done

# 向上滚
"$CU_DIR"/_cu_scroll 750 400 5
```

> ⚠️ 聊天类 App（飞书、微信、Slack）的输入框会抢占键盘焦点，
> End / PageDown 键会打字到输入框里。必须用 `_cu_scroll`，不能用键盘。
>
> 若 `"$CU_DIR"/_cu_scroll` 滚动无效果（MD5 前后截图不变）= 该临时副本没有辅助功能权限，
> 改用已授权的稳定版 `/opt/homebrew/bin/_cu_scroll`（见篇首权限说明）。

---

## 输入文字

```bash
# 英文
osascript -e 'tell application "System Events" to tell process "AppName" to keystroke "hello"'

# 中文（直接 keystroke 会乱码，必须走剪贴板）
echo -n "你好世界" | pbcopy
osascript -e 'tell application "System Events" to tell process "AppName" to keystroke "v" using command down'
```

---

## 按键

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
