# 独立版（standalone）—— MultiCC 唯一的发行形态

> MultiCC 只以**独立包**发布：一个自包含的压缩包，内含官方 Node 运行时 + 服务端全部生产依赖。目标机器**不需要** Node、npm、git、Homebrew 或 Xcode，也不需要编译任何原生模块。解压后 `./multicc start` 即可；桌面版（Electron）也是在这同一个包上加了一层壳。

它为什么是唯一的形态：桌面版（Electron）与 Homebrew 都覆盖不到老 macOS，而 git pull + npm install 的装法要求目标机器有 git、有 Node、还能现场装依赖——这三件事在用户机器上都不该是前提。

独立包不是 macOS 专用，当前 Release 固定构建五个目标：

| 系统 | 架构 | 压缩格式 | 原生安装入口 |
|------|------|----------|--------------|
| macOS | Intel x64 / Apple Silicon arm64 | `.tar.gz` | `install.sh` |
| Linux | x64 / arm64 | `.tar.gz` | `install.sh` |
| Windows | x64 | `.zip` | `install.ps1` |

五个包都由 `scripts/standalone-bundle.js` 生成，里面的服务端、Web UI、manifest、
监管器、升级器与命令行完全相同；不同的只有官方 Node 运行时二进制、压缩格式和操作系统启动包装。

| 路径 | 最低系统版本 | 老机器（macOS 11/12，含 Mac Pro 2013） |
|------|-------------|--------------------------------------|
| 桌面版 Electron 44 | macOS 13+（Chromium 152） | ❌ 装不上 |
| `brew install node` | 新版 Homebrew 对 Intel 已停止供应 bottle | ❌ 基本不可用 |
| **独立版** | **macOS 11.0+（Intel x64 / Apple Silicon）** | ✅ |

## 安装（一行命令，无需任何参数）

```bash
# macOS / Linux
curl -sSL https://raw.githubusercontent.com/lsjwzh/MultiCC/v2.0.5/install.sh | bash
```

```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/lsjwzh/MultiCC/v2.0.5/install.ps1 | iex
```

URL 里的 tag 就是安装的版本。两个脚本只负责各系统必须不同的下载、校验和解压；装好后全部进入同一个包内 `multicc` CLI。整条链路一次完成：下载对应平台的独立包 → 校验 `.sha256` → 解压到稳定的 `~/MultiCC`（Windows 为 `%USERPROFILE%\MultiCC`）→ 在 macOS 清除下载隔离标记 → 用**包内自带的** `multicc` 写配置（访问令牌、端口）→ 可选注册登录自启 → 启动并等待 `/readyz` → 打开浏览器。命令返回时界面已经能用；目标机器不需要 Node、npm、git、Homebrew、Visual Studio 或 Xcode。

Windows 不是另一套产品：它下载 `multicc-standalone-<版本>-win32-x64.zip`，包内仍是同一个 `app-server/`、`launcher/`、manifest、升级器和固定 Node 22 运行时。PowerShell 只是 Windows 自带的薄安装外壳，等价于 macOS/Linux 的 `install.sh`。

```bash
# 想装到别处（默认 ~/MultiCC）
curl -sSL .../install.sh | bash -s -- --dir /opt/multicc

# 只装、不设置开机自启（脚本默认会问一次）
curl -sSL .../install.sh | bash -s -- --no-service

# 安装最新 release（默认装 URL 里那个 tag 指定的版本）
curl -sSL .../install.sh | bash -s -- --version latest

# 用本地的包离线安装（跳过下载，仍然校验 .sha256）
curl -sSL .../install.sh | bash -s -- --from ./multicc-standalone-2.0.5-darwin-arm64.tar.gz

# 自动化/服务器：只安装不启动，或启动但不打开浏览器
curl -sSL .../install.sh | bash -s -- --no-start
curl -sSL .../install.sh | bash -s -- --no-open
```

| 参数 | 默认 | 说明 |
|------|------|------|
| `--dir <path>` | `~/MultiCC` | 安装目录 |
| `--version <v\|latest>` | URL 里的 tag | 装哪个版本；`latest` 走 GitHub API 查最新 release |
| `--from <path\|url>` | 无 | 用本地文件或指定 URL 的包代替下载 |
| `--token <token>` | 自动生成 | 写入 `ACCESS_TOKEN` |
| `--port <n>` | `3000` | 起始端口（被占用会自动往后找） |
| `--no-service` | 关 | 不询问开机自启 |
| `--no-start` | 关 | 只安装和配置，不启动；同时跳过开机自启设置 |
| `--no-open` | 关 | 启动服务，但不打开浏览器 |
| `--no-apk`、`--branch <tag>`、`--no-clone` | — | 旧命令行的兼容位：`--branch` 等价于 `--version`，`--no-clone` 等价于 `--from .`（从当前目录装），`--no-apk` 只打印一句提示（安装从来不构建 APK） |

