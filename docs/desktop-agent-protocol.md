# Desktop agent 协议（跨平台契约）

「🖥 屏幕」的能力不来自 MultiCC 服务端，而来自**跑在用户图形会话里的那个 desktop agent**。
macOS 的实现是 `scripts/macos-agent/MultiCCAgent.swift`（Swift，`MultiCC Agent.app`）；
Windows 与 Linux 还没有，`src/desktop-host.js` 里如实登记成 `supported: false`。

这份文档是**给下一个平台实现看的契约**：照它实现，服务端、Web 前端、Flutter App、
标注→动作链路、坐标换算一个字都不用改——它们只认下面这些 op 和 reason，不认平台名。

配套阅读：`src/desktop-host.js`（画像与能力矩阵）、`src/remote-screen.js`（服务端）、
`src/remote-screen-wake.js`（唤屏）、`src/remote-screen-rfb-bridge.js`（串流桥）。

---

## 1. 为什么是「每平台一个 agent」，不是「服务端直调系统 API」

点击与截图只能到达**已登录用户自己的图形会话**，且系统把权限授予**特定程序**。
把这件事散在服务端（散成一堆 `osascript` / P/Invoke / XTest 调用）有三个后果：
权限要按「每次调用它的进程」重复授一次；越权面变成整个 MultiCC server；平台差异长进路由里。

所以边界是：**agent 是唯一碰系统 API 的进程，服务端只跟它说固定的一小段 JSON。**

## 2. 传输

| 平台 | 传输 | 地址 | 对端校验 |
|---|---|---|---|
| macOS | unix socket | `~/.multicc/agent/agent.sock`（`MULTICC_AGENT_SOCK` 可覆盖） | `getpeereid`，必须同 uid |
| Linux (计划) | unix socket | `$XDG_RUNTIME_DIR/multicc-agent/agent.sock` | `SO_PEERCRED`，必须同 uid |
| Windows (计划) | 命名管道 | `\\.\pipe\multicc-agent` | 管道 ACL 只给当前用户 |

- 目录 `0700`，socket `0600`（Windows：管道 ACL 等价）。
- **不监听 TCP。** 跨机器不是这一层的职责——服务端已经有 tunnel / relay，远程访问鉴权在
  HTTP/WS 层（`ACCESS_TOKEN` / ws-ticket），agent 永远只听本机。
- 帧率与并发：agent 必须能处理**同时多个连接**（前端轮询、唤屏状态探测、标注重拍会并发）。

## 3. 报文格式

一行 JSON 进，一行 JSON 出，`\n` 结尾。**没有握手、没有版本协商**（版本靠 op 的存在性探测）。

请求：

```json
{ "op": "click", "session": "remote-screen", "x": 640, "y": 360, "allowSystem": true }
```

响应，成功：

```json
{ "ok": true }
```

失败：**永远用 `ok: false` + `reason` 表达，不要用协议的传输层错误**（断连等于「agent 没了」，
前端会退化成 `agent-unreachable`，用户看到的是「Agent 未运行」这种误导性文案）。

```json
{ "ok": false, "reason": "screen-locked" }
```

`reason` 的取值集合是**契约的一部分**，服务端直接拿它查文案（见 `src/remote-screen.js`
的 `REASONS` 与 `public/chat-remote-screen.js` 的 `ERR_KEYS`）：

| reason | 含义 | 前端文案 |
|---|---|---|
| `screen-locked` | 屏幕已锁定，需要用户先解锁 | 屏幕已锁定 |
| `user-stopped` | 本机用户按了 Esc 急停 | 本机按了 Esc 急停，点「解除急停」后才能继续操作 |
| `busy` | 另一个会话持有操作租约 | 另一个会话正在操作电脑 |
| `protected-app` | 目标是受保护 App（密码框 / 系统设置） | 需本人操作 |
| `accessibility-not-granted` | 缺输入注入授权（macOS：辅助功能） | — |
| `screen-recording-not-granted` | 缺屏幕捕获授权（macOS：屏幕录制） | — |
| `agent-unreachable` | 由**服务端**在连不上时产生，agent 不用回 | MultiCC Agent 未运行 |
| `platform-unsupported` | 由**服务端**在 `supported:false` 时产生 | 这台机器上的桌面 Agent 还不支持远程屏幕 |

新增 reason 必须同时改这三处（服务端 `REASONS`、Web `ERR_KEYS`、本文档），否则用户看到裸 code。

## 4. op 契约

坐标一律是**主屏逻辑点**（logical points），不是物理像素、不是 RFB 像素。
服务端保证发过来的就是这个域；agent 自己负责换算成系统 API 需要的单位。

