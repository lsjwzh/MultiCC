# 插件列表（在线目录）设计

状态：方案稿（2026-10-28），待确认第八节的三个问题后实施。

## 一、要解决什么

现在插件只有一种来源：程序目录下的 `plugins/<id>/`，复制进去就算装上（`src/routes/plugins.js` 扫这个目录）。这带来三个问题：

1. **用户不知道有哪些插件**。没有地方列出“还能装什么”。
2. **不知道装上能不能用**。插件可能需要某个系统版本、某个 MultiCC 版本、某个 Agent 构建号、某个外部 App（如微信 4.x）或某些系统权限，现在都没有地方声明，装了才发现不能用。
3. **装在程序目录里会丢**。桌面版的程序目录在 `MultiCC.app` 里，是只读的；独立包升级会整包替换程序目录。只有源码运行能这样装。

## 二、整体做法

- GitHub 上放一份**插件列表** `index.json`：列出所有插件（内置的和需要后置安装的），每个版本写清兼容要求和下载包。
- MultiCC 定期拉取这份列表，和本机已装的插件合并，算出每个插件在这台机器上的状态，插件面板按状态分组展示。
- 后置安装的插件装到用户目录 `~/.multicc/plugins/<id>/`，不再装进程序目录；程序目录的 `plugins/` 只放内置插件。
- 插件包必须带 sha256；列表本身带签名，公钥固定在 MultiCC 源码里（插件是本机可执行文件，在国内访问 GitHub 时经常要走镜像，镜像内容不能直接信任）。

## 三、列表格式（`index.json`，schema 1）

```json
{
  "schema": 1,
  "updatedAt": "2026-10-28T08:00:00Z",
  "plugins": [
    {
      "id": "chrome-proxy-launcher",
      "name": "Chrome 隔离出口启动器",
      "nameEn": "Chrome Isolated Proxy Launcher",
      "icon": "🌐",
      "category": "browser",
      "distribution": "builtin",
      "builtinSince": "2.6.0",
      "summary": "每个身份一份隔离的 Chrome profile，各自绑定出口。",
      "summaryEn": "One isolated Chrome profile per identity, each pinned to its own egress.",
      "homepage": "https://github.com/lsjwzh/MultiCC/tree/main/plugins/chrome-proxy-launcher"
    },
    {
      "id": "wechat-desktop-notify",
      "name": "微信桌面提醒",
      "nameEn": "WeChat Desktop Notify",
      "icon": "💬",
      "category": "channel",
      "distribution": "optional",
      "provides": ["channel"],
      "summary": "操作 Mac 上的微信桌面版，把 MultiCC 的提醒发给指定联系人。",
      "summaryEn": "Sends MultiCC alerts to chosen contacts through WeChat for Mac.",
      "homepage": "https://github.com/lsjwzh/multicc-wechat-notify",
      "latest": "0.1.0",
      "releases": [
        {
          "version": "0.1.0",
          "publishedAt": "2026-11-05T00:00:00Z",
          "requires": {
            "multicc": ">=2.13.0",
            "pluginApi": 2,
            "agentBuild": ">=2",
            "platforms": [
              { "os": "darwin", "arch": ["arm64", "x64"], "minOS": "13.0" }
            ],
            "apps": [
              { "id": "com.tencent.xinWeChat", "name": "微信", "nameEn": "WeChat", "minVersion": "4.0.0", "testedVersion": "4.1.15" }
            ],
            "permissions": ["accessibility", "screenRecording"]
          },
          "assets": {
            "darwin-arm64": { "url": "https://github.com/lsjwzh/multicc-wechat-notify/releases/download/v0.1.0/wechat-desktop-notify-0.1.0-darwin-arm64.zip", "sha256": "…", "size": 1234567 },
            "darwin-x64": { "url": "…", "sha256": "…", "size": 1234567 }
          },
          "notes": "首个版本。",
          "notesEn": "First release."
        }
      ]
    }
  ]
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `distribution` | `builtin` 表示随 MultiCC 发布，在程序目录里，不能单独卸载或升级，`builtinSince` 写从哪个 MultiCC 版本开始内置；`optional` 表示后置安装，必须有 `releases` |
| `category` / `provides` | 用于分组和按需展示，例如 `channel`（可作提醒渠道）、`browser`、`ui`。推送设置里的“插件渠道”栏只列 `provides` 含 `channel` 的插件 |
| `requires.multicc` | MultiCC 版本范围（semver 范围，只支持 `>=`、`<`、`^` 三种写法，够用且好实现） |
| `requires.pluginApi` | 插件接口版本。MultiCC 在 `/api/plugins` 报出自己支持的版本；常驻、`channel` 声明等新能力落地时加 1 |
| `requires.agentBuild` | 需要的 MultiCC Agent 构建号（`scripts/macos-agent/agent-build.json`）。例如微信插件需要新增的 `lease` 指令 |
| `requires.platforms` | 支持的系统、架构和**最低系统版本** `minOS`；不在列表里的系统一律算“不支持” |
| `requires.apps` | 依赖的外部 App：bundle id、最低版本、实测过的版本。只做检测和提示，不帮用户安装 |
| `requires.permissions` | 需要的系统权限，展示用，并提示由 Agent 持有 |
| `assets` | 按 `<os>-<arch>` 给下载包，必须带 `sha256` 和 `size`；URL 只接受 `https://github.com/` 和 `https://objects.githubusercontent.com/` 开头 |

