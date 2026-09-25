# Browser Use 本地专用浏览器（Intel/macOS 11 候选路径）

Browser Use 官方 `browser-use` 技能调用 CLI；CLI 的本地执行层是官方 `browser-harness`，通过 CDP 连接 Chromium。默认接管个人 Chrome 会触发权限确认，也不能解决旧系统浏览器版本限制。MultiCC 的 `scripts/local_browser_use.py` 启动用户指定的兼容浏览器及专用 Profile，并把 CDP 地址交给 Harness；用户明确选择时可用 `seed` 将**已退出的**个人 Chrome 指定 Profile 一次性复制到专用目录。它不下载浏览器，也不启动云服务。

## 安装与预检

先运行 `python3 skills/multicc-browser/scripts/browser_probe.py`：它列出本机哪些 Chromium-family 浏览器声明可在此 macOS 运行，并给出带正确路径和空闲端口的 `smoke` 命令。`start`/`smoke` 启动前也会读取浏览器 `.app` 的 `LSMinimumSystemVersion`，声明不兼容时直接拒绝，不再等浏览器崩溃。未指定 `--port` 时默认 9331（避开 Agent 守护的 9222 与 Node 调试的 9229）。

在目标 Intel/macOS 11 上准备 Python 3.12、`browser-harness==0.1.13` 和**经过该机实测可运行**的 Chromium-family 可执行文件。推荐在独立 Python 环境里安装：

```bash
python3.12 -m venv "$HOME/.local/share/multicc-browser-use-venv"
"$HOME/.local/share/multicc-browser-use-venv/bin/python" -m pip install 'browser-harness==0.1.13'
"$HOME/.local/share/multicc-browser-use-venv/bin/browser-harness" --version
```

也可使用 `uv tool install --python 3.12 'browser-harness==0.1.13'`。Harness 是 Browser Use 官方 CLI 的底层项目，包本身不含浏览器内核；不要通过 `browser-use`/`browser-harness` 的默认本地连接接管个人 Chrome。当前完整版 `browser-use==0.13.10` 需要 Python ≥3.11，依赖 Harness 和 CDP 库，但依赖较多；在旧机器上先使用轻量 Harness 验证执行层。