Windows 对应参数为 `-InstallDir`、`-Version`、`-From`、`-AccessToken`、
`-Port`、`-NoService`、`-NoStart`、`-NoOpen`。无参数时使用上面的一行命令；
需要传参时下载 `install.ps1` 后在 PowerShell 里执行。

脚本会拒绝非空的非 MultiCC 目录，也会拒绝校验和不匹配或缺少运行时的包（宁可失败，也不装一个装不起来的包）。重复安装同一个目录是**原地替换**：先停掉在跑的实例、把旧目录挪到 `.old-<pid>` 作为回滚点，再改名就位；失败会把旧目录还原。

装完脚本会直接启动并打开界面，同时打印实际 URL、访问令牌和日常命令（都在安装目录下运行）。若启动未通过就绪检查，脚本会保留已安装文件、给出日志命令并返回失败，而不是把“解压成功”误报成“已经可用”。

## 日常命令

包里有一个 `multicc`（Windows 是 `multicc.cmd`）在包根目录，它是所有人面对的入口：双击包装脚本、安装脚本、文档都指向它，所以不会各自漂移。

| 命令 | 作用 |
|------|------|
| `./multicc start` | 后台启动并打开浏览器（`-f` 留在前台看日志） |
| `./multicc stop` | 优雅停止（先在飞的回复会先落盘） |
| `./multicc restart` | stop 再 start |
| `./multicc status` | 版本、运行状态、URL、数据目录（`--json` 给脚本用） |
| `./multicc url` / `open` | 打印 / 打开本地地址 |
| `./multicc log -f` | 跟随日志 |
| `./multicc config get\|set\|unset\|list\|path` | 读写数据目录里的 `multicc.env`（`list` 会把令牌打码） |
| `./multicc update [--check]` | 下载并安装最新 release（数据不受影响） |
| `./multicc service install\|uninstall\|status` | 登录自启（macOS launchd / Linux systemd user / Windows Startup） |
| `./multicc version` | 打印已安装版本 |

通用选项：`--port <n>`、`--data <dir>`（等价于 `MULTICC_STANDALONE_HOME`，用于同机多实例或 U 盘安装）、`--no-open`。

Windows 上停止走的是**停止请求文件**（`standalone-launcher.stop`），不是信号：Windows 没有 SIGTERM，`process.kill` 在那里等于直接终止进程，会留下没人监管的服务端。监管进程每 500ms 轮询该请求并走同一条优雅排空路径；若它长时间不响应，包装脚本会用 `taskkill /T` 兜底收掉整棵进程树。

图形化/双击入口在各平台仍然存在，但它们只是上面这些命令的包装：

| 动作 | macOS | Linux | Windows |
|------|-------|-------|---------|
| 启动 | 双击 `启动 MultiCC.command` | `./start-multicc.sh` | `Start-MultiCC.cmd` |
| 停止 | `停止 MultiCC.command` | `./stop-multicc.sh` | `Stop-MultiCC.cmd` |
| 状态 | `查看状态 MultiCC.command` | `./status-multicc.sh` | `Status-MultiCC.cmd` |

macOS 上直接双击包里的 `MultiCC.app` 也等价于 `multicc start`（首次打开若提示「无法验证开发者」，右键点图标 → 打开 → 再点「打开」）。

> 请用 `multicc stop` 而不是直接强杀进程：它会请求监管进程优雅排空（走 `/api/desktop-shutdown`）再退出；强杀可能让正在进行的回复或状态写入丢失。

## 下载与校验（不用安装脚本的话）