### 4.1 「🖥 屏幕」必须实现的 op

| op | 参数 | 语义 |
|---|---|---|
| `snap` | `path` | 把主屏截到 `path`（PNG，**原生物理像素**，不要缩放）。服务端自己裁切与压缩 |
| `status` | — | 返回 `{ ok, screenLocked, accessibility, screenRecording, control: { leaseHolder, halted } }` |
| `click` | `x, y, button?('right'), count?(1-3)` | 在逻辑点上点击 |
| `move` | `x, y` | 移动指针 |
| `scroll` | `x, y, amount`（-50..50） | 在 `(x,y)` 处滚动 |
| `drag` | `x, y, x2, y2, ms`（80..3000） | 从 a 拖到 b |
| `type` | `text`（≤4000 字符） | 向当前焦点输入文本 |
| `press` | `keys`（如 `cmd+c` / `ctrl+c`，≤40 字符） | 按组合键 |
| `release` | — | 释放操作租约 |
| `resume` | — | 解除 Esc 急停 |
| `unlock` | — | 提交已保存的密码解锁（**只能由服务端唤屏路由触发**，见 §5） |

### 4.2 可选（`features` 里声明）

| op | 对应 feature | 语义 |
|---|---|---|
| `see` | `elementTree` | 返回可操作元素树（macOS 用 AX；Windows 对应 UIA；Linux 对应 AT-SPI2） |
| `set` / `click-el` / `press`（元素版） | `elementTree` | 按元素 id 操作 |
| `ping` | — | 存活探测 |
| `request-permissions` | — | 弹系统授权引导（macOS 专属语义） |

> 注：`see` / `click-el` / `set` 目前只被 `multicc-computer-use` 技能经 **CLI** 调用，
> 不参与「🖥 屏幕」。新平台可以先不做，`features.elementTree = false` 即可。

### 4.3 CLI 镜像（第二接口，非本契约核心）

macOS agent 同时是 CLI：`multicc-agent click 10 20`、`multicc-agent status`，
被 `skills/multicc-computer-use/scripts/mcu.sh` 直接调用。新平台为保持技能可用应提供同名
CLI，但**服务端只走 socket**。CLI 的成功输出是一行 JSON（同 §3 的响应）。

## 5. 护栏——不是可选项

下面这些在 macOS 实现里是既有行为，新平台必须**同样**实现，否则「服务端只发白名单 op」
这层信任就落空了：

1. **单一操作租约**：同一时刻只允许一个 `session` 操作电脑；`click` 等要带
   `allowSystem: true` 才放行系统级注入；没有租约时回 `busy`。`release` 交还。
2. **Esc 急停**：本机用户按 Esc 立刻停掉一切注入，此后所有输入 op 回 `user-stopped`，
   直到 `resume`。这是「机器前的人」对「远程的人」的否决权。
3. **锁屏拒绝**：`screenLocked` 为真时，输入 op 回 `screen-locked`。**不要让锁屏后的注入
   悄悄落到登录窗口上。**
4. **受保护 App**：密码框、系统设置/安全中心一类目标回 `protected-app`，拒绝自动操作。
5. **`unlock` 不是普通输入 op**：服务端 `buildInput` 的白名单里根本没有它
   （`src/remote-screen.js` 的 `INPUT_OPS`），只有唤屏路由能发，且要用户显式开了
   「自动解锁」并已保存密码。新平台即使不能解锁，也必须**接受这个 op 并回 `ok:false` +
   合适的 reason**，而不是断连。
6. **不执行命令、不任意读写路径**：op 集合是封闭的。`snap` 的 `path` 必须落在调用方给的
   目录内（服务端的 `assistDir`）。

## 6. 串流（可选 feature：`stream`）

第二个 socket 跑**最小 RFB 3.8 服务**，浏览器用原版 noVNC 直连：

- 地址：macOS 为 `<agentDir>/rfb.sock`（`MULTICC_AGENT_RFB_SOCK` 可覆盖）。
- 安全类型 `None`：对端已由 MultiCC 服务端鉴权（同源 WS + ticket），agent 侧再校验同 uid。
  因为不开 TCP 端口，这层不做额外认证是**有意的**。
- 编码只发 `Raw`。帧来自一个持续捕获流，按 `RFB_DIV`（当前 2）渲染成 BGRA；
  逐帧做行差分，只发脏行、并把列范围收窄到 32px 块；只在收到
  `FramebufferUpdateRequest` 时发（天然背压，没有请求就没有字节）。
