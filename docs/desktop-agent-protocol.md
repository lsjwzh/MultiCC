# Desktop agent 协议（跨平台契约）

「🖥 屏幕」的能力不来自 MultiCC 服务端，而来自**跑在用户图形会话里的那个 desktop agent**。
macOS 的实现是 `scripts/macos-agent/MultiCCAgent.swift`（Swift，`MultiCC Agent.app`），
Linux X11 的实现是 `scripts/linux-agent/`（C）；Windows 还没有，`native/remote/`（Rust 进程
`multicc-remote`）的画像表里如实登记成 `supported: false`。

这份文档是**给下一个平台实现看的契约**：照它实现，服务端、Web 前端、Flutter App、
标注→动作链路、坐标换算一个字都不用改——它们只认下面这些 op 和 reason，不认平台名。

配套阅读：`docs/remote-screen-process.md`（Node ⇄ `multicc-remote` 进程契约）、
`native/remote/`（画像与能力矩阵、唤屏、RFB/H.264 串流桥；业务都在这里）、
`src/remote-screen.js`（Node 转发层：只管惰性启动、看护和鉴权后原样转发）。

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
| Linux X11 | unix socket | `$XDG_RUNTIME_DIR/multicc-agent/agent.sock` | `SO_PEERCRED`，必须同 uid |
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

`reason` 的取值集合是**契约的一部分**，服务端直接拿它查文案（见 `native/remote/src/describe.rs`
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
| `no-display` | agent 连不上图形会话（Linux：X server；或 Esc 观察线程没连上） | 桌面 Agent 连不上这台机器的图形界面 |
| `wayland-session` | Linux 是 Wayland 会话（XWayland 连得上但会假成功，见 §7 Wayland） | 远程屏幕只支持 X11，请换 Xorg 会话 |
| `interrupted` | 多步注入半路被停（租约被 `release` 收回 / 请求方断开）；Esc 打断回的是 `user-stopped` | 操作被中途停下，可能已执行了一部分 |

半路被停的响应带 `outcome: "partial"`、`dispatched: "dispatched" \| "none"`、`retrySafe`
（只有一步都没发出去才为 true）——发出去一部分的输入**不能**被上层自动重试，否则前半段
会再打一遍。macOS 与 Linux 形状一致。失败响应里 `reason` 与 `error` 同值（老服务端只看
`error`）。

新增 reason 必须同时改这三处（服务端 `REASONS`、Web `ERR_KEYS`、本文档），否则用户看到裸 code。

## 4. op 契约

坐标一律是**主屏逻辑点**（logical points），不是物理像素、不是 RFB 像素。
服务端保证发过来的就是这个域；agent 自己负责换算成系统 API 需要的单位。

### 4.1 「🖥 屏幕」必须实现的 op

| op | 参数 | 语义 |
|---|---|---|
| `snap` | `path`, `crop?`, `jpeg?`, `quality?` | 把主屏（或 `crop` 指定的区域）截到 `path`。默认 PNG，**原生物理像素**，不要缩放 |
| `status` | — | 返回 `{ ok, screenLocked, accessibility, screenRecording, control: { leaseHolder, halted } }` |
| `click` | `x, y, button?('right'), count?(1-3)` | 在逻辑点上点击 |
| `move` | `x, y` | 移动指针 |
| `scroll` | `x, y, amount`（-50..50） | 在 `(x,y)` 处滚动 |
| `drag` | `x, y, x2, y2, ms`（80..3000） | 从 a 拖到 b |
| `type` | `text`（≤4000 字符） | 向当前焦点输入文本 |
| `press` | `keys`（如 `cmd+c` / `ctrl+c`，≤40 字符） | 按组合键。**键名是契约词表，跟 macOS 一致**：`delete` = 退格（Web 的 ⌫ 发的就是它），向前删除是 `forwarddelete` |
| `release` | — | 释放操作租约 |
| `resume` | — | 解除 Esc 急停 |
| `unlock` | — | 提交已保存的密码解锁（**只能由服务端唤屏路由触发**，见 §5） |

#### `snap` 的可选字段

`crop` / `jpeg` / `quality` 都是**后加的**，macOS 那份实现不认识它们 —— 这不重要，
因为服务端只在 `host.captureDirect` 存在时才发（也就是只在 Linux 上）。多出来的字段
是纯增量：新 agent 对老服务端、老 agent 对新服务端都仍然只走 `path`。

