# mbrowser 命令参考

`mbrowser` 是 MultiCC 自带的浏览器执行层：零依赖 Node 程序，跑在 MultiCC 安装并放到 PATH 的 Node 22 运行时上（macOS 11+ 可用）。默认 profile `main` 是用户的日常 Chrome，经 MultiCC 的 CDP 网关操作；需要隔离时它也能自己启一台专用 Chrome。不需要 Python、不需要第三方 CLI。

入口：`<skill_dir>/bin/mbrowser`（`<skill_dir>` 通常是 `~/.agents/skills/multicc-browser`）。本文用 `MB=<skill_dir>/bin/mbrowser` 简写。

## 架构与状态

- **`main`（默认）= 用户的日常 Chrome**。只经 MultiCC 的 CDP 网关 `multicc-cdpd` 连接（`ws://127.0.0.1:<port>/cdp/<token>?activePort=default&lane=mbrowser-main`）：网关对这台 Chrome 只保留一条已授权的连接，所以 Chrome 144+ 的“允许远程调试？”只需用户点一次，守护进程重启、技能升级、别的会话都复用它；网关还给每个调用方独立的浏览器级会话，抢同一个标签返回 `cdp-target-busy`。主浏览器**绝不直连**（直连就是第二个弹窗）。
  - 它的远程调试是 `chrome://inspect/#remote-debugging` 里的开关（Chrome 136 起默认 profile 只能这样开），Chrome 把它记在 `Local State` 的 `devtools.remote_debugging.user-enabled`，重启后仍生效。
  - 主浏览器没在运行时，mbrowser 用主 profile **在后台**启动它（macOS `open -g -a "Google Chrome"`，Linux/Windows 直接起 `chrome`，都不带任何参数），等它打开调试端口后经网关连接。正在运行却没开调试时报 `main_not_debuggable`，绝不重启用户的浏览器。
  - mbrowser 永远不关闭、不重启、不激活主浏览器：`stop main` 只停守护进程，`set-mode`/`--headed`/`--headless` 对 main 一律拒绝；主浏览器被用户关掉后，守护进程不会自己把它重新打开，等下一条命令才会（后台）启动。
  - 网关二进制按这个顺序找：`$MULTICC_CDP_BIN` → `$MULTICC_RUST_ADDON` 同目录（MultiCC 会话都继承这个变量）→ `PATH`；网关已在运行时直接走它的 socket，不需要二进制。
- **每个 profile 一个常驻守护进程**：detached 后台进程，CLI 退出、MultiCC 重启都不影响它；它负责启动并持有专用 Chrome、保持唯一一条 CDP WebSocket、维护元素引用表、Chrome 死掉自动拉起。
- **Chrome 是 detached 启动的**，所以守护进程重启/升级后会**重新接管**同一台 Chrome，标签不丢。
- 专用 profile 的 Chrome 用**独立 `--user-data-dir`** + loopback `--remote-debugging-port=0`（真实端口从 profile 目录的 `DevToolsActivePort` 读取）。独立数据目录不会弹 “Allow remote debugging?” 对话框。
- **新建专用 profile 默认带主浏览器的登录态**：`start NAME --create` 先经网关从运行中的主浏览器读出全部 cookie（`Storage.getCookies`），新 Chrome 起来后写进去（`Storage.setCookies`，被拒的批次逐条重试），并写 `.multicc-seeded` 标记。不复制文件，所以不需要用户退出主浏览器（运行中复制 Cookies 库会得到一个静默掉登录的副本）；cookie 不落盘中转。localStorage 令牌和 Google 账号会话不随 cookie 迁移。读不到主浏览器时直接报错、不留下半个 profile。`--blank` 才是空白 profile，只在用户明确说不要现有登录信息时用。
- CLI 通过 **0600 的 unix socket** 连接守护进程；状态在 `${MULTICC_DATA_DIR:-~/.multicc}/browser/` 下。
- 多个 profile（多账号）可同时运行，各自一台 Chrome + 一个守护进程。
- 每个 MultiCC 会话（`MULTICC_SESSION_ID`）在同一 profile 的 Chrome 里拥有自己的后台标签，会话之间互不可见。
- 先用 `profiles` 选已有账号目录，运行中直接后台复用，**不管它是有头还是无头都不切模式、不重启**。**冷启动（浏览器没在跑）永远无头**，上次 `login` 留下的有头设置不会让它弹窗；正在运行的有头浏览器按原模式继续，原地后台操作即可。「后台」= 不激活、不置前，不是「关窗口」：窗口留在屏幕原处不算打扰，抢焦点才算。`profiles` / `doctor` 会把**当前真的在屏幕上开着窗口**的 profile 标成 `[window on screen]`——那是避让清单（别激活、别重启、别关别人的），不是清理清单。
- 输入是真实 CDP 输入（元素中心 `Input.dispatchMouseEvent`，文本/按键走 `Input.insertText` / `dispatchKeyEvent`，带 JS 回退）；**不聚焦窗口**，需要焦点时用 `Emulation.setFocusEmulationEnabled`，不会把窗口拉到前台。