浏览器候选应来自可信来源，例如 [Chrome for Testing 官方归档](https://googlechromelabs.github.io/chrome-for-testing/)的 `mac-x64` 构建；先核对 app 的最低 macOS 要求，再在目标机实际启动。这里**不指定一个未经目标机验证的“兼容版本”**，也不自动下载旧版。不要把当前 Chrome 安装包下载到 macOS 11 上硬跑，或从不明第三方获取旧包。即使旧 Chromium 能运行，停止安全更新后不适合放入真实账号；如必须使用，请按业务风险评估。

## 最小验收

在本机执行（将路径替换为实际兼容的浏览器和 Harness）：

```bash
python3.12 skills/multicc-browser/scripts/local_browser_use.py smoke \
  --browser '/Applications/Chromium.app/Contents/MacOS/Chromium' \
  --browser-use-bin "$HOME/.local/share/multicc-browser-use-venv/bin/browser-harness" \
  --port 9331 --headless
```

脚本为验收创建**临时** Profile，启动浏览器、访问内置 `data:` 页面、读取并核对标题、截图，然后关闭它启动的浏览器；成功输出 `PASS title=... screenshot=... log=...`。保留的输出目录含浏览器启动日志、Browser Harness 完整输出和 PNG，可供复核。失败会输出 `FAIL` 和日志路径。不能用单纯的 `--version` 或 wheel 标签代替这一验收。

## 首选：一次性复制个人 Profile，再使用专用浏览器

这条路径兼顾现有登录态与免逐次 CDP 授权：**专用 `--user-data-dir` 和专用 Chrome 进程**避免接管个人 Chrome 的授权弹窗，复制 Profile 只用于初始化登录态，不是免授权的技术原因。Browser Harness 已按 `BU_NAME` 复用后台 daemon；不需要另写常驻点击授权的 helper。

先完全退出源 Chrome，确认它的进程已结束。明确源 Profile 目录名（Chrome 的 `chrome://version` 中 Profile Path 最末级，通常是 `Default` 或 `Profile 1`），再执行一次：

```bash
python3.12 skills/multicc-browser/scripts/local_browser_use.py seed \
  --name account-one --source-profile 'Default' --confirm-source-closed
```

默认源目录是 `~/Library/Application Support/Google/Chrome`；其它位置加 `--source-user-data-dir '/绝对路径/用户数据目录'`。`seed` 只复制 `Local State` 和选中的 Profile（目标里命名为 `Default`），跳过缓存和进程锁，不改动源文件。目标必须尚不存在；**不会覆盖已有专用 Profile**。复制品仍包含 Cookie、浏览历史、站点数据等敏感信息，保存在 `~/Library/Application Support/MultiCC/browser-use/<name>`；只在用户明确同意迁移该身份时执行，不把该目录提交到仓库或上传。复制前应确认空间足够。

之后使用与源 Profile **同系列、兼容该 macOS 的浏览器版本**启动专用进程；不要用旧版浏览器打开新版 Profile（可能拒绝启动或损坏副本）。macOS Keychain/浏览器加密、版本差异或站点风控可能使部分 Cookie 无法解密或要求重新登录；复制成功不等于登录态成功。首次人工检查登录，停止再启动后复查。需要升级/换源时先另选新 `--name`，不要覆盖旧目录。

## 多账号持久登录

每个账号在各自终端以不同 `--name` 和 `--port` 运行 `start`（若需人工检查登录，不要使用 `--headless`）：

```bash
python3.12 skills/multicc-browser/scripts/local_browser_use.py start \
  --browser '/Applications/Chromium.app/Contents/MacOS/Chromium' \
  --name account-one --port 9331
```

另一个终端使用启动输出中的端点，例如 `BU_CDP_URL=http://127.0.0.1:9331 BU_NAME=account-one browser-harness`。第二个账号用 `--name account-two --port 9332`；对应的 Profile 固定存放在 `~/Library/Application Support/MultiCC/browser-use/<name>`，不在会被回收的 worktree。关闭启动终端只停止它创建的浏览器进程，Profile 不删除。不要让两个浏览器进程共享同一 Profile；同账号的多个页面应复用同一浏览器和 Harness daemon。CDP 仅绑定 loopback，不能转发到公网。

如果刻意改成接管个人 Chrome，Harness 的 `mac-approve` 可在弹窗出现时定向点击一次，但首次启用远程调试和授予 macOS 辅助功能权限仍需人工完成。不要运行常驻自动点击授权脚本；它可能批准不属于本次任务的连接。

## 新版 MultiCC Agent 与本路径的关系

仓库的 `scripts/macos-agent/MultiCCAgent.swift` 是登录用户会话内的独立 LaunchAgent。新版 Agent v2 能截图、观察 macOS AX 元素并按元素点击/输入，也能按配置守护**一个**本机 Chrome CDP 端口；`multicc-computer-use` 技能的 `scripts/mcu.sh` 提供统一入口。它读到的是桌面可访问性树，**不是网页 DOM、Browser Harness 快照或页面标题**，也不包含浏览器内核，因此不能代替本路径的专用 Profile + Harness。

MultiCC 在 macOS 启动时会按需安装/更新 Agent（用户卸载并禁用自动安装或设置 `MULTICC_AGENT_AUTO_INSTALL=0` 时除外）；辅助功能、输入监控和屏幕录制权限仍须用户在系统里开启。Agent 的 macOS 11+ 分层实现、权限状态和安全限制以 `multicc-computer-use` 技能及其 `status.platform` 为准。**Browser Use/CDP 失败时不得静默改用 Agent**：桌面 AX/坐标操作会接触用户当前前台窗口，与本技能的后台浏览器边界不同。只有用户明确同意切换到前台桌面工作流，才按 `multicc-computer-use` 的规则操作，并重新验证操作结果；这不是“Browser Use 已兼容旧 Mac”的验收。

如果另行选择使用 Agent 的 Chrome watchdog，先核对端口、Profile 和浏览器进程归属；默认 `9222` 不得直接占用其它业务已有的端口。Agent 同步等待其 `--chrome-launch` 脚本退出，而本脚本的 `start` 模式会一直等待浏览器退出，所以**不能直接将 `start` 命令写进 `--chrome-launch` 脚本**。需要单独的短时、幂等、启动浏览器后立即返回的脚本；后台浏览器也必须把 stdout/stderr 重定向，避免继承 Agent 的等待管道，并在同一端口上完成探活。本仓库尚未为 Browser Use 配置这条接线。

当前新 Mac 上新版 Agent 的安装/协议/单端口 watchdog 测试及 macOS 11 目标构建检查通过。**这些结果不能替代 macOS 11 Intel 上安装、授权、启动与浏览器操作的真机测试**。即便 Agent 在旧机可用，Chrome 内核与 Harness 的 CDP 兼容性仍须单独验收。

## macOS 11 边界与回退

本仓库当前没有 Intel/macOS 11 运行机，也没有等效的可启动 GUI 浏览器 CI；在新 Mac 上的 smoke 只证明流程通顺，不证明目标环境兼容。目标机须额外完成两账号不同 Profile/端口、重启后登录仍在、无反复授权弹框的验收。若浏览器不能启动或 Harness 的 CDP 命令与旧 Chromium 不兼容，停止在此，不自动降级到个人 Chrome 或云端。可选回退是另行评估 Firefox/Selenium 本地后端，或在受支持机器上运行浏览器并通过受保护的连接使用；二者都不是本脚本已验证的能力。

来源：[Browser Use CLI](https://docs.browser-use.com/open-source/browser-use-cli.md)、[Browser Use 官方技能](https://github.com/browser-use/browser-use/blob/main/skills/browser-use/SKILL.md)、[Browser Harness 的 CDP 专用浏览器路径](https://github.com/browser-use/browser-harness/blob/main/src/browser_harness/daemon.py)。

## 验证记录（2026-09-25）

- `pip download --platform macosx_11_0_x86_64 --python-version 3.12 --implementation cp --abi cp312 --only-binary=:all: browser-harness==0.1.13` 成功解析并下载全部 12 个依赖 wheel；其中 Pillow/WebSockets 选到 `macosx_10_13_x86_64`。这是**安装包兼容性证据**，不是目标机浏览器运行证据。
- 当前 macOS 15.3/arm64 开发机上，Chrome 153 + Browser Harness 0.1.13 实跑 `smoke` 成功：打开内置页、核对标题并生成 756×469 PNG；结束后 9337 端口不再监听。最初一次因 Harness 默认向标题加 `🐴` 标记而失败，脚本现为 smoke 设置 `BH_TAB_MARKER=0`，重跑通过。
- `python3 -m unittest discover -s tests -p 'test_local_browser_use.py' -v`：3/3 通过；`node --test tests/test-skill-sync.js`：12/12 通过；技能格式检查与 Python 编译通过。
- `npm run test:core` 整体退出 0；`npm run governance:artifacts` 通过。`npm run test:architecture` 为 74/75：唯一失败是既有源码行数守卫，`public/air.js` 3098 行/167656 字节超过其 3094 行/167388 字节棘轮，`server.js` 3001 行超过 3000 行门槛。两文件与本次改造无关，且 rebase 前后文件树相同；本次未扩散修改这些业务文件。
- **未完成的目标机验证**：本执行机不是 Intel/macOS 11，当前也无该环境或等效 GUI CI。未找到已在目标机验证可运行的 Chromium 可执行文件，因而不能声称“Intel/macOS 11 已可用”。在目标机取得可信浏览器后运行上面的 smoke，保留输出日志；如果启动或旧 CDP 协议失败，应将该结果当作阻塞，而非用当前新 Mac 的通过记录代替。

## 一次性 Profile 迁移验证（2026-09-25）

- `seed` 的测试用虚构源目录核对仅复制指定 Profile、`Local State` 与 Cookie 文件，跳过缓存，且源文件不变；验证目标已存在时拒绝覆盖、运行中 Chrome 锁和目录穿越会被拒绝。测试没有读取或复制真实个人 Chrome 数据。
- `python3 -m unittest discover -s tests -p 'test_local_browser_use.py' -v`：5/5 通过；`node --test tests/test-skill-sync.js`：12/12 通过；技能格式、Python 编译和 `git diff --check` 通过。
- 当前 macOS 15.3/arm64 上使用 Chrome 153 + Browser Harness 0.1.13 对修改后的启动参数实跑 `smoke` 成功，输出 `PASS title=MultiCC Browser Use Smoke`、PNG 和 Harness 日志；测试端口 9339 在结束后关闭。这只验证专用浏览器流程，**尚未证明个人登录态在副本里仍有效，也不证明 macOS 11 Intel 可运行**。

## 与 Agent v2 合并后的核查（2026-09-25）

- 本会话分支已合并当时的本地 `main`（`acd2b848`）。新版 Agent 具有 AX 元素操作、macOS 11+ 分层实现与启动时按需安装；浏览器的专用 Profile + Browser Harness 流程保持独立。
- 当前 macOS 开发机上，Browser Use Python 测试 5/5、技能同步测试 15/15、Agent 协议/安装及搜索索引测试通过；桌面打包测试 28/28、技能格式检查通过。这是开发机回归，不是目标旧 Mac 的真机验收。
- **仍缺 Intel/macOS 11 真机验证**：可信且可运行的 Chromium、Harness CDP 操作、两账号独立 Profile、重启登录态、无逐次授权弹窗；Agent 的编译/协议通过也不能替代这些项目。

## 分级探测验证（2026-09-25）

- 分支已合并最新本地 `main`（`d076a7b0`），无冲突。新增 `browser_probe.py` 与 [macOS 分级选路](macos-tiers.md)，`start`/`smoke` 启动前按 `.app` 的 `LSMinimumSystemVersion` 与架构拒绝不兼容浏览器，默认端口改为 9331。
- 开发机（macOS 15.3/arm64，系统 `python3` 3.9）探测：`tier=current`，Chrome 153 的最低系统为 13.0；把 Harness 放进临时 venv 后，照探测打印的 `next` 命令原样执行 `smoke` 得到 `PASS`，9331 端口随后关闭。
- 以打桩的 macOS 11.7/x86_64 运行探测：Chrome 153 判为 `needs macOS 13.0`，Harness 路线 `needs-setup`，BrowserAct/OpenClaw `not-recommended`，`choice=none`，退出码 2；Agent 桌面路线始终标为前台且需同意。
- Python 测试 10/10（`python3.12` 与系统 `python3` 3.9 均通过），`node --test tests/test-skill-sync.js` 15/15。**这仍是开发机与模拟结果**，macOS 11/12 Intel 真机上的浏览器启动、CDP 操作和登录保持仍待验收。

## Rosetta 等效验收：Chrome for Testing 138/150 mac-x64（2026-09-25）

方法：在 macOS 15.3/arm64 上用 Rosetta 跑**官方 Chrome for Testing `mac-x64`** 构建（`known-good-versions-with-downloads.json` 中 138.x / 150.x 各自最后一个有 mac-x64 `chrome` 下载的版本，storage.googleapis.com 直链，解压后无 quarantine 属性），Harness 为 `browser-harness==0.1.13` 装在临时 venv。这是能找到的最接近 macOS 11/12 Intel 的等效环境。

- **版本与兼容声明（真机读数）**：`138.0.7204.183` → `CFBundleShortVersionString` 138.0.7204.183、`LSMinimumSystemVersion` **11.0**、主程序与 Renderer Helper 的 `lipo -archs` 均为**只有 x86_64**；`150.0.7871.124` → **12.0**、同样只有 x86_64。即 138 的声明门槛确实 ≤ 11.0、150 的确实 ≤ 12.0，两包都没有 arm64 切片（真 Intel 机不会因架构被拒）。
- **探测（`browser_probe.py --browser` 两个 app，系统 `/usr/bin/python3`）**：真机 `tier=current`，两个包都 `[ok]`（arm64 主机不触发 Intel 专属的 arm64-only 拒绝分支）；另有本机 Google Chrome 153 `min=13.0`。
- **打桩 Intel 主机（in-process 替换 `platform.mac_ver`，只让 `lipo` 走真实调用）**：macOS **11.7.10** 下 138 `compatible=True`、**150 `compatible=False`（why=`needs macOS 12.0`）**、Chrome 153 `False`；macOS **12.7.6** 下 138 与 150 都 `True`。把临时 venv 放到 `PATH` 后 `choice=browser-harness`，并打印出可直接照抄的 `smoke` 命令；不放时 `choice=None`（退出码 2）。分级判定与 `FROZEN_CHROME` 表一致。
- **smoke 通过（两次）**：138 → `browser=Chrome/138.0.7204.183`、`PASS title=MultiCC Browser Use Smoke`、PNG 756×417、整条命令 9.4s；150 → `browser=Chrome/150.0.7871.124`、`PASS`、7.4s。两次 Harness 日志都是 `MULTICC_BROWSER_USE_SMOKE_OK`。
- **确实在 Rosetta 下运行**：两个包的浏览器日志都带 Chromium 自己的 `The use of Rosetta to run the x64 version of Chromium on Arm is neither tested nor maintained`；运行期 `sample` 头部为 `Code Type: X86-64 (translated)`，父进程是启动它的 `local_browser_use.py`，与 `lipo -archs` 只有 x86_64 互相印证。
- **首次启动可能被登录钥匙串挡住（重要，务必知情）**：本机第一次用 138 起 headless 时，浏览器在 `Security.framework` 的 `SecItemCopyMatching` 上阻塞（读个人 Chrome 已于 2025-06-05 创建的登录钥匙串项 `Chrome Safe Storage`），SecurityAgent 弹出授权对话框且无人应答，CDP 一直不监听——浏览器日志只有 Rosetta 那一行，脚本按 20s 上限判 `FAIL CDP endpoint did not become ready`。**取消**该对话框（只取消，未批准任何访问）后 138 即可启动（一次 28s），之后 smoke/start 稳定 6–9s 起来；另测 `--use-mock-keychain` 可让 138 在 6s 内到达 CDP。150 全程没有阻塞（它也会拉起 SecurityAgent，但不等其应答）。
- **两账号持久化通过（138 x64）**：`start --headless` 起 `legacy-test-a`/9351 与 `legacy-test-b`/9352，Harness 写 `multicc-acct=alpha|beta`（含 max-age 的 cookie + localStorage）。两账号互不可见（A 只见 alpha、B 只见 beta）；`SIGTERM` 停掉两个浏览器进程（当时启动器已因下述缺陷自行退出）、确认两个端口关闭后重新 `start`，A 仍是 alpha、B 仍是 beta，且隔离与磁盘上一致（各自 `Default/Local Storage/leveldb` 只含自己的值）。重启浏览器后按 Harness 说明先 `--reload` 丢弃旧 daemon 再连。
- **发现并修复的脚本缺陷**：给启动器发 `SIGTERM` 只会杀掉启动器，**它启动的浏览器会变成孤儿**继续监听 CDP 端口（脚本只处理 `KeyboardInterrupt`，`SIGTERM` 默认不触发 `finally`）。已做最小修复：注册 `SIGTERM` 处理函数转成 `KeyboardInterrupt`，使 `start` 的停止语义与文档一致；修复后实测 `SIGTERM` 启动器 → 只它自己的浏览器退出、端口关闭、无残留。
- **本验收不能证明**：真 macOS 11/12 Intel 内核/图形栈/系统权限弹窗下的浏览器启动；真机钥匙串（登录会话、ACL、Seeded Profile 的 Cookie 解密）行为——本机是 arm64 登录会话里跑的转译 x64 进程，与真 Intel 机可能不同；有头（非 headless）模式的首次运行 UI 与授权弹窗未测；只验证到 CDP 层的 set/get 与持久化，没有真实站点登录；150 只做了探测与单次 smoke，两账号持久化只在 138 上做过。这些仍需真机验收，不能用本节结果代替。