插件自己的 `plugin.json` 也加同样的 `requires` 和 `distribution` 字段。这样手动复制进来、或者离线安装的插件，也能做同样的兼容检查。

## 四、本机状态（MultiCC 计算）

每个插件算出一个状态，插件面板按它分组：

| 状态 | 条件 | 面板上 |
| --- | --- | --- |
| 内置 | `distribution: builtin`，且程序目录里有 | “内置”标签，只能打开、不能卸载 |
| 已安装 | 用户目录里有，版本是最新 | 打开 / 卸载 |
| 可更新 | 已安装，列表里有更高版本，且本机满足那个版本的要求 | “更新到 x.y.z” |
| 可安装 | 没装，有满足本机要求的版本 | “安装” |
| 不支持本机 | 没有一个版本满足要求 | 灰显，写出具体原因：“需要 macOS 13 或更高（本机 12.7）”、“需要 MultiCC 2.13 或更高”、“需要先装微信 4.0 或更高”、“只支持 macOS” |
| 已安装但不兼容 | 装着的版本不再满足要求（例如 MultiCC 降级了） | 黄色提示，插件照常列出但不启用常驻和渠道 |

判断顺序：系统与架构 → 最低系统版本 → MultiCC 版本 → 插件接口版本 → Agent 构建号 → 外部 App。给出第一条不满足的原因即可，免得一屏全是红字。

“按需展示”：
- 默认只显示内置、已安装、可安装、可更新；“不支持本机”收在底部的“查看不支持的插件（N）”里。
- 支持按 `category` 筛选。推送设置、钩子这些地方只按 `provides` 列出相关插件，例如 `channel`。

## 五、拉取与缓存

- 地址：默认 `https://raw.githubusercontent.com/lsjwzh/multicc-plugins/main/index.json`（待定，见第八节），失败时依次试 `https://cdn.jsdelivr.net/gh/lsjwzh/multicc-plugins@main/index.json` 和用户在设置里填的地址。
- 签名：同目录下的 `index.json.sig`（ed25519）。验签用的公钥写在 MultiCC 源码里，验签不过就当拉取失败。镜像能加快下载，但改不了内容。
- 缓存：结果和 ETag 写到 `~/.multicc/plugins-catalog/index.json`。启动 15 秒后拉一次，之后每 24 小时一次；定时器不阻止进程退出，失败只记一条警告（和 CLI 更新角标的做法一样）。面板上可以手动刷新。
- 离线：用缓存的那份；没有缓存时，只按本机已装的插件和程序目录里的内置插件展示，“可安装”一栏写“列表暂时拉不到”。
- 发版：每个 MultiCC 发布包里附一份当时的 `index.json` 快照，作为首次启动、拉取失败时的兜底。