| 字段 | 语义 |
|---|---|
| `crop: {x, y, width, height}` | 只截这个矩形（逻辑点）。**顺序是先裁后编码**，不要先整屏编码再裁 |
| `jpeg: true` | 输出 JPEG 而不是 PNG。也可以只把 `path` 以 `.jpg`/`.jpeg` 结尾来表示 |
| `quality: 1..100` | JPEG 质量，缺省 60 |

响应相应扩展为 `{ ok, path, width, height, crop \| null, ms }`：`width`/`height` 是
**整屏**尺寸（裁剪前），`crop` 是实际生效的裁剪框 —— 前端要靠整屏尺寸把图上的点
映射回逻辑点，报成裁剪后的尺寸会让坐标整体偏移。

为什么把这个能力做成 op 的可选字段，而不是让服务端自己去裁：macOS 有 `sips`，Linux 没有
任何一个「一定在」的命令行图像工具，让服务端裁就等于要求用户装 ImageMagick。而 agent
手里本来就攥着帧缓冲，顺手裁切 + 编码还能少两次全屏拷贝。**能力跟着平台走**：
`native/remote/` 的画像只在非 macOS 上挂 `captureDirect`，抓帧路径按它的有无来选。

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

新平台还应提供一个原样透传模式（Linux 是 `multicc-agent --raw '<json>'`，缺省从 stdin
读一行）。它不是给用户用的，而是让一致性脚本能发**正常客户端永远不会发**的请求 ——
畸形 JSON、未知 op、缺字段、越权 —— 否则那些分支就只能靠读代码相信它们是对的。
CLI 与 socket 走的是同一个 socket、同一段解析，所以 CLI 上的断言对服务端等价。

## 5. 护栏——不是可选项

下面这些在 macOS 实现里是既有行为，新平台必须**同样**实现，否则「服务端只发白名单 op」
这层信任就落空了：

1. **单一操作租约**：同一时刻只允许一个 `session` 操作电脑；`click` 等要带
   `allowSystem: true` 才放行系统级注入；没有租约时回 `busy`。`release` 交还。
2. **Esc 急停（可选）**：若本机用户已经给 Agent 授权了输入监控（老版本留下的合适授权），
   按 Esc 立刻停掉一切注入，此后所有输入 op 回 `user-stopped`，直到 `resume`。这是「机器
   前的人」对「远程的人」的否决权。**新版本不再请求也不提醒输入监控权限**——停止本机操作
   的默认方式是聊天里的 ■ 停止按钮（取消当前轮次），Esc 只是已有授权下的加分项。
3. **锁屏拒绝**：`screenLocked` 为真时，输入 op 回 `screen-locked`。**不要让锁屏后的注入
   悄悄落到登录窗口上。**
4. **受保护 App**：密码框、系统设置/安全中心一类目标回 `protected-app`，拒绝自动操作。
5. **`unlock` 不是普通输入 op**：服务端 `buildInput` 的白名单里根本没有它
   （`native/remote/src/annotation.rs` 的输入白名单），只有唤屏路由能发，且要用户显式开了
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

### 6.1 H.264 串流（可选，优先于 RFB）

第三个 socket 推硬件编码的 H.264，`multicc-remote` 按帧转发到 `/ws/remote-screen?mode=h264`
（Node 只做鉴权后的字节搬运，见 `docs/remote-screen-process.md`），
浏览器用 WebCodecs 解码（`public/chat-remote-screen-h264.js`）。同一套帧格式以后也走
WebRTC DataChannel（P2P）；打洞失败时就走这条 WS——中继只用现有外网通道。

- 地址：macOS 为 `<agentDir>/h264.sock`（`MULTICC_AGENT_H264_SOCK` 可覆盖），同 uid 校验。
- Agent → 服务端，每帧 `[type u8][len u32 BE][payload]`：`1` config（JSON
  `{codec,width,height}`，宽高 = 主屏逻辑点）、`2` 关键帧、`3` 普通帧；后两种 payload 是
  `[µs 时间戳 u64 BE][Annex B]`，关键帧内联 SPS/PPS。只在画面变化时出帧；静止后对最后一帧
  补编两次（让文字变清晰）；收到关键帧请求时立即把最后一帧编成关键帧。
- 服务端 → Agent 只有三种定长消息：`0x4B`（要关键帧）、RFB KeyEvent（`4`+7 字节）、
  RFB PointerEvent（`5`+5 字节，坐标是逻辑点）。输入同样走 `handle()` 全部护栏。
  例外是不按键的悬停（mask 0 → 0）：画面里画的是远端真实光标，浏览器限频约 30 次/秒发来，
  Agent 只移动光标（不做逐 App 检查，但 Esc 急停 / 锁屏 / 其它会话租约照样拦，输入通道忙就丢这一次）。
