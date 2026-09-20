# 便携版（免安装 Node / 免依赖）

> 自包含的 MultiCC 发行包：内含官方 Node 运行时 + 服务端全部生产依赖，目标机器**不需要**安装 Node、Homebrew 或 Xcode，也不需要编译原生模块。解压后双击 `MultiCC.app` 即可，界面在浏览器里打开（与桌面版是同一套 Web UI 和后端）。

它存在的理由：桌面版（Electron）与 Homebrew 都覆盖不到老 macOS。

| 路径 | 最低系统版本 | 老机器（macOS 11/12，含 Mac Pro 2013） |
|------|-------------|--------------------------------------|
| 桌面版 Electron 44 | macOS 13+（Chromium 152） | ❌ 装不上 |
| `brew install node` | 新版 Homebrew 对 Intel 已停止供应 bottle | ❌ 基本不可用 |
| **便携版** | **macOS 11.0+（Intel x64 / Apple Silicon）** | ✅ |

## 下载与校验

从 GitHub [Releases](https://github.com/lsjwzh/MultiCC/releases) 下载：

| 文件 | 说明 |
|------|------|
| `multicc-portable-<版本>-darwin-x64.tar.gz` | macOS Intel（含 Mac Pro 2013 等老机器） |
| `multicc-portable-<版本>-darwin-arm64.tar.gz` | macOS Apple Silicon |
| `multicc-portable-<版本>-linux-x64.tar.gz` | Linux 64 位 |
| `multicc-portable-<版本>-linux-arm64.tar.gz` | Linux arm64 |
| `multicc-portable-<版本>-win32-x64.zip` | Windows 64 位（zip，不是 tar.gz） |
| `multicc-portable-<版本>-<平台>-<架构>.tar.gz.sha256` | 同名压缩包的 SHA-256 |

Windows 用 zip 分发（打包脚本不装归档器，CI 里用 `Compress-Archive` 生成，同样附 `.sha256`）：

```powershell
Compress-Archive -Path multicc-portable-<版本>-win32-x64 -DestinationPath multicc-portable-<版本>-win32-x64.zip
```

```bash
shasum -a 256 -c multicc-portable-<版本>-darwin-x64.tar.gz.sha256
tar -xzf multicc-portable-<版本>-darwin-x64.tar.gz
cd multicc-portable-<版本>-darwin-x64
```

解压后体积约 290 MB（含 127 MB 的 Node 运行时与 162 MB 的服务端依赖），压缩包约 68 MB（darwin-x64 实测；其它平台略有差异）。请**整体解压**：`.app` 里的运行时和 `.command` 脚本必须保持相对位置。

## 启动 / 停止 / 状态

1. 双击 `MultiCC.app`。首次打开若提示「无法验证开发者」（包未签名，见下文），**右键点图标 → 打开 → 再点「打开」**。
2. 当包内运行时在 `127.0.0.1` 上选到一个空闲端口（默认 3000）并把服务端拉起到 `/readyz` 就绪后，浏览器会自动打开界面。
3. 停止：双击 `停止 MultiCC.command`。查看状态：双击 `查看状态 MultiCC.command`。

> 请用 `停止 MultiCC.command` 而不是直接强杀进程：它会请求监管进程优雅排空（走 `/api/desktop-shutdown`）再退出；强杀可能让正在进行的回复或状态写入丢失。

`.command` 包装脚本等价于直接运行包内的启动器，且不占用终端窗口：

```bash
R="$(pwd)/MultiCC.app/Contents/Resources"
"$R/runtime/bin/node" "$R/launcher/portable-launcher.js" --start --detach   # 后台启动
"$R/runtime/bin/node" "$R/launcher/portable-launcher.js" --status         # 状态
"$R/runtime/bin/node" "$R/launcher/portable-launcher.js" --stop           # 优雅停止
```

| 参数 | 说明 |
|------|------|
| `--port <n>` | 指定起始端口（被占用时自动往后找空闲端口） |
| `--data <dir>` | 指定数据目录（等价于 `MULTICC_PORTABLE_HOME`），用于同机多实例或 U 盘安装 |
| `--no-open` | 不自动打开浏览器（SSH / 无人值守） |
| `--detach` | 后台启动，不占用当前终端 |

环境变量覆盖：`MULTICC_PORTABLE_HOME`（数据目录）、`MULTICC_PORTABLE_RESOURCES`（包内 `Resources/` 位置）。
三个 `.command` 包装脚本都会把额外参数原样透传给启动器（例如 `启动 MultiCC.command --port 8123`）。

## 数据、配置与日志

包本身是只读的，可写状态全部落在每用户数据目录，因此**替换 `.app` 升级不会丢数据**：

| 内容 | macOS | Linux / Windows |
|------|-------|-----------------|
| 数据根目录 | `~/Library/Application Support/MultiCCPortable/` | `~/.config/MultiCCPortable/`、`%APPDATA%\MultiCCPortable\` |
| 服务端全部状态 | 同上 `data/`（会话、providers、聊天历史、SQLite；即 `MULTICC_DATA_DIR`） | 同上 |
| 记忆库 | `data/memories/` | 同上 |
| 环境变量文件 | `multicc.env`（即 `MULTICC_ENV_FILE`，与 CLI 版 `.env` 同格式） | 同上 |
| 日志 | `logs/server-<时间>.log`、`logs/portable.log` | 同上 |
| 运行时信息 | `desktop-runtime.json`、`portable-launcher.pid`（正常退出即消失） | 同上 |

安全默认与桌面版一致：服务端只监听 `127.0.0.1`（环境变量里的 `HOST` 会被强制覆盖回 loopback），同一个数据目录同时只允许一个实例；重复启动会复用已在运行的实例，而不是抢端口和 SQLite 文件。便携版以 `MULTICC_DESKTOP=1` 运行，因此聊天里的 `/api/update` 自更新入口返回 409——**升级 = 换包**。

## 为什么能跑在 macOS 11/12 上

两个硬约束决定了包里的版本，不要随手改：

- **Node 钉在 22.23.2（LTS，官方维护到 2027-04）**。Node 22 的 `darwin-x64` 官方二进制用 `-mmacosx-version-min=11.0` 构建；Node 24 起官方 macOS 二进制改为 13.5，跟「最新」就会静默丢掉本包服务的老机器。构建脚本据此把 `LSMinimumSystemVersion` 写成 11.0（Node ≥ 24 时自动变 13.5），并对 Node < 22.16（服务端 `node:sqlite` 下限）直接报错。
- **`better-sqlite3` 用预编译二进制**。它发布的 `darwin-x64` prebuild 目标为 10.7，所以老机器上不需要 Xcode、不需要编译。打包会为**目标架构**（而不是构建机）解析 prebuild 与可选依赖，并在打包结束前用**包内运行时**真实加载一次 `better-sqlite3` 做冒烟验证——架构或 ABI 不匹配会直接让构建失败，而不是等到用户机器上 `require()` 才崩。

## 已知限制

- **包未签名/未公证**（没有 Apple Developer ID 与公证凭据）。首次打开必须右键→打开，之后正常双击。校验来源请用 Release 里的 `.sha256`。
- **本地语音识别（sherpa-onnx）需要 macOS 15+**：其 `darwin-x64` 二进制最低系统版本为 15.0。macOS 11–14 上会自动回退到云端 ASR（`src/voice/asr-local.js` 懒加载 + 失败回退），语音功能整体仍可用，只是精度/延迟按云端走。
- **macOS 12 的 Safari 不支持 Web Push**：需要通知时请用 Chrome 打开界面（Web UI 的其它部分在 Monterey 的 Safari 17.6 上可用）。
- **终端模式需要系统里的 `tmux`**：包不携带 `tmux`，聊天、任务板、文件浏览都不受影响，只有终端页/CLI 登录需要它。
- **`claude`、`codex` 等编码 CLI 仍需自行安装并登录**。包的运行时会被前置到 `PATH`，因此这些 Node 编写的 CLI 会自动用包内的 Node 22 跑，不需要系统装 Node。老机器上可以用包内 npm 装到用户目录：

  ```bash
  R="/Applications/MultiCC.app/Contents/Resources"   # 或解压目录下的 MultiCC.app
  "$R/runtime/bin/npm" install -g --prefix "$HOME/.local" @anthropic-ai/claude-code
  export PATH="$HOME/.local/bin:$PATH"   # 写进 ~/.zshrc 长期生效
  ```

  卸载便携版时，这些 CLI 连同数据目录都不受 `MultiCC.app` 删除影响。
- **Windows 运行时用 zip**：解压需要 `unzip`（Git for Windows 自带）。

## 自己构建

```bash
node scripts/portable-bundle.js --platform darwin --arch x64 --out ./dist-portable
```

| 参数 | 默认 | 说明 |
|------|------|------|
| `--platform` | 构建机平台 | `darwin` / `linux` / `win32` |
| `--arch` | 构建机架构 | `x64` / `arm64`（可与构建机不同，脚本按目标架构解析 prebuild） |
| `--node-version` | `22.23.2` | 低于 22.16 直接报错；≥ 24 会把 macOS 下限抬到 13.5 |
| `--out` | `<repo>/dist-portable` | 输出目录 |
| `--runtime-tarball` | 无 | 用本地 Node 压缩包代替下载（**不校验 sha256**，仅离线构建用） |
| `--cache-dir` | 系统临时目录 | Node 压缩包与 `SHASUMS256.txt` 的缓存 |
| `--no-install` / `--no-runtime` / `--no-verify` / `--no-archive` | 全开 | 分别跳过依赖安装 / 内置运行时 / 原生冒烟验证 / tar.gz 归档 |

构建过程：下载目标平台的官方 Node 压缩包并用 `SHASUMS256.txt` 校验 → 用 `scripts/desktop-bundle-server.js` 的 `stageServer()` 落一份服务端（含 `--os/--cpu` 与 prebuild 目标 env）→ 复制 `scripts/portable-launcher.js` 与 `desktop/lib/*` → 写 `.app`/包装脚本/说明 → 原生冒烟 + 架构门（`scripts/native-arch.js`）→ 归档并写 `.sha256`。

产物结构（macOS）：

```
multicc-portable-<版本>-darwin-x64/
├── MultiCC.app/Contents/
│   ├── MacOS/MultiCC                     # 启动入口：exec 包内运行时跑 launcher
│   ├── Info.plist                        # LSMinimumSystemVersion = 11.0
│   └── Resources/
│       ├── app-server/                   # server.js + src/ + public/ + node_modules
│       ├── runtime/                      # 官方 Node 22（bin/node、bin/npm）
│       └── launcher/                     # portable-launcher.js + lib/（与 desktop/lib 同源）
├── 启动 MultiCC.command / 停止 MultiCC.command / 查看状态 MultiCC.command
└── 使用说明.txt
```

Linux / Windows 用同一棵 `Resources/` 树（无 `.app`），入口是 `start-multicc.sh` / `Start-MultiCC.cmd`。

跨架构构建（例如在 Apple Silicon 上打 `darwin-x64`）会在打包结束时尝试用目标运行时跑冒烟：宿主能执行目标二进制（macOS 有 Rosetta）时就是真实校验，执行不了（`ENOEXEC`/`EPERM`/`EACCES`）才跳过。跳过时仍有架构门（`scripts/native-arch.js`，读 Mach-O/ELF/PE 头，同时校验架构与二进制格式）。CI 的 `portable` 任务对每个平台的两个架构都构建，但只有与 runner 同架构的条目会跑冒烟，交叉架构条目用 `--no-verify` 跳过——想给交叉架构也加冒烟，把该条目放到对应架构的 runner 上即可。

## 与桌面版的取舍

| | 便携版 | 桌面版（Electron） |
|---|---|---|
| 老机器（macOS 11/12、Intel） | ✅ 支持 | ❌ 需要 macOS 13+ |
| 界面 | 系统浏览器 | 自带窗口 |
| 需要安装的东西 | 无（解压即用） | 安装包（dmg/exe/AppImage/deb） |
| 数据目录 | `MultiCCPortable` | `MultiCC` |
| 升级方式 | 替换 `.app` / `Resources` | 新安装包覆盖 |
| 包体 | ~290 MB 解压 / ~68 MB 压缩（含 127 MB Node 运行时） | dmg/exe/AppImage：Electron 运行时 + 同一份 app-server |

两者的后端、Web UI、端口策略、数据布局与优雅关闭协议完全一致——便携版就是包内 Node 直接跑同一个服务端，并把桌面版的进程监管逻辑（`desktop/lib`）原样复用，不带 Electron。