## 六、安装、更新、卸载

- **安装 / 更新**：按 `<os>-<arch>` 下载对应的包到 `~/.multicc/plugins/.staging/`，校验 size 和 sha256，解压，检查 `plugin.json` 的 `id` 和 `version` 与列表一致、可执行文件有执行权限。确认无误后整体换入 `~/.multicc/plugins/<id>/`，旧版本留在 `~/.multicc/plugins/.previous/<id>/`，可以一键退回。
- **常驻插件**：先停旧进程，再换文件，最后起新进程；新进程体检不过就自动退回旧版。
- **卸载**：只删程序文件，`~/.multicc/plugins-data/<id>/` 里的配置和记录保留，并在卸载确认框里写清楚这一点。
- **权限**：安装、更新、卸载只接受本机请求（和 Agent 权限按钮一样）；从手机或远程打开的页面只能查看，按钮上写“请在这台电脑上操作”。
- **来源**：`src/routes/plugins.js` 改为扫两个目录，程序目录的 `plugins/`（内置）和 `~/.multicc/plugins/`（后置安装）。同一 id 两边都有时以内置为准，并在面板上报冲突。

## 七、要改的地方

| 位置 | 改动 |
| --- | --- |
| 新仓库 `lsjwzh/multicc-plugins`（待定） | `index.json` + `index.json.sig`；CI 检查格式、URL 前缀、sha256 能对上 Release 里的文件 |
| `src/plugins/catalog.js`（新） | 拉取、验签、缓存、版本范围比较、本机状态计算（系统版本、架构、MultiCC 版本、Agent 构建号、外部 App 版本） |
| `src/plugins/installer.js`（新） | 下载、校验、解压、换入、退回、卸载 |
| `src/routes/plugins.js` | 扫两个目录；`GET /api/plugins` 带上 `pluginApi`；新增 `GET /api/plugins/catalog`、`POST /api/plugins/:id/install`、`POST /api/plugins/:id/uninstall`、`POST /api/plugins/:id/rollback` |
| `plugins/README.md` | `plugin.json` 加 `requires`、`distribution`，安装位置改为 `~/.multicc/plugins/` |
| Air「资料与插件 → 插件」面板 | 分组展示、状态标签、要求说明、安装 / 更新 / 卸载 / 退回按钮、刷新列表 |
| 运行时写入登记 | `~/.multicc/plugins/`、`~/.multicc/plugins-catalog/` 两个新写入目录登记到 `scripts/check-runtime-write-inventory.js` |
| 测试 | 版本范围、兼容判断的每个分支、验签失败、sha256 不符、解压后 id 不符、换入失败退回、离线兜底 |

实施分三步，每步可以单独上线：
1. 列表格式、`plugin.json` 的 `requires`、本机状态计算、面板只读展示（没有安装按钮）；
2. 安装、更新、卸载、退回，用户目录；
3. 每日检查和“可更新”角标，并在推送设置、钩子里按 `provides` 列出插件。

## 八、待你确认

1. **列表放在哪**：
   - A：新建独立仓库 `lsjwzh/multicc-plugins`。推荐，列表可以随时更新，不用跟着 MultiCC 发版；
   - B：放在 MultiCC 主仓的 `plugins/catalog.json`，从 main 分支的 raw 地址拉取。
2. **后置安装的插件装到哪**：推荐改为 `~/.multicc/plugins/<id>/`（理由见第一节第 3 点）。这会改掉之前“装进 MultiCC 的 `plugins/` 目录”的决定（见 `docs/notification-channel-plugin-design.md` 15.2）。
3. **列表从第一版就签名吗**：推荐要。代价是发布列表时要多签一次名，签名私钥由你保管。