- 丢帧而不断流：Agent 每个连接排队超过 4 帧、服务端 WS 积压超过水位，都只丢普通帧并等
  下一个关键帧。出不了首帧（无 socket / 无录屏授权）时服务端以 `1011` 关 WS，前端回退 noVNC。
- Flutter App（iOS/Android）同样连 `?mode=h264`，但解码在本机原生做：iOS 走 VideoToolbox
  （SPS/PPS → `CMVideoFormatDescriptionCreateFromH264ParameterSets`，Annex B 转 AVCC），
  Android 走 MediaCodec（`csd-0`/`csd-1` + Annex B 直送）。两端都解成 BGRA、统一降到
  ≤1280 宽再交给页面，和 RFB 的 framebuffer 共用同一套绘制与输入代码（见
  `app/lib/services/remote_screen_h264.dart`、`platform_h264_decoder.dart` 与
  `app/ios/Runner/H264Decoder.swift`、`app/android/.../H264Bridge.kt`）。积压超过 2 帧
  同样丢普通帧并回 `'K'`；H.264 建不起来或中途断流时先退 RFB（同路径不带 `mode`），再退
  JPEG 轮询——所以 App 对旧服务端/未开录屏授权的机器仍然可用。

### 6.2 P2P 直连（服务端可选，与 Agent 无关）

`/ws/remote-screen?mode=h264` 同时是 WebRTC 的信令通道（`native/remote/src/p2p.rs`；
迁移前是 Node + werift）：
服务端发 `{t:'rtc-hello', iceServers}`，浏览器建 DataChannel 并 `rtc-offer`，双方 trickle
`rtc-ice`；通道打开后服务端先发 `{t:'rtc-active', on:true}` 再把帧改走直连（并要一个关键帧），
直连断开发 `on:false` 退回这条 WS。浏览器在直连期间丢弃 WS 上残余的帧，输入也改走直连。

- DataChannel 上传的是与 `h264.sock` 相同的字节流，按 16KB 分片，浏览器流式拼回。
- 只用 STUN 探测公网地址，**从不使用 TURN/第三方中继**；打不通就一直走这条 WS——中继只用
  现有外网通道。`MULTICC_REMOTE_STUN`：逗号分隔的 `stun:`/`stuns:` 地址，默认小米 + Google
  STUN；设为空串 = 只在局域网直连。`MULTICC_REMOTE_P2P=0` 完全关闭直连。
- 依赖 `werift`（纯 JS）；未安装时自动只走中继，不报错。
- 浏览器直连失败按 5s / 15s / 60s 退避重试；画面全程由中继兜底，不黑屏。

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

### Linux X11（已实现：`scripts/linux-agent/`）

C，零第三方依赖（只用系统库 `X11 Xext Xtst Xss z jpeg`），五个源文件：`agent.c`（op 与
护栏）、`x11.c`（截图/注入/锁屏判定/Esc 观察）、`json.c`、`image.c`（PNG+JPEG 编码）、
`agent.h`。编译、验证、一致性测试各一条命令：

```sh
scripts/linux-agent/build.sh              # 编 agent 与测试靶子
scripts/linux-agent/verify.sh             # 容器里起 Xvfb 跑探针 + conformance.sh（不需要 Linux 主机）
DISPLAY=:0 scripts/linux-agent/conformance.sh   # 在真桌面上跑同一套
```

设计要点（每条都是踩过或差点踩到的坑，改之前先读）：

- **截图判据是像素，不是返回值**。容器/无头环境里 MIT-SHM 会「调用成功但整帧全黑」，
  只判 `Status` 会把黑屏当成功。`conformance.sh` 里那条「截图里真的有这个颜色」就是为此
  存在的：已知颜色画在已知位置，解码 PNG 去找它。
- **逻辑点 == 像素**。GNOME/KDE 在 X11 下的缩放是切 XRandR 模式，不是把更大的帧缩下来，
  所以 `logicalSize()` 直接返回物理尺寸，任何换算系数都会让坐标整体偏移。
- **中文输入靠临时改键映射**（`xdotool` 同款）。XTEST 只能发键码，发不出字符。还原动作
  **推到整串输完之后**：按一次还原一次的话，接收方收到 KeyPress 去反查 keysym 时映射
  已经变回去了——症状是「字打进去了但对方认不出」，最难查的一类。用轮换的一小撮空闲键码，
  避免给所有客户端反复刷 MappingNotify。