## 全局参数

| 参数 | 说明 |
|---|---|
| `-p, --profile NAME` | 目标 profile，默认取 `MBROWSER_PROFILE`，再默认 `main`（用户的日常 Chrome）。名字规则 `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`；`main` 是保留名 |
| `--json` | 机器可读输出，便于脚本解析（字段以实际输出为准） |
| `--tab TARGET` | 对这一条命令指定要操作的自己的标签（`TARGET` 见下） |
| `-h, --help` / `--version` | 打印用法 / 版本（`VERSION` 是 `lib/*.js` 内容的 sha1，守护进程据此判断要不要自升级） |

未知的 `--flag` 是用法错误（退出码 2），不会被静默忽略——打错一个字母不会被当成合法开关继续跑。

## 生命周期

| 命令 | 说明 |
|---|---|
| `doctor` | 只读体检：OS 版本/档位、架构、Node 版本、主浏览器状态（是否运行、远程调试是否打开）、CDP 网关状态、找到的浏览器及其与该系统最低版本和架构的匹配、最终选用的可执行文件、正在运行的 profile |
| `profiles` | 列出 profile（`main` 永远排第一） |
| `envs [DOMAIN_OR_URL]` | 列出 MultiCC 浏览器隔离插件里的全部隔离环境：`iso:<id>`、账号（插件身份名）、备注、所属插件、出口、可控程度（完全可控/只读/未运行）、用过的站点（历史访问次数）；带域名时只列用过它的环境 |
| `route URL_OR_DOMAIN` | 给出该站点该用哪个环境：唯一命中的隔离环境 / 多个候选（须问用户）/ 没有命中则 `main` |
| `sites [DOMAIN_OR_URL]` | 查哪些 profile 曾访问某个域名（登录态须在页面核对）（按最近使用排序，带账号标签）；不带参数时列出所有已记录的域名。数据来自站点登记表，`open` 成功后自动写入 |
| `tag NAME --domain D [--label L]` | 给 profile `NAME` 在域名 `D` 下打一个人类可读的账号标签（如邮箱/用户名），写进站点登记表；重复打标签会更新而不是追加 |
| `start [NAME] [--create [--blank]] [--headed\|--headless] [--browser PATH] [--mock-keychain] [--startup-timeout S] [--force]` | `start main`（或不带 NAME）：连接主浏览器，没运行就在后台启动它；main 不接受模式/浏览器类参数。其它 NAME：启动或复用专用 profile；`--create` 新建时默认导入主浏览器的 cookie，`--blank` 才建空白 profile。不指定模式时，沿用正在运行的浏览器；已停止的托管 profile 默认无头启动，忽略上次人工登录留下的有头配置。`start` 只对**已存在**的 profile 生效，新建必须加 `--create`；页面类命令只会自动启动**已存在**的 profile。显式 `--headed` / `--headless` 可切换模式并重启 Chrome；其它会话持有标签时默认拒绝，普通自动化不要用 `--force` 绕过 |
| `login NAME [URL]` | 只有必须用户亲手操作时才用。`login main URL`：只在主浏览器开一个后台标签，请用户自己切过去登录，不重启不置前。专用 profile：把该 profile 切成有头模式（会重启 Chrome），在后台标签打开 URL；用户自行切到窗口和标签登录/扫码。做完保持现状继续后台操作，不切回无头、不重启、不关窗口 |
| `attach NAME --cdp-url http://127.0.0.1:PORT` | 登记一台外部启动的调试 Chrome；mbrowser 不启动也不杀它。换一个 `--cdp-url` 会先退休旧守护进程（它只为启动时的那个端点服务）：旧守护进程本来就不拥有那台 Chrome，会原样留着；如果旧守护进程自己起过 Chrome，则会把那台停掉（新配置里已经没有它的把手了）。端点连不上就报错，不会拿旧浏览器冒充 |
| `status [NAME]` | 守护进程/Chrome/端口/标签状态（`--all` 等价于 `profiles`） |
| `stop [NAME\|--all] [--keep-chrome]` | 停掉 profile 的守护进程和它自己启动的 Chrome（外部 `attach` 的不动，`main` 的主浏览器永远不动）；`--keep-chrome` 只退守护进程、Chrome 留着，下一条命令会**重新接管同一台** Chrome |
| `ping [NAME]` | 打印守护进程元数据（socket、pid、chromePid、restarts、version）；守护进程没起就顺手起一个（要求 profile 已存在） |