从 GitHub [Releases](https://github.com/lsjwzh/MultiCC/releases) 下载，或直接取包：

| 文件 | 说明 |
|------|------|
| `multicc-standalone-<版本>-darwin-x64.tar.gz` | macOS Intel（含 Mac Pro 2013 等老机器） |
| `multicc-standalone-<版本>-darwin-arm64.tar.gz` | macOS Apple Silicon |
| `multicc-standalone-<版本>-linux-x64.tar.gz` | Linux 64 位 |
| `multicc-standalone-<版本>-linux-arm64.tar.gz` | Linux arm64 |
| `multicc-standalone-<版本>-win32-x64.zip` | Windows 64 位（zip，不是 tar.gz） |
| `multicc-standalone-<版本>-<平台>-<架构>.tar.gz.sha256` | 同名压缩包的 SHA-256（Windows 是 `.zip.sha256`） |
| `SHA256SUMS.txt` | 一次覆盖全部发布资产的总清单 |

Windows 用 zip 分发：`scripts/standalone-bundle.js` 用包内自带的流式 zip writer（`scripts/zip-archive.js`，零依赖）**自己打包**，不依赖 runner 上的 `Compress-Archive`/`zip`，同样附 `.sha256`。因为归档结果直接进 Release，它和 tarball 走同一条代码路径、同一套校验。

```bash
shasum -a 256 -c multicc-standalone-<版本>-darwin-x64.tar.gz.sha256
tar -xzf multicc-standalone-<版本>-darwin-x64.tar.gz
cd multicc-standalone-<版本>-darwin-x64
./multicc start
```

解压后体积约 270 MB（含约 124 MB 的 Node 运行时与约 146 MB 的服务端依赖），压缩包约 62 MB（darwin 实测；Windows zip 约 63 MB，其它平台略有差异）。请**整体解压**：`.app` 里的运行时和包装脚本必须保持相对位置。

## 数据、配置与日志

包本身是只读的，可写状态全部落在每用户数据目录，因此**换包升级不会丢数据**：

| 内容 | macOS | Linux / Windows |
|------|-------|-----------------|
| 数据根目录 | `~/Library/Application Support/MultiCCStandalone/` | `~/.config/MultiCCStandalone/`、`%APPDATA%\MultiCCStandalone\` |
| 服务端全部状态 | 同上 `data/`（会话、providers、聊天历史、SQLite；即 `MULTICC_DATA_DIR`） | 同上 |
| 记忆库 | `data/memories/` | 同上 |
| 环境变量文件 | `multicc.env`（即 `MULTICC_ENV_FILE`，与 CLI 版 `.env` 同格式，权限 0600） | 同上 |
| 日志 | `logs/server-<时间>.log`、`logs/standalone.log`（监管进程）、`logs/multicc.log`（`multicc` 命令）、`logs/service.log`（开机自启） | 同上 |
| 运行时信息 | `desktop-runtime.json`、`standalone-launcher.pid`（正常退出即消失） | 同上 |

位置由 `multicc status` 直接打印，不用猜。旧版（便携版）用的是 `MultiCCPortable` 目录：如果它已存在而新目录还没有，独立版会**继续用它**，不会把已有会话藏起来。`MULTICC_STANDALONE_HOME` 可以整体覆盖数据目录；旧变量名 `MULTICC_PORTABLE_HOME` 仍然生效。

安全默认与桌面版一致：服务端只监听 `127.0.0.1`（环境变量里的 `HOST` 会被强制覆盖回 loopback），同一个数据目录同时只允许一个实例；重复启动会复用已在运行的实例，而不是抢端口和 SQLite 文件。独立版以 `MULTICC_DESKTOP=1` 运行，因此聊天里的 `/api/update` 自更新入口返回 409——**升级走 `multicc update`**。

## 升级

```bash
./multicc update --check   # 只对比版本
./multicc update           # 下载并安装最新 release
```

`multicc update` 会下载对应平台的包与它的 `.sha256`、校验、解压到安装目录旁边，然后启动一个**脱离当前进程**的替换助手（用的是**新包**里的运行时）：它等父进程退出后把旧目录改名为 `<root>.old-<时间戳>`、把新包改名就位、删掉旧目录，最后按需重启。任何一步失败都会把旧目录还原——所以升级过程中断电最多是「还是旧版本」，不会是「什么都没有」。

更新器按 SemVer 比较版本：若本机是尚未发布的测试版、版本号高于 GitHub 最新正式版，只会报告“本机版本更新”，不会把它自动降级。无法解析的版本号同样拒绝替换。

镜像/内网环境请用新包手动替换：解压出 `multicc-standalone-<版本>-<平台>-<架构>/`，`./multicc stop` → 整个目录替换 → `./multicc start`；数据目录不在包里，不受影响。

## 为什么能跑在 macOS 11/12 上

两个硬约束决定了包里的版本，不要随手改：

- **Node 钉在 22.23.2（LTS，官方维护到 2027-04）**。Node 22 的 `darwin-x64` 官方二进制用 `-mmacosx-version-min=11.0` 构建；Node 24 起官方 macOS 二进制改为 13.5，跟「最新」就会静默丢掉本包服务的老机器。构建脚本据此把 `LSMinimumSystemVersion` 写成 11.0（Node ≥ 24 时自动变 13.5），并对 Node < 22.16（服务端 `node:sqlite` 下限）直接报错。
- **SQLite 不再是需要编译的模块**。服务端用的是 Node 核心里的 `node:sqlite`（Node 22.16+ 起内置），所以包里没有任何需要匹配 ABI 或现场编译的 SQLite 加载项，也就没有 Xcode / node-gyp / prebuild 的失败面。打包结束前会用**包内运行时**真实建一个内存库做冒烟验证——运行时缺 `node:sqlite` 会直接让构建失败，而不是等到用户机器上才崩。同时会读运行时二进制的头部，校验它的架构与系统格式确实等于目标（`darwin`/`linux`/`win32`）——架构不对的运行时装得上、装得像，只在用户机器上第一次执行时死掉。

## 已知限制

- **包未签名/未公证**（没有 Apple Developer ID 与公证凭据）。首次打开必须右键→打开，之后正常双击。校验来源请用 Release 里的 `.sha256`。**未签名的直接后果之一是磁盘权限给不上**，见下面「macOS 磁盘权限」一节。
- **本地语音识别（sherpa-onnx）需要 macOS 15+**：其 `darwin-x64` 二进制最低系统版本为 15.0。macOS 11–14 上会自动回退到云端 ASR（`src/voice/asr-local.js` 懒加载 + 失败回退），语音功能整体仍可用，只是精度/延迟按云端走。
- **macOS 12 的 Safari 不支持 Web Push**：需要通知时请用 Chrome 打开界面（Web UI 的其它部分在 Monterey 的 Safari 17.6 上可用）。
- **终端模式需要系统里的 `tmux`**：包不携带 `tmux`，聊天、任务板、文件浏览都不受影响，只有终端页/CLI 登录需要它。
- **`claude`、`codex` 等编码 CLI 仍需自行安装并登录**。包的运行时会被前置到 `PATH`，因此这些 Node 编写的 CLI 会自动用包内的 Node 22 跑，不需要系统装 Node。老机器上可以用包内 npm 装到用户目录：

  ```bash
  R="/Applications/MultiCC.app/Contents/Resources"   # 或解压目录下的 MultiCC.app
  "$R/runtime/bin/npm" install -g --prefix "$HOME/.local" @anthropic-ai/claude-code
  export PATH="$HOME/.local/bin:$PATH"   # 写进 ~/.zshrc 长期生效
  ```

  卸载独立版时，这些 CLI 连同数据目录都不受 `MultiCC.app` 删除影响。
- **Windows 用 zip 分发**：资源管理器双击解压即可。Windows 包里的运行时是 `Resources\runtime\node.exe`（官方 win-x64 压缩包没有 `bin/` 层），入口是包根的 `multicc.cmd`。

## macOS 磁盘权限（TCC）：为什么「给权限」常常给不上

macOS 把「桌面 / 文档 / 下载 / iCloud 云盘 / 外接磁盘 / 网络磁盘」列为受保护位置。进程碰这些位置时，系统不是问一句就记住，而是**按「是谁在问」记一笔账**：授权挂在**发起进程链最上游的那个程序**（终端窗口、双击的 App、launchd）身上，并且**认的是那个可执行文件的精确路径**——不是「MultiCC 这个产品」，也不是包名。

这解释了两件让用户以为是 bug 的事：

- **给 `.app` 授了权，里面的 `git` 还是被拒**。独立包从 `MultiCC.app/Contents/MacOS/MultiCC`（一个 shell 脚本）起步，`exec` 包内 `Resources/runtime/bin/node`，再由它去 `spawn /usr/bin/git`。终端启动、双击 App、开机自启（launchd）是**三种不同的发起进程**，各自要各自授权。
- **升级过 node 版本之后，之前授的权失效了**。授权认路径，`runtime/bin/node` 换了版本就是另一个路径、另一笔账。

失败时的原始报错是 `fatal: unable to get current working directory: Operation not permitted`（git 第一个失败的调用是 `getcwd()`，所以它说的是「工作目录」，不是它真正想打开的东西），从用户角度看完全没法行动。现在 MultiCC 会把它翻译成一段可操作的指引：**指名要授权的对象**（按你当前的启动方式给出 `.app` 路径、或那个 node 二进制、或「你的终端」）、给出 `系统设置 → 隐私与安全性 → 完全磁盘访问权限` 的直达链接、并说明**授权后必须完全退出再重新启动**。

排查顺序（从最常见的原因开始）：

1. **确认不是 AppTranslocation**。从「下载」里直接双击运行、且目录还带着「来自网络」的隔离标记时，Gatekeeper 会把它放进 `/private/var/folders/.../AppTranslocation/<随机码>/d/` 这个**只读临时路径**里跑——路径每次启动都变，所以此时任何授权都记不住。启动日志里会直接打印这个警告。处理：把整个目录移出「下载」（例如 `~/Applications`），执行 `xattr -dr com.apple.quarantine "<安装目录>"`，再重启。安装脚本与 `multicc update` 解压后都会自动清掉这个标记，只有手动解压/手工搬运才需要自己执行。
2. **确认要授权的是哪个对象**。报错里已经点名了，直接按它给的那一条做（终端 / `.app` / 二进制的绝对路径三选一）。launchd（开机自启）**不会弹窗**，只能手动加那个二进制，没有别的路径。
3. **授权后完全退出再启动**。TCC 在进程启动时结算，热重启无效。
4. **不想折腾就换位置**。`~/working` 这类不受保护的位置不需要任何授权，直接就能用；在 `~/Downloads/working` 里留个指向真实仓库的符号链接也照常工作（仓库本体在哪儿，git 就在哪儿跑）。

代码侧的对应改动（都在这一版里）：注册目录时先探一次写（`directoryWriteDenied`，EPERM/EACCES 才算拒绝），在 spawn git 之前就把「这个目录根本不让碰」判出来；`gitIsRepo()` 不再把权限错误当成「不是 Git 仓库」——以前这个误判会让每次注册都重跑一次 `git init`，用户看到的是永远重复的同一条 fatal，真正的原因被埋掉；`MultiCC.app` 的 `Info.plist` 补上了 `NSDesktopFolderUsageDescription` / `NSDocumentsFolderUsageDescription` / `NSDownloadsFolderUsageDescription` / `NSRemovableVolumesUsageDescription` / `NSNetworkVolumesUsageDescription`——**没有这些键，macOS 连弹窗都不会弹，只会静默拒绝**；systemd/launchd 单元加了 `MULTICC_SERVICE=1`，好让指引知道该说「launchd 不会弹窗」。

**还没解决的**（要动签名链路，属于独立改动）：包没有签名/公证，无法用 MDM/PPPC 预授权；`.app` 的入口是个 shell 脚本，TCC 归属不如编译出的 Mach-O 稳定；授权钉在运行时二进制的路径上，所以换了 node 版本的升级会让用户重授一次。真正的解法是 Developer ID 签名 + 公证（含嵌套的 `runtime/bin/node`），再考虑把入口换成编译产物。

## 自己构建

```bash
node scripts/standalone-bundle.js --platform darwin --arch x64 --out ./dist-standalone
```

| 参数 | 默认 | 说明 |
|------|------|------|
| `--platform` | 构建机平台 | `darwin` / `linux` / `win32` |
| `--arch` | 构建机架构 | `x64` / `arm64`（可与构建机不同，脚本按目标架构解析可选 prebuild） |
| `--node-version` | `22.23.2` | 低于 22.16 直接报错；≥ 24 会把 macOS 下限抬到 13.5 |
| `--out` | `<repo>/dist-standalone` | 输出目录 |
| `--runtime-tarball` | 无 | 用本地 Node 压缩包代替下载（**不校验 sha256**，仅离线构建用） |
| `--cache-dir` | 系统临时目录 | Node 压缩包与 `SHASUMS256.txt` 的缓存 |
| `--no-install` / `--no-runtime` / `--no-verify` / `--no-archive` | 全开 | 分别跳过依赖安装 / 内置运行时 / 运行时 SQLite 冒烟验证 / 归档（darwin·linux 打 tar.gz，win32 打 zip） |

构建过程：下载目标平台的官方 Node 压缩包并用 `SHASUMS256.txt` 校验 → 用 `scripts/desktop-bundle-server.js` 的 `stageServer()` 落一份服务端（含 `--os/--cpu` 与 prebuild 目标 env）→ 投放运行时并校验它的架构/格式 → 复制 `scripts/standalone-launcher.js`、`scripts/standalone-cli.js` 与 `desktop/lib/*` → 写 `.app`/包装脚本/说明 → 运行时 SQLite 冒烟 + 架构门（`scripts/native-arch.js`，针对可选的本地 ASR 二进制）→ 归档并写 `.sha256`。

这段「投放 Resources 树」的逻辑（`stageResources()`）**同时被桌面版复用**：桌面版就是这棵树加一个 Electron 壳，所以 dmg 和 tarball 跑的是同一份代码、同一个运行时。

产物结构（macOS）：

```
multicc-standalone-<版本>-darwin-x64/
├── multicc                               # 唯一的命令入口：用包内运行时跑 standalone-cli.js
├── MultiCC.app/Contents/
│   ├── MacOS/MultiCC                     # 启动入口：exec 包内运行时跑 launcher
│   ├── Info.plist                        # LSMinimumSystemVersion = 11.0
│   └── Resources/
│       ├── app-server/                   # server.js + src/ + public/ + node_modules
│       ├── runtime/                      # 官方 Node 22（bin/node、bin/npm；Windows 为 runtime/node.exe）
│       ├── launcher/                     # standalone-launcher.js / standalone-cli.js + lib/（与 desktop/lib 同源）
│       └── bundle-manifest.json          # 版本、平台、架构、运行时版本
├── 启动 MultiCC.command / 停止 MultiCC.command / 查看状态 MultiCC.command
└── 使用说明.txt
```

Linux / Windows 用同一棵 `Resources/` 树（无 `.app`），入口是包根的 `multicc` / `multicc.cmd` 加上 `start-multicc.sh` / `Start-MultiCC.cmd` 等包装脚本。

跨架构构建（例如在 Apple Silicon 上打 `darwin-x64`）会在打包结束时尝试用目标运行时跑冒烟：宿主能执行目标二进制（macOS 有 Rosetta）时就是真实校验，执行不了（`ENOEXEC`/`EPERM`/`EACCES`）才跳过。跳过时仍有架构门（`scripts/native-arch.js` 读 Mach-O/ELF/PE 头，同时校验架构与二进制格式；运行时本身由 `stageResources()` 单独校验）。CI 的 `standalone` 任务对每个平台的两个架构都构建，但只有与 runner 同架构的条目会跑冒烟，交叉架构条目用 `--no-verify` 跳过——想给交叉架构也加冒烟，把该条目放到对应架构的 runner 上即可。

## 安装脚本的验收

`.github/workflows/clean-install.yml` 会在**干净的 Docker 容器**里证明「傻瓜化」这句话：先把候选代码打成独立包，再用 `install.sh` 把包装进去（容器里没有 git、没有 node_modules），然后只通过装好的 `multicc` 走完启动/停止/重启/建目录/建会话/任务终端，最后才在源码树上跑应用回归。测试在 `tests/test-standalone-installer.js`（本地、无 Docker 也能跑）与 `docker/task-shell/`。

## 与桌面版的取舍

| | 独立版（standalone） | 桌面版（Electron） |
|---|---|---|
| 老机器（macOS 11/12、Intel） | ✅ 支持 | ❌ 需要 macOS 13+ |
| 界面 | 系统浏览器 | 自带窗口 |
| 需要安装的东西 | 一行命令 / 解压即用 | 安装包（dmg/exe/AppImage/deb） |
| 后端 | **同一棵 Resources 树 + 同一个固定运行时** | 同左（壳里的服务端就跑这棵树） |
| 数据目录 | `MultiCCStandalone` | `MultiCC`（各自独立） |
| 升级方式 | `multicc update` / 换包 | 新安装包覆盖 |
| 包体 | ~270 MB 解压 / ~62 MB 压缩（含约 124 MB Node 运行时） | dmg/exe/AppImage：Electron 运行时 + 同一份 Resources 树 |

两者的后端、Web UI、端口策略、数据布局与优雅关闭协议完全一致：桌面版就是独立版加一层 Electron 壳，壳里的服务端进程跑的是包内那棵 `Resources/` 树和自己的固定 Node（不是 Electron 自带的 Node），进程监管逻辑（`desktop/lib`）两边共用同一份源码。桌面版细节见 [desktop.md](desktop.md)。
