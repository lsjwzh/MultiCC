# Desktop app (macOS / Windows / Linux)

> MultiCC 桌面包壳：安装后双击图标即可使用，不需要理解或手动执行 Node、CLI、服务端、端口、浏览器等启动细节。窗口复用现有 Web UI，后端由主进程托管在本机 loopback。

## 用户指南

### 安装

从 GitHub [Releases](https://github.com/lsjwzh/MultiCC/releases) 下载对应平台的安装包（每个安装包旁有同名 `.sha256` 校验文件，Release 里另有汇总的 `SHA256SUMS.txt`）：

| 平台 | 文件 | 说明 |
|------|------|------|
| macOS (Apple Silicon / Intel) | `multicc-desktop-<版本>-macos-arm64.dmg` / `-x64.dmg` | 拖入「应用程序」；首次打开若提示 Gatekeeper，右键→打开 |
| Windows | `multicc-desktop-<版本>-windows-x64.exe` | NSIS 安装器，按用户安装，无需管理员 |
| Linux | `multicc-desktop-<版本>-linux-x64.AppImage` / `.deb` | AppImage 加执行权限后直接运行；deb 用系统包管理器安装 |

> 老机器装不了这里列出的包时（Electron 44 需要 **macOS 13+**，Homebrew 也不再给 Intel 供 bottle），
> 用 **[独立版](standalone.md)**：一行命令安装或解压即用，内置 Node 22 运行时与全部依赖，
> 支持 **macOS 11+**（含 Mac Pro 2013 这类 Intel 老机器），不用装任何东西。
> 桌面版就是这棵树外面加了一层 Electron 壳，跑的是同一份服务端、同一个运行时。

版本号与 MultiCC 服务端一致（如 `2.0.0`）。安装包**不包含**手机 APK——Android 客户端请从同一 Release 页获取 `multicc.apk`。

### 桌面版就是独立版加一层壳

桌面版不是另做一套打包：`scripts/desktop-stage-standalone.js` 调用独立包用的同一个
`stageResources()`，把 `app-server/`、`runtime/`（固定版本 Node 22）、`launcher/` 和
`bundle-manifest.json` 投放到 `desktop/.staging/resources`，再作为 Electron 的
`extraResources` 打进安装包。所以 `.dmg` / `.exe` / AppImage 与
`multicc-standalone-<版本>-<平台>-<架构>.tar.gz` 跑的是**同一份代码、同一个固定 Node**：
壳里的服务端进程执行的是 `Resources/runtime/bin/node`（Windows 是 `runtime\node.exe`），
不是 Electron 自带的 Node——唯一的例外是开发模式，那时直接用 Electron 的 Node 跑 checkout
里的源码。

这条约束让两边不会各自漂移：端口挑选、`/readyz` 就绪门控、崩溃退避、优雅排空协议
（`/api/desktop-shutdown`，Windows 上也走这条）与数据布局都只有一份实现
（`desktop/lib` 与包内 `launcher/lib` 同源，打包时复制过去）。资源缺失时主进程会直接显示
错误页（`missing-runtime`），不会起一个半死的后端；CI 在打完包后也会检查安装目录里确实带着
`app-server/server.js`、`launcher/standalone-cli.js`、`bundle-manifest.json` 与运行时，
避免做出一个「打开就是错误页」的安装包。

### 首次启动会发生什么

1. 窗口先显示启动页（「正在启动本地服务…」）。
2. 主进程在本机 `127.0.0.1` 上选一个可用端口，把 MultiCC 服务端作为子进程拉起，并等待其 `/readyz` 变为就绪。
3. 就绪后窗口自动加载 Web UI。整个过程通常几秒钟。

首启动会在用户数据目录完成初始化（见下表），无需任何命令行操作。

### 常见启动失败与处理

启动页会切换为错误页，给出可读原因与操作按钮（重试启动 / 打开日志 / 打开数据目录 / 退出）：

| 原因 | 含义 | 处理 |
|------|------|------|
| 端口被占用 | 选定的本地端口被其它程序抢占 | 通常是残留实例；点「重试启动」会自动换端口 |
| 崩溃循环 | 服务端短时间内反复退出 | 点「打开日志」查看 `server-*.log` |
| 未能就绪 | 服务端启动超时（>2 分钟） | 点「重试启动」；持续失败请把日志目录打包反馈 |
| 启动器错误 | 无法创建子进程（安装损坏、依赖缺失） | 重新安装；确认杀毒软件未拦截 |

macOS 上另有一类失败不在这张表里，因为它不是「启动失败」而是「加了目录之后 git 报 Operation not permitted」：受保护位置（桌面/文档/下载/iCloud/外接磁盘）需要按进程授权，而桌面版的授权对象是 `MultiCC.app`（开机自启时是包内 `runtime/bin/node`）。原因、授权对象与替代方案见 [macOS 磁盘权限](standalone.md#macos-磁盘权限tcc为什么给权限常常给不上)——桌面版与独立版共用同一棵 `Resources/` 树，这个问题也一样。

### 数据、配置与日志的位置

桌面版把所有可写状态收进各平台的标准用户数据目录（Electron `userData`）：

| 内容 | 位置（相对 userData） | 说明 |
|------|----------------------|------|
| 服务端全部状态 | `data/` | 会话、providers、聊天历史、SQLite 等（即 `MULTICC_DATA_DIR`） |
| 记忆库 | `data/memories/` | 即 `MULTICC_MEMORY_ROOT` |
| 环境变量文件 | `multicc.env` | 即 `MULTICC_ENV_FILE`，与 CLI 版 `.env` 同格式 |
| 运行日志 | `logs/server-<时间>.log` | 每次后端启动一个文件 |
| 运行时信息 | `desktop-runtime.json` | 供孤儿进程回收用，正常退出即消失 |

userData 的物理路径：macOS `~/Library/Application Support/MultiCC`；Windows `%APPDATA%\MultiCC`；Linux `~/.config/MultiCC`。错误页的「打开数据目录」按钮会直接打开它。

### 桌面版与 CLI 版的差异

- **更新**：桌面版内点「检查更新」会提示 `DESKTOP_UPDATE_UNSUPPORTED`——请下载新的桌面安装包覆盖安装（数据保留在 userData，不受影响）。
- **重启**：桌面版的「重启」不再拉起外部管理脚本，而是优雅退出、由主进程自动重新拉起服务端（同一数据目录与端口），进行中的输出会先落盘。
- **网络**：桌面版后端永远只绑定 `127.0.0.1`；局域网/远程访问请继续使用 CLI 安装方式。
- 与 CLI 版可并存，但两者数据目录不同，互不共享会话。

## 安全模型

- 后端仅绑定 loopback（`HOST=127.0.0.1` 由桌面主进程强制，`.env` 无法改写）；访问令牌不进 URL、不进日志。
- 窗口开启 `contextIsolation`、禁用 Node 集成、启用沙箱；导航只允许本应用页面与本地服务端 origin，其余链接交给系统浏览器；所有权限请求默认拒绝；无任何远程内容执行。
- 单实例锁：第二个实例只会聚焦已有窗口。异常退出后的残留服务端会在下次启动时被自动回收（先 HTTP 优雅排空，再进程树清理），保证一个数据目录只有一个服务端。

## 开发者指南

### 目录结构

```
desktop/
  main.js              主进程：单实例、supervisor 编排、安全窗口、错误页
  preload.js           contextBridge（retry/openLogs/openDataFolder/quit）
  lib/                 纯 Node 模块（不依赖 electron，可直接单测）
    port-chooser.js    端口探测/顺序找空闲端口
    health-probe.js    /readyz 轮询
    desktop-env.js     目录布局 + 子进程环境组装
    backend-supervisor.js  子进程生命周期：就绪门控/崩溃退避/优雅排空/树清理
    orphan-reclaim.js  孤儿服务端回收
    release-artifacts.js   产物命名校验 + sha256 sidecar/清单
  assets/              splash.html / error.html（打包进 asar）
  build/icon.png       应用图标（≥512）
脚本目录（桌面壳与独立包共用）：

```
scripts/
  desktop-stage-standalone.js  调用独立包的 stageResources()，投放 desktop/.staging/resources
  desktop-bundle-server.js     其中 stageServer()：把 server.js/src/public/plugins 打成 app-server
  standalone-bundle.js         独立包构建：同一棵 Resources 树 + .app/包装脚本 + 归档
  standalone-cli.js            包根 `multicc` 命令的实现
  standalone-launcher.js       包内监管进程（桌面版不用它，用 desktop/main.js）
  desktop-release-assets.js    CI 里生成 .sha256 / SHA256SUMS / 签名状态文件
.github/workflows/desktop-release.yml   三平台构建 + 上传到同一 Release
```

### 本地开发与调试

```bash
npm run desktop:dev     # 安装 desktop 依赖并以开发模式启动（数据在 .desktop-dev-data/）
npm run desktop:stage   # 只做服务端 staging（不安装依赖），快速检查打包清单
npm run test:desktop    # 桌面壳全部单元/静态测试（node:test）
```

开发模式数据全部落在 checkout 下的 `.desktop-dev-data/`（或 `$MULTICC_DESKTOP_DATA`），不碰 CLI 安装的状态。调试主进程：`desktop/` 下 `npx electron . --remote-debugging-port=9222`，或直接读 `.desktop-dev-data/logs/`。

服务端配合点（需重启 MultiCC 服务才生效的新路由/环境变量）：`MULTICC_DESKTOP=1` 时的 `/api/restart`（supervisor 托管语义）、`/api/desktop-shutdown`（优雅排空退出）、`MULTICC_ENV_FILE`（`.env` 位置可重定向）、`/api/update` 的桌面 409 门。

### CI 与发布

推 `v*.*.*` tag 后 `desktop-release.yml` 在 macOS/Windows/Ubuntu 原生 runner 上各构建本平台产物，全部上传到**同一个** GitHub Release（该 Release 由既有的 android `release.yml` 创建；desktop 侧只等待并 `gh release upload`，不自行创建）。也支持 `workflow_dispatch` 手动触发做未发布验证（产物留为 workflow artifact，不上传 Release）。每个 Release 固定包含：三个平台的 5 个安装包 + 各自 `.sha256` + `SHA256SUMS.txt` + 每平台 `SIGNING-STATUS-<platform>.txt`，以及各平台两个架构的 `multicc-standalone-<版本>-<平台>-<架构>.tar.gz`（Windows 为 `.zip`）——同一套 staging 代码，一次构建两种形态。

### 签名密钥配置

| Secret | 作用 | 缺失时行为 |
|--------|------|-----------|
| `MAC_CSC_LINK` | macOS 开发者证书（base64 .p12） | 构建**显式 unsigned**（`identity=null`），并输出 `::warning::` |
| `MAC_CSC_KEY_PASSWORD` | 上述 p12 的密码 | 同上 |
| `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | 公证（notarize）三件套，需与证书同时配置 | 不公证 |

三件齐备时 CI 自动切到 `Developer ID Application` 签名并公证。签名状态永远如实写进 `SIGNING-STATUS-<platform>.txt`（`signed+notarized` / `signed` / `unsigned`），不伪装已签名；产物与日志中不落任何密钥内容。Windows/Linux 目前均为 unsigned，状态文件同样明示。

> 包内嵌套的 `Resources/runtime/bin/node` 是一个独立的可执行文件，也在签名范围内：公证会拒绝任何未签名或签名不完整的嵌套二进制。首次配置 `MAC_*` 出包时请用
> `codesign -dv --verbose=4 <app>/Contents/Resources/runtime/bin/node` 核对它确实被签上（electron-builder 的签名步骤会遍历整个 bundle，但这条依赖值得实测一次）。