主浏览器的目录：macOS `~/Library/Application Support/Google/Chrome`，Linux `~/.config/google-chrome`，Windows `%LOCALAPPDATA%\Google\Chrome\User Data`（`MBROWSER_MAIN_USER_DATA_DIR` 可改）。

专用 profile 目录：macOS 是 `~/Library/Application Support/MultiCC/browser-use/<name>`（与旧的本地 Browser Use 同一批目录，已有登录态可直接沿用），其它平台是 `~/.multicc/browser/profiles/<name>`。

### 站点登记表（哪个 profile 曾访问哪个站点）

`${MULTICC_DATA_DIR:-~/.multicc}/browser/sites.json`：`{ "<域名>": [{ profile, label, lastUsedAt }] }`。每次 `open` 成功后自动追加/更新当前 profile 在该域名下的记录（不用手动维护）；`tag NAME --domain D --label L` 额外写入人类可读标签。同一域名出现多条记录表示多个候选 profile，不证明账号不同或登录仍有效——用 `sites DOMAIN` 查出来，交给用户选，不要凑合选第一条。这张表只是"域名 → profile 名单"的索引，真正的登录态（cookie/storage）还是在各自的 Chrome `user-data-dir` 里，删这张表不影响登录态，删 profile 目录才会丢登录态。

## 隔离环境（`iso:<id>`）

隔离插件 = MultiCC 插件里同时有 `list`、`launch`、`browser-read` 命令的插件（目前是 `chrome-proxy-launcher`）。mbrowser 经 MultiCC 服务端的插件接口（`GET /api/plugins`、`POST /api/plugins/<id>/run`，地址取 `$MULTICC_BASE_URL`，默认 `http://127.0.0.1:3000`）读身份清单，不自己执行插件二进制。

- **账号与站点**：账号是插件身份名与备注；用过的站点读该身份 profile（`~/.multicc/plugins-data/<插件>/chrome-profiles/<id>/Default/`）里的 `History`（顶层访问过的网址，按站点汇总次数）和 `Cookies`（只读 `host_key` 列，不读值），都以 SQLite `immutable` 方式只读打开，不锁、不影响运行中的 Chrome。站点按可注册域名归并（`seller-us.tiktok.com` → `tiktok.com`）。
- **路由规则**：以历史访问为准，嵌入广告留下的 cookie 不算（只有读不到历史的环境才退回看 cookie）。一个环境命中 → 选它；多个 → `route_ambiguous`，交给用户选；没有 → `main`。不带 `-p` 的 `open` 自动执行这套路由，并把结果记为本会话的默认目标（`<state>/browser/routes.json`，一天过期），后续不带 `-p` 的命令跟随；显式 `-p` / `MBROWSER_PROFILE` 总是优先。MultiCC 服务端连不上时不路由，`open` 照常走默认 profile（stderr 提示一行）。
- **可控程度**：
  - `agent`：插件 1.7.0 起启动时默认登记 `multicc-browser-control-v1` 私有控制通道；所有页面命令经 `multicc-cdpd` 的共享连接和标签页租约执行。点击、输入、截图均可用，Chrome 不监听 TCP 调试端口；自动指纹关闭时同样可用。监督进程独占匿名管道，只读与控制请求编号互不干扰。网关重启后自动登记；实例重开生成新地址，旧守护进程退役但不关闭浏览器。
  - `cdp`：实例在运行、profile 目录的 `DevToolsActivePort` 指向的本机端口在听、且持有 profile 的进程就是插件记录的那个 → 用一个 attach 守护进程（`iso-<id>`）完全控制，端口变化时自动换新；不启动、不停止、不重启实例。
  - `read`：升级前已经启动的旧私有管道实例→ 经插件的只读接口 `multicc-browser-read-v1`：`open`（`open-page`，只接受无端口、无查询参数、无片段的 https 地址，后台标签）、`tabs --domain D[,D2]`（`pages`，该接口只列指定站点的页面）、`text` / `snapshot`（`read-page`，页面正文，无元素引用）。其它命令报 `iso_read_only`。
  - `stopped`：`iso_not_running`；只有显式 `start iso:<id> [URL]` 才会调用插件 `launch`（会开窗口，可能到前台）。