- **滚轮方向反着记**：`amount > 0` 是**向上**（契约跟 macOS 对齐），而 X11 的 button 4 才是上。
- **锁屏判定是尽力而为且偏保守**：焦点窗口的 `WM_CLASS` 命中已知锁屏程序，或 XScreenSaver
  报 `state=On` 且 `kind != ScreenSaverBlanked`（单纯熄屏不算锁）。判错的代价不对称：
  把「锁着」误判成「没锁」会把注入打到锁屏窗口上（绝不能发生），反过来只是多点一次不动。
  判据写进 `status.lockCheck` 便于现场排查。
- **敏感窗口只挡打字，不挡点击**（`type`/`press` 回 `protected-app`，`click` 照旧）。
  两件事混在一起会让「点一下控制中心」收到「屏幕已锁」这种把人带偏的错。
- **Esc 观察用 `XQueryKeymap` 轮询**，且间隔分两档：**有人持租约时 8ms，空闲时 150ms**。
  快档是为了不漏掉一次很轻的点按——人按 Esc 可以只按住 30~50ms，固定慢采样有实打实的
  概率整段跳过，而这是这套护栏里唯一不该有概率性失效的一条（漏掉的后果是「用户想停，
  我们没停」）；慢档是因为 agent 是长驻进程，空闲时每秒上百次定时唤醒没道理，而没人持
  租约时本来也没有东西可停。
  不用 XRecord：要额外扩展、要单独一条控制连接、没有干净的超时退出。不用 `XGrabKey`：
  会把 Esc 从用户正在用的程序手里抢走（`owner_events` 也救不了——被动抓取激活期间事件是
  报到抓取窗口的）。
  **两档切换必须即时**：空闲档一觉 150ms 比人按住 Esc 的 120ms 还长，睡姿不对就整次漏判，
  所以睡眠放在条件变量上，开始注入或拿到租约都要立刻叫醒观察线程。
  **注入期间照常采样，只排除「我们自己刚发的那个 Escape」**：早期写法是注入窗口内一律
  把「上次采样」置为按下，代价是紧接着的一次真按下不成边沿——现场表现为「点一下之后
  第一次按 Esc 停不下来」，且时灵时不灵。两个方向都有断言守着（`conformance.sh` 第 6 节）。
- **`unlock` 一律回 `{ ok:false, reason:'unlock-unsupported' }`**（契约 §5 第 5 条）：
  锁屏是另一个会话的窗口，够不到也不该够到。`features.unlock = false`。
- **没有 stream**：RFB 未做，前端自动回退 JPEG 轮询。`features.stream = false`。
- **没有 elementTree**：X11 没有可访问性树 API，要 AT-SPI2 得另起一个总线会话，v1 不背。
- **每个连接线程一条 X 连接，线程收尾必须关**。X server 的客户端名额全桌面共用（约 256），
  漏关时第 255 次请求后不只是 agent 回 `no-display`，**用户桌面上任何新程序都打不开**。
  `conformance.sh` 第 8 节连发 300 次请求再断言「别的程序仍能连上 X」。
- **协议错误不退出**：Xlib 默认的错误处理器会 `exit()`，而「焦点窗口在我们 `XQueryTree`
  的那一刻被关掉」（BadWindow）是日常竞态。`x11_init()` 装一个只记录、不退出的处理器。
  I/O 错误（X server 没了）仍然退出 —— 会话都没了，agent 跟着走，下次登录由自启拉起。
- **Esc 要打断进行中的注入，而不只是挡住下一次**：逐字 `type`、逐步 `drag`、逐格 `scroll`、
  多击 `click`、逐键 `press` 每一步之前都问一次「该停了吗」（急停 / 租约被收回 / 请求方
  断开），停下时由**注入线程自己**松开它按住的键与鼠标键、还原临时键位。请求方断开也算：
  服务端超时后断开 socket，之后还在打的字没人等，用户再发一遍就是重复输入（所以服务端给
  `type` 的超时按字数放大）。
- **输入串行**：同一时刻只有一个线程注入，后来的最多排 3 秒，等不到回 `busy`。不串的话两段
  `type` 会逐字交错，交错进来的若是 `ctrl+w` 就是误关标签页。不无限排队：排在后面的请求，
  发起方多半已经超时走了。
- **Esc 观察线程不在 = 拒绝一切输入**（`no-display`）。agent 可能比 X 先起来，所以观察线程
  连不上会每秒重试，`status.control.escWatch` 报它在不在。
