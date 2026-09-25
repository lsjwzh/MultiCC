# mbrowser 命令参考

`mbrowser` 是 MultiCC 自带的浏览器执行层：零依赖 Node 程序，跑在 MultiCC 安装并放到 PATH 的 Node 22 运行时上（macOS 11+ 可用）。它自己启一台专用 Chrome，自己持 CDP 连接，不需要 Python、不需要第三方 CLI。

入口：`<skill_dir>/bin/mbrowser`（`<skill_dir>` 通常是 `~/.agents/skills/multicc-browser`）。本文用 `MB=<skill_dir>/bin/mbrowser` 简写。

## 架构与状态

- **每个 profile 一个常驻守护进程**：detached 后台进程，CLI 退出、MultiCC 重启都不影响它；它负责启动并持有专用 Chrome、保持唯一一条 CDP WebSocket、维护元素引用表、Chrome 死掉自动拉起。
- **Chrome 是 detached 启动的**，所以守护进程重启/升级后会**重新接管**同一台 Chrome，标签不丢。
- Chrome 用**独立 `--user-data-dir`** + loopback `--remote-debugging-port=0`（真实端口从 profile 目录的 `DevToolsActivePort` 读取）。因为是独立数据目录，Chrome 不会弹 “Allow remote debugging?” 对话框，个人 Chrome 也永远不会被接管。
- CLI 通过 **0600 的 unix socket** 连接守护进程；状态在 `${MULTICC_DATA_DIR:-~/.multicc}/browser/` 下。
- 多个 profile（多账号）可同时运行，各自一台 Chrome + 一个守护进程。
- 每个 MultiCC 会话（`MULTICC_SESSION_ID`）在同一 profile 的 Chrome 里拥有自己的后台标签，会话之间互不可见。
- 默认 headless；`login` 会把该 profile 切成有头模式，`start NAME --headless` 再切回后台。
- 输入是真实 CDP 输入（元素中心 `Input.dispatchMouseEvent`，文本/按键走 `Input.insertText` / `dispatchKeyEvent`，带 JS 回退）；**不聚焦窗口**，需要焦点时用 `Emulation.setFocusEmulationEnabled`，不会把窗口拉到前台。

## 全局参数

| 参数 | 说明 |
|---|---|
| `-p, --profile NAME` | 目标 profile，默认取 `MBROWSER_PROFILE`，再默认 `default`。名字规则 `[A-Za-z0-9][A-Za-z0-9_-]{0,63}` |
| `--json` | 机器可读输出，便于脚本解析（字段以实际输出为准） |
| `--tab TARGET` | 对这一条命令指定要操作的自己的标签（`TARGET` 见下） |
| `-h, --help` / `--version` | 打印用法 / 版本（`VERSION` 是 `lib/*.js` 内容的 sha1，守护进程据此判断要不要自升级） |

未知的 `--flag` 是用法错误（退出码 2），不会被静默忽略——打错一个字母不会被当成合法开关继续跑。

## 生命周期

| 命令 | 说明 |
|---|---|
| `doctor` | 只读体检：OS 版本/档位、架构、Node 版本、找到的浏览器及其与该系统最低版本和架构的匹配、最终选用的可执行文件、正在运行的 profile |
| `profiles` | 列出 profile |
| `start [NAME] [--create] [--headed\|--headless] [--browser PATH] [--mock-keychain] [--startup-timeout S] [--force]` | 启动 profile。`start` 只对**已存在**的 profile 生效，新建必须加 `--create`；页面类命令只会自动启动**已存在**的 profile。`--force` 用于把 Chrome 重启成另一种模式（默认会拒绝） |
| `login NAME [URL]` | 把该 profile 重启成有头模式并打开 URL，交给用户登录/扫码 |
| `attach NAME --cdp-url http://127.0.0.1:PORT` | 登记一台外部启动的调试 Chrome；mbrowser 不启动也不杀它。换一个 `--cdp-url` 会先退休旧守护进程（它只为启动时的那个端点服务）：旧守护进程本来就不拥有那台 Chrome，会原样留着；如果旧守护进程自己起过 Chrome，则会把那台停掉（新配置里已经没有它的把手了）。端点连不上就报错，不会拿旧浏览器冒充 |
| `status [NAME]` | 守护进程/Chrome/端口/标签状态（`--all` 等价于 `profiles`） |
| `stop [NAME\|--all] [--keep-chrome]` | 停掉 profile 的守护进程和它自己启动的 Chrome（外部 `attach` 的不动）；`--keep-chrome` 只退守护进程、Chrome 留着，下一条命令会**重新接管同一台** Chrome |
| `ping [NAME]` | 打印守护进程元数据（socket、pid、chromePid、restarts、version）；守护进程没起就顺手起一个（要求 profile 已存在） |

