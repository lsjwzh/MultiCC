# macOS 分级选路

先运行只读探测，再按它的 `choice` 与 `routes` 行动：

```bash
python3 skills/multicc-browser/scripts/browser_probe.py          # 人读摘要
python3 skills/multicc-browser/scripts/browser_probe.py --json   # 全量报告
python3 skills/multicc-browser/scripts/browser_probe.py --browser '/路径/Chromium.app'  # 额外检查指定浏览器
```

它只用标准库，macOS 11 自带的 `python3`（3.8）即可运行；不启动浏览器、不读 Profile、不下载任何东西。退出码 0 表示有可直接选用的**后台**路线，2 表示没有（此时按各路线的 `next` 说明缺什么后停止）。`agent-desktop` 永远不计入 `choice`。

## 档位

| 档位 | 系统 | 浏览器现状 | 默认路线 | 其他路线 |
|---|---|---|---|---|
| `unsupported` | ≤10.15 | — | 无；浏览器层放到受支持的 Mac | — |
| `legacy` | 11–12 | Chrome/Edge/Brave 冻结在 138（11）/150（12），不再有安全更新 | Browser Harness + 本机实测可运行的 Chromium + 专用 Profile | BrowserAct/OpenClaw 标 `not-recommended`：其托管浏览器跟随当前 Chromium，须本机 smoke 证明能启动后才用 |
| `transitional` | 13 | 当前 Chrome 仍支持 | BrowserAct（已安装时） | Browser Harness；OpenClaw 需自检 Gateway |
| `current` | 14+ | 全部支持 | BrowserAct（已安装时） | 同上 |

浏览器是否能在本机运行由每个 `.app` 的 `LSMinimumSystemVersion` 与架构切片（Intel 不能跑仅 arm64 的包）判定，不靠版本号表；声明缺失时标 `??`，以 smoke 为准。`local_browser_use.py start/smoke` 在启动前复用同一判定，声明不兼容会直接拒绝。探测会避开 Agent 守护的 CDP 端口并建议从 9331 起第一个空闲端口。

MultiCC Agent 在所有档位都只作**前台桌面**后备（14+ 用 ScreenCaptureKit 截屏，11–13 用 `screencapture`；元素操作接口相同）。它没有 DOM，不能证明网页操作成功，必须经用户明确同意并转交 `multicc-computer-use`。

## 取长补短（各家技能对照）

| 来源 | 采纳 | 不采纳 |
|---|---|---|
| Browser Use 官方技能 / Harness | CDP 专用浏览器；`BU_NAME` 命名 daemon 复用登录态；状态→动作→再取状态的循环 | 默认接管个人 Chrome；云端浏览器作为默认 |
| BrowserAct | 仅后台操作、禁止激活窗口；每个浏览器独立 Profile；登录/验证码交给用户；敏感动作逐项确认 | `chrome-direct` 接管个人 Chrome 作为默认 |
| OpenClaw 托管浏览器 | 显式命名的托管 Profile；页面变化后重新快照、旧引用作废 | 默认 `chrome` 扩展接管档案 |
| Hermes | 只在运行时真的暴露 `browser_*` 工具时使用 | 为浏览器再嵌套一个模型 Agent |
| MultiCC Agent / computer-use | 运行时探测平台并分层实现；拒绝原因明确；Esc 急停；一次一个会话 | 作为 CDP 失败的静默回退 |
| Harness `mac-approve` 等授权点击器 | — | 常驻自动点授权弹窗（可能批准不属于本任务的连接） |

## 版本依据

- [Chrome 138 为支持 macOS 11 的最后版本（MacRumors）](https://www.macrumors.com/2025/07/16/google-chrome-138-last-version-support-mac-big-sur/)
- [Chrome 150 为支持 macOS 12 的最后版本（9to5Google）](https://9to5google.com/2026/01/23/google-chrome-ending-support-for-macos-monterey-in-july-2026/)
- 开发机实测：Chrome 153 的 `LSMinimumSystemVersion` 为 `13.0`（2026-09-25）。

旧版本号只用于说明；判断以探测结果和目标机 smoke 为准。