- 指针坐标按 `RFB_DIV` 从 RFB 像素映射回逻辑点。
- **输入事件（PointerEvent / KeyEvent）必须走和 §4 同一套 `handle()`**，让租约、Esc 急停、
  锁屏拒绝、受保护 App、终端输入同意全部照旧生效——串流不是绕过护栏的后门。
- socket 不存在（平台没有捕获能力 / agent 版本旧）时，服务端 `attachRfb` 会以
  `1011 rfb-unavailable` 关掉 WS，前端自动退回 JPEG 轮询。**这是正常降级，不是错误。**

## 7. 各平台实现要点

### macOS（已实现）

ScreenCaptureKit / CGWindowList 截图，CGEvent 注入，AX 元素树，`caffeinate` 唤屏，
`sips` 做图像处理，`osascript` 取桌面逻辑 bounds。授权在系统设置里一次性发给这个 `.app`。

### Windows（计划）

- 截图：DXGI Desktop Duplication 为主（快、按显示器），`Windows.Graphics.Capture`（WinRT，
  可为窗口级），GDI `BitBlt` 兜底。**系统不设捕获授权**——这里比 macOS 简单。
- 输入：`SendInput`。陷阱有二：
  - **UIPI**：普通完整性进程发不进提权窗口。解法是清单 `uiAccess="true"` + Authenticode
    签名 + 安装在 `Program Files`，或让 agent 整体提权运行。
  - **安全桌面**（UAC 提示、锁屏、Ctrl+Alt+Del）根本够不到。
- DPI/多屏：设 Per-Monitor-V2 DPI 感知，逻辑尺寸由 `GetDpiForMonitor` 得出，
  正好对上服务端 `X-Screen-Width` 那套「图上 1px = 1 逻辑点」的契约。
- 元素树：UIA。
- 实现语言：C#/.NET self-contained 单文件 exe（WinRT/UIA/Desktop Duplication 都是一等公民）。
- **v1 不做解锁**：`unlock` 一律回 `{ ok:false, reason:'screen-locked' }`（或专用 reason），
  `features.unlock = false`。真要做，需要一个 SYSTEM 级服务（SendSAS / 凭据提供程序）。
- 修饰键是 **Ctrl** → 画像 `modifier: 'ctrl'`，前端快捷键行据此把 `cmd+x` 换成 `ctrl+x`。

### Linux（计划）

必须分成两件完全不同的事：

- **X11**：截图 `XShm`/`XGetImage`，输入扩展 `XTEST`（`xdotool` 用的就是它）。
  注意 X11 **没有权限模型**——任何能连上 display 的客户端都能看能点，所以安全边界只剩
  MultiCC 自己的 token + 租约，和 macOS「一次性授权」不是一回事，要在文档里对用户说清。
  多屏与 DPI 比较乱，先只支持主屏、逻辑尺寸取 XRandR 报的值。
- **Wayland**：macOS 那套做法**不可能**。没有全局截图、没有全局注入，唯一正路是 portal：
  - 截图 `org.freedesktop.portal.ScreenCast` → PipeWire 流；
  - 输入 `org.freedesktop.portal.RemoteDesktop`（底层 libei/EIS，GNOME 45+/KDE 6 可用）；
  - 两者都**带用户同意弹窗**（可记住授权）。因此「无感 agent」的模型不成立，
    这是产品体验差异，不是实现细节，必须提前说清楚。
  - 逃生口只有 `ydotool`（uinput，需 root/udev 规则）与 `wtype`（仅 wlroots）。
  - 附带影响：portal 给的是**视频流**而非静止帧，JPEG 轮询那条路要改成「从 PipeWire 拉一帧
    再编码」，这反而更贴 RFB 那条链路。
- 修饰键是 **Ctrl**。

## 8. 服务端如何判断「这台机器能做什么」

`src/desktop-host.js` 的 `profileFor(platform)` 是唯一出处，`GET /api/remote-screen/capabilities`
把它原样吐给前端。`supported: false` 时三条路由（frame/input/snapshot）与唤屏路由都干净地回
`503 / 409 platform-unsupported`，**不会去连一个不存在的 socket**；前端据此不显示 🖥。

新增一个平台 = 在那个文件里补一份画像 + 写一个说这套协议的 agent。**路由不用改。**

能力矩阵（`features`）与 op 的对应关系：`view` → `snap`；`control` → `click/move/scroll/drag/type/press`；
`snapshot` + `annotate` → 服务端自己完成（截图 + 标注→动作）；`stream` → §6；`wake` → `caffeinate` 等价物；
`unlock` → `unlock`；`elementTree` → §4.2。