profile 目录：macOS 是 `~/Library/Application Support/MultiCC/browser-use/<name>`（与旧的本地 Browser Use 同一批目录，已有登录态可直接沿用），其它平台是 `~/.multicc/browser/profiles/<name>`。

## 页面命令

默认作用于**本会话在当前 profile 里的当前标签**。

| 命令 | 说明 |
|---|---|
| `open URL [--new-tab]` | 打开/导航；不带 `--new-tab` 时复用当前标签 |
| `snapshot [--interactive] [--max-chars N]` | 无障碍树文本 + `[e12]` 引用；`--interactive` 只留可交互元素 |
| `click REF` / `click --xy X Y [--double\|--right]` | 按引用或坐标点击 |
| `type REF TEXT [--clear] [--submit]` | 输入文本；`--clear` 先清空，`--submit` 输入后回车 |
| `press KEY` | 按键：`Enter`、`Tab`、`Escape`、`ArrowDown`、`ctrl+a`、`cmd+a` … |
| `select REF VALUE_OR_LABEL` | 选择下拉项（按 value 或可见文本） |
| `hover REF` | 悬停 |
| `scroll [up\|down\|left\|right] [PIXELS] [--ref REF]` | 滚动页面或某个元素 |
| `upload REF FILE…` | 给文件输入框选文件（属上传动作，须用户确认） |
| `screenshot [OUT.png] [--full] [--ref REF]` | 截图并打印文件路径 |
| `text [--ref REF] [--max-chars N]` | 读页面/元素文本 |
| `eval JS` | 在页面里执行 JS |
| `wait (--text T \| --selector CSS \| --load \| --idle \| --ms N) [--timeout SEC] [--quiet-ms N]` | 等待文本/选择器/加载完成/网络空闲/固定时长（`--quiet-ms` 是 `--idle` 的静默窗口，默认 500ms） |
| `back` / `forward` / `reload [--hard]` | 历史与刷新（`--hard` 带 `ignoreCache`，绕过缓存） |
| `tabs` | 列出本会话拥有的标签 |
| `tab TARGET` | 切换本会话的当前标签 |
| `close [TARGET]` | 关闭本会话的标签（默认当前） |
| `dialog accept\|dismiss [PROMPT_TEXT]` | 处理 JS 对话框；有待处理对话框时其它命令会先警告 |

## 快照格式与引用语义

```text
page: Sign in — https://example.com/login
- heading "Sign in" [level=1]
- textbox "Email" [e1] value="ada@example.com"
- textbox "Password" [e2]
- button "Sign in" [e3] disabled
- link "Forgot password?" [e4]
- text "No account yet?"
```

（示例，标题/角色名/状态以实际无障碍树为准；`text` 行是合并后的静态文本。）

- 首行是 `page: <标题> — <URL>`（用 `--tab` 时还会带 `[tab …]`），其余每行是 `- 角色 "名称" [eN] 状态`，缩进两级空格表示层级。
- 引用只给**可交互**的元素（button/link/textbox/… 且有 DOM 节点），`heading`/`text` 这类内容行没有 `[eN]`；`value=` 只在非空时出现，状态可能是 `disabled` / `checked=true` / `[level=1]` 等。
- 引用**只在下一次对该标签快照之前有效**。页面一变（导航、展开、异步渲染）就重新 `snapshot`；用过期的引用会报错并提示 “take a new snapshot”，不会当成“差不多位置”去点。
- 所以要按固定循环走：`open` → `snapshot` → 按引用操作 → `wait` → 重新 `snapshot` → 验证。不要凭上一次的引用盲点，也不要用退出码 0 当作操作成功。