- `stop iso:<id>` 只停 mbrowser 的 attach 守护进程；`status`/`ping iso:<id>` 显示该环境概况；`login`/`attach`/`tag` 不适用于隔离环境。

## 页面命令

默认作用于**本会话在当前 profile 里的当前标签**。

| 命令 | 说明 |
|---|---|
| `open URL [--new-tab\|--new-window]` | 打开/导航；不带参数时复用本会话当前标签。`--new-tab` 建后台标签（主浏览器里在用户当前窗口的标签栏末尾，不切过去）；`--new-window` 建一个本会话专用的新窗口，不拿焦点、不置前（窗口可能出现在屏幕上）。会话还没有标签时，第一个标签就建在要求的位置并直接加载页面，不会先多开一个空白页 |
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
| `tabs` | 列出标签：`*` 当前、`mine` 本会话的、`other` 别的会话的、`user` 用户自己在主浏览器里开的 |
| `tab TARGET` | 仅切换本会话的操作目标，不激活窗口或前台标签 |
| `close [TARGET]` | 关闭本会话的标签（默认当前） |
| `dialog accept\|dismiss [PROMPT_TEXT]` | 处理 JS 对话框；有待处理对话框时其它命令会先警告 |

后台操作不调用窗口置前或标签激活，也不改模式：已运行的有头浏览器就在它原来的窗口和位置上直接后台操作，任何情况下都不要为了「后台执行」强制重启或切成无头。只有人工流程确实需要用户亲手操作时才使用 `login`（它会重启 Chrome，所以别当「看一眼」用）；做完继续在同一个窗口后台干活，不切回无头、不关窗口。扫码截图能完成时优先保持当前模式不动。

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
- 主浏览器里标 `user` 的是用户自己的标签：只在用户明确要求时用 `--tab` 指定来读/操作，不关闭、不导航走。
- 自己标签打开的子窗口（popup）自动归自己。
- 不要 `close` 或操作别的会话的标签；`TARGET` 归属不明就停下确认。

## 环境变量

| 变量 | 作用 |
|---|---|
| `MULTICC_NODE` | 指定跑 mbrowser 的 Node（须 ≥22）；正常情况不用设，MultiCC 会把自己的 Node 放到 PATH |
| `MBROWSER_PROFILE` | 默认 profile 名（等价于 `-p`，可以是 `iso:<id>`；不设时用本会话的路由结果，再默认 `main`） |
| `MULTICC_BASE_URL` | MultiCC 服务端地址，用来查隔离插件（MultiCC 会话自动带上） |
| `MBROWSER_ISO_DATA_ROOT` | 隔离插件数据根目录（默认 `~/.multicc/plugins-data`；测试用） |
| `MBROWSER_MAIN_USER_DATA_DIR` | 主浏览器的 user-data-dir（默认 Google Chrome 的标准位置；测试用） |
| `MBROWSER_MAIN_CHROME` | 主浏览器没运行时用来启动它的 `.app`/可执行文件 |
| `MULTICC_CDP_BIN` | `multicc-cdpd` 网关二进制（默认在 `$MULTICC_RUST_ADDON` 同目录或 `PATH` 里找） |
| `MULTICC_CDP_DIR` / `MULTICC_CDP_SOCK` | 网关目录 / socket（与 MultiCC 服务端一致，一般不用设） |
| `MULTICC_DATA_DIR` | 状态根目录，默认 `~/.multicc`；守护进程/套接字/日志都在 `<DIR>/browser/` 下 |
| `MULTICC_SESSION_ID` | 会话标签归属；MultiCC 会话内自动带上（缺省时算 `cli`） |
| `MBROWSER_CHROME` | 指定 Chrome/Chromium 可执行文件或 `.app`（优先级低于 `--browser`） |
| `MBROWSER_PROFILES_DIR` | 把 profile 目录整体搬到别处（测试/换盘用） |

## 排错

