# Browser Use 本地专用浏览器（Intel/macOS 11 候选路径）

Browser Use 官方 `browser-use` 技能调用 CLI；CLI 的本地执行层是官方 `browser-harness`，通过 CDP 连接 Chromium。默认接管个人 Chrome 会触发权限确认，也不能解决旧系统浏览器版本限制。MultiCC 的 `scripts/local_browser_use.py` 启动用户指定的兼容浏览器及专用 Profile，并把 CDP 地址交给 Harness；用户明确选择时可用 `seed` 将**已退出的**个人 Chrome 指定 Profile 一次性复制到专用目录。它不下载浏览器，也不启动云服务。

## 安装与预检

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