- **安装与自启**：`sh scripts/linux-agent/install.sh install`（编译 → `~/.multicc/agent/` →
  XDG autostart → 立即拉起；`uninstall` / `status` 同理）。用 XDG autostart 而不是
  systemd 用户单元，是因为后者只有在桌面环境主动 import 时才有 `DISPLAY`/`XAUTHORITY`。
  与 macOS 不同，**服务端不会自动安装**（要本机编译）；连不上 agent 时前端会把这条命令
  （画像里的 `installHint`）给用户。`install-smoke.sh` 在容器里验「装好了却用不了」那类半安装。
- **安全边界比 macOS 少一层**：X11 没有权限模型——任何能连上 display 的客户端都能看能点。
  所以剩下的全部边界是：`0700` 目录 + `0600` socket + `SO_PEERCRED` 同 uid + 封闭的 op 集合
  + `snap` 路径必须是绝对路径、不含 `..`、是 `.png/.jpg/.jpeg` 且已存在时是普通文件（不跟符号链接）。**这一点必须在用户文档里明说**，它和 macOS
  「一次性授权」不是一回事。

### Wayland（不做，这是产品差异不是实现细节）

macOS 那套做法**不可能**。没有全局截图、没有全局注入，唯一正路是 portal：
  - 截图 `org.freedesktop.portal.ScreenCast` → PipeWire 流；
  - 输入 `org.freedesktop.portal.RemoteDesktop`（底层 libei/EIS，GNOME 45+/KDE 6 可用）；
  - 两者都**带用户同意弹窗**（可记住授权）。因此「无感 agent」的模型不成立，
    这是产品体验差异，不是实现细节，必须提前说清楚。
  - 逃生口只有 `ydotool`（uinput，需 root/udev 规则）与 `wtype`（仅 wlroots）。
  - 附带影响：portal 给的是**视频流**而非静止帧，JPEG 轮询那条路要改成「从 PipeWire 拉一帧
    再编码」，这反而更贴 RFB 那条链路。
- 修饰键是 **Ctrl**。
- **XWayland 是假成功陷阱**：Wayland 会话里确实存在一个 X server，`DISPLAY=:0` 连得上、
  `XOpenDisplay` 成功 —— 但它只是一个兼容层，看不到原生 Wayland 窗口（截图出来是空的或
  只有 XWayland 应用），注入也只对 XWayland 应用有效。所以**不能只看连接成功**：agent
  连上之后先认 XWayland（X server 报 `XWAYLAND` 扩展，或环境里 `XDG_SESSION_TYPE=wayland` /
  `WAYLAND_DISPLAY`），认出来就把所有 op 回 `wayland-session`，前端提示换 Xorg 会话。
  扩展名那条是主判据：从自启拉起时环境变量不一定在。

> Linux 画像的 `supported` 是 **true**，Wayland 会话里也照报 true：此时 agent 在 `status`
> 与每个 op 上明说 `wayland-session`（附命中的是哪条判据），比笼统的「整个平台不支持」好
> 排查得多，也不会假成功。

## 8. 服务端如何判断「这台机器能做什么」

`native/remote/src/host.rs` 的画像表是唯一出处（Node 只把它转发出来），`GET /api/remote-screen/capabilities`
把它原样吐给前端。`supported: false` 时三条路由（frame/input/snapshot）与唤屏路由都干净地回
`503 / 409 platform-unsupported`，**不会去连一个不存在的 socket**；前端据此不显示 🖥。

> Node 回退后端（`MULTICC_REMOTE_SCREEN_BACKEND=node`，见 remote-screen-process.md §7）不经过
> `host.rs`，而是用迁移前留在 `src/desktop-host.js` 的同一张画像表；回退存在期间两边改动要同步，
> 回退删除后以 `host.rs` 为准。

判断「能不能做某件事」要按 **feature 名**判，不要按平台名判——平台名会把「Linux 支持远程屏幕」
错读成「Linux 支持唤屏」。唤屏路由的 `supported` 用的是 `features.wake`（Linux 为 false）：
判成 `profile.supported` 的话，前端会显示一个「唤起屏幕」按钮，点下去永远报
`auto-unlock-disabled`，而从按钮文字上完全看不出原因。

新增一个平台 = 在那个文件里补一份画像 + 写一个说这套协议的 agent。**路由不用改。**
平台专有的壳外调用（`sips` / `osascript` / `caffeinate`）在 Linux 上一律抛
`wrong-platform-helper` 而不是去 exec 一个不存在的命令——静默 ENOENT 比明说难查得多。

能力矩阵（`features`）与 op 的对应关系：`view` → `snap`；`control` → `click/move/scroll/drag/type/press`；
`snapshot` + `annotate` → 服务端自己完成（截图 + 标注→动作）；`stream` → §6；`wake` → `caffeinate` 等价物；
`unlock` → `unlock`；`elementTree` → §4.2。