- **`route_ambiguous`**：多个隔离环境都用过这个站点。把候选（账号、出口）列给用户选，再用 `-p iso:<id>`；用户要用自己的浏览器就 `-p main`。
- **`iso_read_only`**：只读隔离环境不能点击/输入。请用户在那个窗口亲手做，或经同意改用桌面操作；不要换到别的浏览器做。
- **`iso_not_running`**：先问用户再 `start iso:<id>`。
- **`iso_restart_required` / `iso_read_failed`**：实例由旧版插件启动，页面接口对不上，请用户在插件里关闭后重新启动一次。
- **`multicc_unavailable`**：连不上 MultiCC 服务端，无法查隔离环境；检查服务或 `MULTICC_BASE_URL`。
- **`main_not_debuggable`**：主浏览器在运行，但远程调试没开。请用户打开 `chrome://inspect/#remote-debugging` 勾选“Allow remote debugging for this browser instance”（一次即可，重启后仍记得）。不要重启/强杀用户的浏览器。
- **Chrome 弹“允许远程调试？”**：网关第一次连这台 Chrome 时出现，请用户点一次「允许」。之后不会再弹；如果每条命令都弹，说明有东西绕过了网关直连 Chrome（检查是否有脚本自己连调试端口）。
- **`chrome_rejected` / `chrome_approval_timeout` / `chrome_cooldown`**：用户拒绝/没应答，网关进入冷却（30s 起按次数加倍）。别循环重试，先问用户。
- **`cdp_upstream_closed`**：主浏览器退出或重启了；下一条命令会重新连接（必要时在后台启动它，可能再弹一次授权）。
- **`gateway_unavailable`**：网关没在运行且找不到二进制。在 MultiCC 会话里运行 mbrowser，或设 `MULTICC_CDP_BIN`。
- **`main_launch_failed` / `main_missing`**：主浏览器没运行，后台启动失败或找不到 Google Chrome；设 `MBROWSER_MAIN_CHROME` 或请用户自己打开 Chrome。
- **命令超时 / CDP 一直不就绪**：先看钥匙串——新 profile 首次启动可能被 “Chrome Safe Storage” 授权对话框挡住（headless 下没人应答）。请在 GUI 里应答后重试；仅 smoke/全新 profile 可用 `--mock-keychain`（按 profile 记在 `.multicc-mock-keychain`，带 `.multicc-seeded` 的 profile 拒绝）。其次是首次 Rosetta 启动慢：本机实测（headless、全新 profile、`--mock-keychain`）系统 Chrome 153 冷启 0.5–1.1s，Chrome for Testing 138 约 5.4–6.8s、150 约 5.1–5.7s；首次从 Rosetta 走的 138 可能到 28s。之后每条命令都复用常驻连接，不要靠反复重启掩盖。
- **`--browser` 指错了**：守护进程启动失败时日志尾部的原因会被直接报出来（如 `browser_missing: --browser points at …, which does not exist`），不用再自己翻日志。
- **profile 不存在**：所有会起 Chrome 的命令（页面命令、`ping`）都只对**已存在**的 profile 生效并报 `not_created`；只有 `start NAME --create` / `login NAME --create` 会新建，避免打错的 `-p` 静默生成一个空 profile。
- **profile 被另一个 Chrome 占用**：先核对进程归属，优先复用已授权的专用浏览器连接。切换执行层须确认没有其它会话使用后正常停止原进程；不要为绕过锁新建空 profile、强杀进程或删锁/目录（登录态在里面）。
- **守护进程/Chrome 卡住**：`stop NAME` 再 `start NAME`。Chrome 是 detached 的，守护进程重启会重新接管它，标签和登录态都不丢。
- **引用报 “take a new snapshot”**：正常现象，页面变了；重新 `snapshot` 拿新引用。
- **日志**：`${MULTICC_DATA_DIR:-~/.multicc}/browser/run/<name>.log`（含 Chrome 启动输出与守护进程日志）。

## 与其它执行层的关系

- `skills/multicc-browser/references/browser-use-local.md` 里的 Python Browser Harness 与 mbrowser **共用同一批专用 profile 目录**，但两者不能同时打开同一个 profile；要切回 mbrowser 前先停掉 Harness 的浏览器进程。
- BrowserAct / OpenClaw / Hermes 都只是用户明确点名时的备选，路由与档位见 [macOS 分级选路](macos-tiers.md) 与 [SKILL.md](../SKILL.md)。
