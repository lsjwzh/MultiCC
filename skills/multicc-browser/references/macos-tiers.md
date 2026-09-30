# macOS 分级选路

先运行只读探测，再按它的 `choice` 与 `routes` 行动：

```bash
python3 skills/multicc-browser/scripts/browser_probe.py          # 人读摘要
python3 skills/multicc-browser/scripts/browser_probe.py --json   # 全量报告
python3 skills/multicc-browser/scripts/browser_probe.py --browser '/路径/Chromium.app'  # 额外检查指定浏览器
```

它只用标准库，macOS 11 自带的 `python3`（3.8）即可运行；不启动浏览器、不读 Profile、不下载任何东西（只读 `node -v`、`lipo`、app 内的 `Info.plist`）。退出码 0 表示有可直接选用的**后台**路线，2 表示没有（此时按各路线的 `next` 说明缺什么后停止）。`agent-desktop` 永远不计入 `choice`。

**所有档位的默认路线都是 MultiCC 自带的 `mbrowser`**（`<skill_dir>/bin/mbrowser`，跑在 MultiCC 安装的 Node 22 上）：探测只有在「有 Node ≥22」且「有能在本机运行的 Chromium-family 浏览器」时才会把它标成 `available` 并作为 `choice`。BrowserAct / OpenClaw / Browser Harness 一律是**用户明确点名才用**的备选，探测不会把它们标成 `available`——`which browser-act` 命中只说明 CLI 在 PATH 上。

## 档位

| 档位 | 系统 | 浏览器现状 | 默认路线 | 备选（opt-in） |
|---|---|---|---|---|
| `unsupported` | ≤10.15 | — | 无；浏览器层放到受支持的 Mac | — |
| `legacy` | 11–12 | Chrome/Edge/Brave 冻结在 138（11）/150（12），不再有安全更新 | **mbrowser** + 本机实测可运行的内核（11：Chrome ≤138、Chrome for Testing 138 `mac-x64`；12：≤150） | Browser Harness（标 `opt-in`）；BrowserAct/OpenClaw 标 `not-recommended`（其托管浏览器跟随当前 Chromium） |
| `transitional` | 13 | 当前 Chrome 仍支持 | **mbrowser** + 当前 Chrome/Edge/Chromium/Brave | Browser Harness / BrowserAct / OpenClaw（都标 `opt-in`/`installed-unverified`） |
| `current` | 14+ | 全部支持 | 同上 | 同上 |

浏览器是否能在本机运行由每个 `.app` 的 `LSMinimumSystemVersion` 与架构切片（Intel 不能跑仅 arm64 的包）判定，不靠版本号表；声明缺失时标 `??`，以 smoke 为准。Chrome for Testing 的 `mac-x64` 包在 Apple silicon 上走 Rosetta 可运行（实测 138 冷启约 5s，150 首次约 28s），真 Intel 机不会因架构被拒。`local_browser_use.py start/smoke` 在启动前复用同一判定，声明不兼容会直接拒绝。探测会避开 Agent 守护的 CDP 端口并建议从 9331 起第一个空闲端口（只给 Harness 这类仍要显式端口的路线用；mbrowser 自己用 `--remote-debugging-port=0` 由系统分配）。

MultiCC Agent 在所有档位都只作**前台桌面**后备（14+ 用 ScreenCaptureKit 截屏，11–13 用 `screencapture`；元素操作接口相同）。它没有 DOM，不能证明网页操作成功，必须经用户明确同意并转交 `multicc-computer-use`。

## 取长补短（各家技能对照）

| 来源 | 采纳 | 不采纳 |
|---|---|---|
| MultiCC `mbrowser`（本技能默认） | 专用 user-data-dir + loopback 端口；每 profile 一个常驻守护进程；每会话自己的后台标签；引用快照→操作→再快照；真实 CDP 输入但不聚焦窗口 | — |
| Browser Use 官方技能 / Harness | CDP 专用浏览器；`BU_NAME` 命名 daemon 复用登录态；状态→动作→再取状态的循环；与 mbrowser 共用同一批专用 Profile 目录 | 默认接管个人 Chrome；云端浏览器作为默认 |
| BrowserAct | 仅后台操作、禁止激活窗口；每个浏览器独立 Profile；登录/验证码交给用户；敏感动作逐项确认 | `chrome-direct` 接管个人 Chrome 作为默认；把 `which` 命中当作“已验证本地执行层” |
| OpenClaw 托管浏览器 | 显式命名的托管 Profile；页面变化后重新快照、旧引用作废 | 默认 `chrome` 扩展接管档案 |
| Hermes | 只在运行时真的暴露 `browser_*` 工具时使用 | 为浏览器再嵌套一个模型 Agent |
| MultiCC Agent / computer-use | 运行时探测平台并分层实现；拒绝原因明确；Esc 急停；一次一个会话 | 作为 CDP 失败的静默回退 |
| Harness `mac-approve` 等授权点击器 | — | 常驻自动点授权弹窗（可能批准不属于本任务的连接） |

## 版本依据

- [Chrome 138 为支持 macOS 11 的最后版本（MacRumors）](https://www.macrumors.com/2025/07/16/google-chrome-138-last-version-support-mac-big-sur/)
- [Chrome 150 为支持 macOS 12 的最后版本（9to5Google）](https://9to5google.com/2026/01/23/google-chrome-ending-support-for-macos-monterey-in-july-2026/)
- 开发机实测：Chrome 153 的 `LSMinimumSystemVersion` 为 `13.0`（2026-09-25）。
- Chrome for Testing `mac-x64` 实测（2026-09-25，Rosetta）：`138.0.7204.183` → `LSMinimumSystemVersion` 11.0，`150.0.7871.124` → 12.0，两个包都只有 x86_64 切片。

旧版本号只用于说明；判断以探测结果和目标机 smoke 为准。命令全表见 [mbrowser 命令参考](mbrowser.md)。