## 标签归属

- 每个 MultiCC 会话在 profile 里只有自己的后台标签；`tabs` / `tab` / `close` 只认自己拥有的。
- 自己标签打开的子窗口（popup）自动归自己。
- 不要 `close` 或操作别的会话的标签；`TARGET` 归属不明就停下确认。

## 环境变量

| 变量 | 作用 |
|---|---|
| `MULTICC_NODE` | 指定跑 mbrowser 的 Node（须 ≥22）；正常情况不用设，MultiCC 会把自己的 Node 放到 PATH |
| `MBROWSER_PROFILE` | 默认 profile 名（等价于 `-p`） |
| `MULTICC_DATA_DIR` | 状态根目录，默认 `~/.multicc`；守护进程/套接字/日志都在 `<DIR>/browser/` 下 |
| `MULTICC_SESSION_ID` | 会话标签归属；MultiCC 会话内自动带上（缺省时算 `cli`） |
| `MBROWSER_CHROME` | 指定 Chrome/Chromium 可执行文件或 `.app`（优先级低于 `--browser`） |
| `MBROWSER_PROFILES_DIR` | 把 profile 目录整体搬到别处（测试/换盘用） |

## 排错

- **命令超时 / CDP 一直不就绪**：先看钥匙串——新 profile 首次启动可能被 “Chrome Safe Storage” 授权对话框挡住（headless 下没人应答）。请在 GUI 里应答后重试；仅 smoke/全新 profile 可用 `--mock-keychain`（按 profile 记在 `.multicc-mock-keychain`，带 `.multicc-seeded` 的 profile 拒绝）。其次是首次 Rosetta 启动慢：本机实测（headless、全新 profile、`--mock-keychain`）系统 Chrome 153 冷启 0.5–1.1s，Chrome for Testing 138 约 5.4–6.8s、150 约 5.1–5.7s；首次从 Rosetta 走的 138 可能到 28s。之后每条命令都复用常驻连接，不要靠反复重启掩盖。
- **`--browser` 指错了**：守护进程启动失败时日志尾部的原因会被直接报出来（如 `browser_missing: --browser points at …, which does not exist`），不用再自己翻日志。
- **profile 不存在**：所有会起 Chrome 的命令（页面命令、`ping`）都只对**已存在**的 profile 生效并报 `not_created`；只有 `start NAME --create` / `login NAME --create` 会新建，避免打错的 `-p` 静默生成一个空 profile。
- **profile 被另一个 Chrome 占用**：说明同一个人数据目录已被别的进程打开（可能是旧的 Browser Harness/`local_browser_use.py` 或你自己的另一次启动）。换一个 profile，或先正常停掉那个进程；**不要删目录**（登录态在里面）。
- **守护进程/Chrome 卡住**：`stop NAME` 再 `start NAME`。Chrome 是 detached 的，守护进程重启会重新接管它，标签和登录态都不丢。
- **引用报 “take a new snapshot”**：正常现象，页面变了；重新 `snapshot` 拿新引用。
- **日志**：`${MULTICC_DATA_DIR:-~/.multicc}/browser/run/<name>.log`（含 Chrome 启动输出与守护进程日志）。

## 与其它执行层的关系

- `skills/multicc-browser/references/browser-use-local.md` 里的 Python Browser Harness 与 mbrowser **共用同一批专用 profile 目录**，但两者不能同时打开同一个 profile；要切回 mbrowser 前先停掉 Harness 的浏览器进程。
- BrowserAct / OpenClaw / Hermes 都只是用户明确点名时的备选，路由与档位见 [macOS 分级选路](macos-tiers.md) 与 [SKILL.md](../SKILL.md)。
